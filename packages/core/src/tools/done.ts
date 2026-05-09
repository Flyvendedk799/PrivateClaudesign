/**
 * done — self-check tool the agent calls when it believes the artifact is
 * complete. Two layers:
 *   1. Static lint over `index.html` (unclosed tags, duplicate IDs, missing
 *      alt). Cheap and host-free; runs in every environment.
 *   2. Optional runtime verifier injected by the host. The desktop app passes
 *      a callback that loads the artifact in a hidden Electron BrowserWindow,
 *      captures `console-message` + `did-fail-load` for ~3s, and returns the
 *      collected errors. Without this callback (e.g. in vitest), step 2 is
 *      skipped and only static issues are reported.
 *
 * Result: `{ status: 'ok' | 'has_errors', errors: [...] }`. The agent
 * self-heals via `str_replace_based_edit_tool` and calls `done` again.
 *
 * Terminal-call discipline (added 2026-04-26): production traces showed the
 * agent calling `done` 3-4 times after a single `ok` response, wasting ~10s
 * per redundant call. The result text now ends with an explicit STOP marker
 * the first time `ok` is reported, and any further `done` call after that
 * throws — which pi-agent-core surfaces as a tool error with the thrown
 * message — telling the agent the run is already accepted and to emit a
 * plain-text summary. State is closure-scoped per `makeDoneTool()` so each
 * agent run gets its own counter.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { checkDestructiveEdit } from '../destructive-edit.js';
import { VerifyResultCache, hashContent } from '../incremental-verify.js';
import { type CoreLogger, NOOP_LOGGER } from '../logger.js';
import { planPlaytest } from '../playtest-planner.js';
import { diffThemeTokens } from '../theme-token-diff.js';
import { HEURISTIC_ADVISORY_SOURCES, runHeuristics } from './done-heuristics.js';
import type { EditBudget } from './edit-budget.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

/** may9 Phase 8b follow-up #28 — host-supplied callback returning the
 *  parent snapshot's `length(artifact_source)` (or null when no parent
 *  exists, i.e. initial run). The `done` tool consumes this to
 *  detect destructive edits per checkDestructiveEdit. Optional —
 *  vitest paths and design-mode runs that don't care about the
 *  destructive-edit advisory pass undefined. */
export type GetParentArtifactBytesFn = () => Promise<number | null> | number | null;

/** may9 Phase 9b follow-up #24 — host-supplied counter callbacks for
 *  the mandatory pre-done validation gate. Each returns the current
 *  per-session invocation count for the named tool. The done tool
 *  rejects (with a recoverable error in the result text, not a throw)
 *  when game mode is active and either count is 0 — the FPS Wave
 *  Defense run shipped with 1 validate_game_scene + 1 playtest_game
 *  call across 28 snapshots; the gate ensures both are exercised at
 *  least once per session.
 *
 *  Optional — vitest paths and design / motion runs leave undefined.
 */
export type GetToolCallCountFn = () => number;

const DoneParams = Type.Object({
  summary: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
});

export interface DoneError {
  message: string;
  source?: string;
  lineno?: number;
}

export interface DoneDetails {
  status: 'ok' | 'has_errors';
  path: string;
  errors: DoneError[];
  summary?: string;
}

/** Host-injected runtime verifier. Receives the raw artifact source (the
 *  agent's JSX module, NOT a fully-built srcdoc) and returns any console /
 *  load errors observed when the host actually executed it. */
export type DoneRuntimeVerifier = (artifactSource: string) => Promise<DoneError[]>;

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function findUnclosedTags(html: string): DoneError[] {
  const issues: DoneError[] = [];
  const stack: Array<{ tag: string; lineno: number }> = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/)?>/g;
  let match = tagRe.exec(html);
  while (match !== null) {
    const name = (match[1] ?? '').toLowerCase();
    const isClose = match[0].startsWith('</');
    const selfClosing = match[2] === '/' || VOID_ELEMENTS.has(name);
    if (selfClosing) {
      match = tagRe.exec(html);
      continue;
    }
    const lineno = html.slice(0, match.index).split('\n').length;
    if (isClose) {
      const top = stack[stack.length - 1];
      if (top && top.tag === name) stack.pop();
      else
        issues.push({
          message: `Closing </${name}> without matching open`,
          lineno,
          source: 'html',
        });
    } else {
      stack.push({ tag: name, lineno });
    }
    match = tagRe.exec(html);
  }
  for (const { tag, lineno } of stack) {
    issues.push({ message: `Unclosed <${tag}>`, lineno, source: 'html' });
  }
  return issues;
}

function findDuplicateIds(html: string): DoneError[] {
  const seen = new Map<string, number>();
  const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
  let m = idRe.exec(html);
  while (m !== null) {
    const id = m[1] ?? '';
    seen.set(id, (seen.get(id) ?? 0) + 1);
    m = idRe.exec(html);
  }
  const dupes: DoneError[] = [];
  for (const [id, count] of seen) {
    if (count > 1)
      dupes.push({ message: `Duplicate id="${id}" (${count} occurrences)`, source: 'html' });
  }
  return dupes;
}

function findMissingAlt(html: string): DoneError[] {
  const issues: DoneError[] = [];
  const imgRe = /<img\b[^>]*>/gi;
  let m = imgRe.exec(html);
  while (m !== null) {
    if (!/\balt\s*=/i.test(m[0])) {
      const lineno = html.slice(0, m.index).split('\n').length;
      issues.push({ message: '<img> without alt attribute', lineno, source: 'html' });
    }
    m = imgRe.exec(html);
  }
  return issues;
}

/**
 * Detect a JSX-via-Babel-standalone artifact. Generated artifacts run as
 * `<script type="text/babel">` which means JSX self-closing component tags
 * (`<Header />`) and `style={{ … }}` look invalid to an HTML validator —
 * but they're the runtime, not user error. Used to gate the HTML-only
 * checks below so the agent doesn't ping-pong "fix" loops on its own
 * runtime semantics. See backlog-1 #10.
 */
export function isReactBabelArtifact(src: string): boolean {
  return (
    /<script[^>]*type=["']text\/babel["']/.test(src) ||
    /ReactDOM\.createRoot\s*\(/.test(src) ||
    /\/\*\s*EDITMODE-BEGIN\s*\*\//.test(src) ||
    /(?:^|\n)\s*function\s+App\s*\(/.test(src) ||
    /(?:^|\n)\s*const\s+App\s*=/.test(src)
  );
}

/**
 * Cheap structural JSX sanity check — catches the 90% of agent mistakes that
 * break Babel compile before the 3-second runtime BrowserWindow load even
 * has a chance. These are SYNCHRONOUS and deterministic so they surface in
 * every `done` call, not just when the error happens on first paint.
 *
 * Only fires for JSX-shaped artifacts. Pure HTML (legacy pastes, tests) is
 * skipped — those have their own checks via findUnclosedTags etc.
 */
function findJsxStructuralIssues(src: string): DoneError[] {
  if (!isReactBabelArtifact(src)) return [];

  const issues: DoneError[] = [];

  // Markdown code fences that sometimes leak when the agent slips into prose
  // mode and wraps JSX in ```jsx ... ```.
  const fenceMatch = src.match(/^```/m);
  if (fenceMatch) {
    const lineno = src.slice(0, fenceMatch.index ?? 0).split('\n').length;
    issues.push({
      message: 'Leftover markdown code fence (```) inside JSX — remove it.',
      lineno,
      source: 'syntax',
    });
  }

  // Required JSX anchors — without them the runtime can't mount.
  if (!/ReactDOM\.createRoot\s*\(/.test(src)) {
    issues.push({
      message: 'Missing ReactDOM.createRoot(...) call — the artifact will not mount.',
      source: 'syntax',
    });
  }
  if (!/(?:function\s+App\s*\(|const\s+App\s*=|let\s+App\s*=)/.test(src)) {
    issues.push({
      message: 'Missing `function App()` or `const App = ...` declaration.',
      source: 'syntax',
    });
  }

  // Bracket balance + "no content after render" — both removed 2026-04-28.
  // The bracket counter ran against the full HTML+JSX source; JSX tags and
  // text content (parens/braces in prose between tags) routinely confused
  // it into off-by-one false positives. The "unexpected content after
  // render" check ran on the whole file too — it tripped on the normal
  // `</script></body></html>` HTML tail. Both produced "Unbalanced
  // parentheses" / "Unexpected content" errors that triggered the agent
  // into 5+ redundant str_replace iterations on perfectly valid artifacts
  // (see 2026-04-28 trace moix9ivu, 25-min run with 4 done() retries).
  // Babel-standalone IS the parser at runtime; if there's a real syntax
  // problem the BrowserWindow surfaces it via console.error and the
  // runtime verifier catches it. Heuristic bracket counting on JSX
  // without a real parser is unreliable; defer to Babel.

  return issues;
}

/** Console warnings (deprecated APIs, React DevTools chatter, third-party
 *  library noise) are surfaced for the model's awareness but do NOT make
 *  status='has_errors' — treating them as fatal triggered endless
 *  done-fix loops in production traces (2026-04-26 mofjqzl6 run hit 8
 *  consecutive has_errors cycles before the 1200s GENERATION_TIMEOUT
 *  fired). Real load failures and console.error are still fatal.
 *  HEURISTIC_ADVISORY_SOURCES (content/interactivity/a11y/responsive) are
 *  added on top via union so heuristic warnings never trip the fix loop. */
const ADVISORY_SOURCES = new Set<string>([
  'console.warning',
  // Runtime probes (responsive overflow / clip / dark-mode contrast) emitted
  // by the host's hidden-BrowserWindow verifier. Surface to the model but
  // never trip the fix loop — these are guidance, not blockers.
  'responsive.overflow',
  'responsive.clip',
  'responsive.probe_failed',
  'darkmode.contrast',
  // Phase 6 backport — silent theme-token swap + interactivity playtest
  // surface as advisory rows the model can acknowledge. They never
  // block done() — a deliberate palette change is fine, and the
  // playtest-advisory is a heads-up that a Playwright micro-session
  // would catch interaction failures (the host runs it lazily).
  'theme-advisory',
  'playtest-advisory',
  ...HEURISTIC_ADVISORY_SOURCES,
]);

/** After this many has_errors rounds in a single run, the next done call
 *  force-accepts with a "best-effort" note. Releases the run instead of
 *  burning 30+ minutes on errors the model can't fix; the unresolved
 *  errors are listed so the model can mention them in its summary. */
const MAX_HAS_ERRORS_ROUNDS = 3;

/** Hard cap on TOTAL done invocations per run, regardless of acceptance.
 *  The 2026-04-27 glass-webshop trace showed `done` called 8× even though
 *  the per-call throw clearly told the model the run was final after the
 *  4th call (4 actual checks + 4 throws the model ignored). This ceiling
 *  escalates the throw message so a runaway pattern is unmistakable. */
const MAX_TOTAL_DONE_CALLS = 6;

/**
 * Run the static + optional runtime checks on a single file and return
 * structured errors. Pure — no state, no logging, idempotent. Shared
 * between the terminal `done` tool (which adds acceptance / force-accept
 * gating) and the cheaper `verify_artifact` tool (which just returns the
 * checks for in-flight self-correction). Extracted 2026-04-28 — see
 * Group C1.
 */
/** Optional previous-snapshot anchor for advisory checks that compare
 *  against history (e.g. theme-token drift). The verify tool tracks the
 *  last-verified content per-run and passes it on subsequent calls so
 *  silent palette / radius / shadow swaps surface as a row the agent
 *  can choose to acknowledge or fix. Pure — no side effects. */
export interface RunArtifactChecksOptions {
  artifactType?: 'design' | 'game' | 'motion' | undefined;
  /** Content from the last successful verify of the same path, or
   *  null on the first verify of a run. */
  previousContent?: string | null;
}

export async function runArtifactChecks(
  fs: TextEditorFsCallbacks,
  runtimeVerify: DoneRuntimeVerifier | undefined,
  path: string,
  artifactTypeOrOptions?: 'design' | 'game' | 'motion' | RunArtifactChecksOptions,
): Promise<{ found: boolean; content?: string; errors: DoneError[] }> {
  const opts: RunArtifactChecksOptions =
    typeof artifactTypeOrOptions === 'string'
      ? { artifactType: artifactTypeOrOptions }
      : (artifactTypeOrOptions ?? {});
  const artifactType = opts.artifactType;
  const previousContent = opts.previousContent ?? null;
  const file = fs.view(path);
  if (file === null) {
    return {
      found: false,
      errors: [{ message: `File not found: ${path}`, source: 'fs' }],
    };
  }
  const knownFiles = new Set<string>();
  try {
    for (const f of fs.listDir('.')) {
      if (f !== path) knownFiles.add(f);
    }
  } catch {
    /* single-file pattern, no siblings */
  }
  const isJsxArtifact = isReactBabelArtifact(file.content);
  const errors: DoneError[] = [
    ...findJsxStructuralIssues(file.content),
    ...(isJsxArtifact ? [] : findUnclosedTags(file.content)),
    ...findDuplicateIds(file.content),
    ...(isJsxArtifact ? [] : findMissingAlt(file.content)),
    ...runHeuristics(file.content, knownFiles, artifactType === undefined ? {} : { artifactType }),
  ];
  // Phase 6 backport — silent theme-token swap detection. Only runs in
  // design mode (game / motion artifacts have their own theme stories);
  // only fires when a previous snapshot is supplied so the very first
  // verify of a run is silent.
  if (
    artifactType !== 'game' &&
    artifactType !== 'motion' &&
    typeof previousContent === 'string' &&
    previousContent.length > 0
  ) {
    const tokenChanges = diffThemeTokens(previousContent, file.content);
    for (const change of tokenChanges) {
      const before = change.before.length === 0 ? '<added>' : change.before;
      const after = change.after.length === 0 ? '<removed>' : change.after;
      errors.push({
        message: `Theme token --${change.name} changed ${before} → ${after} (intentional?)`,
        source: 'theme-advisory',
      });
    }
  }
  // Phase 6 backport — interaction-playtest advisory. Plans are emitted
  // as a single advisory row carrying the step count; the runtime
  // executes the plan via Playwright when the host opts in (lazy-loaded
  // per the §5 hard constraint). Skipped for game artifacts.
  if (artifactType !== 'game' && artifactType !== 'motion') {
    const playtestPlan = planPlaytest(file.content);
    if (playtestPlan.shouldPlaytest) {
      const summary = playtestPlan.steps
        .slice(0, 3)
        .map((s) => s.action)
        .join(' / ');
      errors.push({
        message: `Interactivity detected — playtest plan: ${playtestPlan.steps.length} steps (${summary})`,
        source: 'playtest-advisory',
      });
    }
  }
  if (runtimeVerify) {
    try {
      const runtimeErrors = await runtimeVerify(file.content);
      errors.push(...runtimeErrors);
    } catch (err) {
      errors.push({
        message: `Runtime verifier failed: ${err instanceof Error ? err.message : String(err)}`,
        source: 'runtime',
      });
    }
  }
  return { found: true, content: file.content, errors };
}

/**
 * verify_artifact — cheap, idempotent, in-flight check. Same lint +
 * runtime verifier as `done` but DOES NOT consume the acceptance counter
 * or end the run. Use this between sections so the agent can confirm
 * everything renders before calling `done` once at the end. Without it,
 * agents historically used `done` itself as the feedback loop, eating
 * ~2 s per call and incrementing the force-accept counter (see 2026-04-28
 * trace moj4w21j: 3 done calls, 35-turn fix loop after the first one).
 */
const VerifyParams = Type.Object({
  path: Type.Optional(Type.String()),
});

export interface VerifyDetails {
  status: 'ok' | 'has_errors';
  path: string;
  errors: DoneError[];
}

export function makeVerifyArtifactTool(
  fs: TextEditorFsCallbacks,
  runtimeVerify?: DoneRuntimeVerifier,
  editBudget?: EditBudget,
  artifactType?: 'design' | 'game' | 'motion',
): AgentTool<typeof VerifyParams, VerifyDetails> {
  // Phase 4 — content-hash memoization. Repeat verifies with no edit
  // hit the cache and skip the 200–800 ms re-parse. Per-instance state
  // (the tool is constructed once per `makeVerifyArtifactTool` call,
  // which is once per generateViaAgent run) so cross-run collisions
  // can't produce stale results.
  type CachedVerify = {
    summary: string;
    details: VerifyDetails;
  };
  const cache = new VerifyResultCache<CachedVerify>(32);
  // Phase 6 backport — anchor for theme-token drift detection. Set on
  // each successful verify (cache hit OR fresh parse) so subsequent
  // verifies diff against the prior verified state. Per-path so a
  // multi-file project doesn't cross-contaminate.
  const lastVerifiedContentByPath = new Map<string, string>();
  return {
    name: 'verify_artifact',
    label: 'Verify (no commit)',
    description:
      'Run the same lint + runtime checks as `done`, but DO NOT end the run. ' +
      'Use this freely between sections to confirm a partial artifact still ' +
      'renders without errors before doing the next edit. Idempotent and ' +
      'incrementally cached — a re-verify against unchanged file content ' +
      'returns instantly (Phase 4). Costs ~600 ms on a fresh hash vs ~0 ms ' +
      "on a cache hit, never increments the run's acceptance counter. " +
      'Returns { status, errors[] } same shape as `done`. Default path is ' +
      '"index.html". Call `done` ONCE at the very end of the run when you ' +
      'are sure the artifact is final.',
    parameters: VerifyParams,
    async execute(_id, params): Promise<AgentToolResult<VerifyDetails>> {
      const path = params.path ?? 'index.html';
      // Check the cache first — read the current file content via the
      // FS callback and key on its hash. If we already verified this
      // exact (path, content, artifactType) tuple, return the cached
      // result without re-parsing.
      const viewResult = fs.view(path);
      const fileNow = viewResult?.content ?? null;
      if (fileNow !== null) {
        const key = {
          path,
          contentHash: hashContent(fileNow),
          artifactType: artifactType ?? null,
        };
        const cached = cache.get(key);
        if (cached !== undefined) {
          return {
            content: [{ type: 'text', text: cached.summary }],
            details: cached.details,
          };
        }
      }
      const previousContent = lastVerifiedContentByPath.get(path) ?? null;
      const result = await runArtifactChecks(fs, runtimeVerify, path, {
        ...(artifactType !== undefined ? { artifactType } : {}),
        previousContent,
      });
      const fatal = result.errors.filter((e) => !ADVISORY_SOURCES.has(e.source ?? ''));
      const status: VerifyDetails['status'] = fatal.length === 0 ? 'ok' : 'has_errors';
      if (status === 'ok' && editBudget !== undefined) editBudget.reset();
      const summary =
        status === 'ok'
          ? result.found
            ? `verify ok — ${result.content?.length ?? 0} bytes, no fatal issues`
            : 'verify ok'
          : `has_errors\n${fatal
              .map((e) => `- ${e.message}${e.lineno ? ` (line ${e.lineno})` : ''}`)
              .slice(0, 8)
              .join('\n')}`;
      const details: VerifyDetails = { status, path, errors: result.errors };
      // Phase 6 backport — record this content as the anchor for the
      // next theme-drift diff. Done unconditionally on success so a
      // subsequent verify that adds a single token swap surfaces the
      // delta cleanly.
      if (typeof result.content === 'string') {
        lastVerifiedContentByPath.set(path, result.content);
      }
      // Cache only when we have the content we used. `result.content`
      // is the post-read snapshot from runArtifactChecks; key on that
      // exact bytes so an evicted+re-fetched read doesn't poison the
      // cache.
      if (typeof result.content === 'string') {
        cache.set(
          {
            path,
            contentHash: hashContent(result.content),
            artifactType: artifactType ?? null,
          },
          { summary, details },
        );
      }
      return {
        content: [{ type: 'text', text: summary }],
        details,
      };
    },
  };
}

export function makeDoneTool(
  fs: TextEditorFsCallbacks,
  runtimeVerify?: DoneRuntimeVerifier,
  logger: CoreLogger = NOOP_LOGGER,
  artifactType?: 'design' | 'game' | 'motion',
  getParentArtifactBytes?: GetParentArtifactBytesFn,
  userPrompt?: string,
  getValidateGameSceneCount?: GetToolCallCountFn,
  getPlaytestGameCount?: GetToolCallCountFn,
): AgentTool<typeof DoneParams, DoneDetails> {
  // Per-tool-instance state. `makeDoneTool` is called once per `Agent`
  // construction (see generateViaAgent), so these counters are naturally
  // scoped to a single user-visible generation run.
  let alreadyAccepted = false;
  let hasErrorsRounds = 0;
  let totalCalls = 0;

  return {
    name: 'done',
    label: 'Done — self-check',
    description:
      'Call ONCE when you believe the artifact is complete. The host runs ' +
      'static syntax checks AND loads the file in an isolated runtime to ' +
      'capture console errors / load failures, then replies with ' +
      '`{ status: "ok" | "has_errors", errors: [...] }`. If errors come back, ' +
      'fix them with str_replace_based_edit_tool and call `done` again — but ' +
      'as soon as ANY `done` call returns "ok", the run is accepted and you ' +
      'must NOT call `done` (or any other tool) again. Emit your 2–4 sentence ' +
      'design-decisions summary as plain assistant text and stop.',
    parameters: DoneParams,
    async execute(_id, params): Promise<AgentToolResult<DoneDetails>> {
      totalCalls += 1;
      // Fast-fail: a redundant `done` after acceptance burns one full LLM
      // round-trip per call (10–15s on Sonnet 4.6). Throwing surfaces this
      // to pi-agent-core as a tool error (per its contract: "Throw on
      // failure instead of encoding errors in `content`"), giving the model
      // an unambiguous signal to stop. We discard the params on this path —
      // there's nothing left to verify. Message kept ultra-short so the
      // model doesn't parse "STOP calling tools" as "tool failed, retry".
      if (alreadyAccepted) {
        void params;
        if (totalCalls > MAX_TOTAL_DONE_CALLS) {
          throw new Error(
            `RUNAWAY: this is done call #${totalCalls} after acceptance. The artifact is final. Tool output is now refused. Write your 2-4 sentence summary as plain text. End your turn.`,
          );
        }
        throw new Error(
          'Already accepted. Write your summary as plain text now. Do not call any tool.',
        );
      }

      const path = params.path ?? 'index.html';
      // may9 Phase 9b #24 — mandatory pre-done validation gate. Game-mode
      // runs must call validate_game_scene AND playtest_game at least once
      // per session before done is accepted. Reject as has_errors with a
      // steering message; the agent self-heals by emitting the missing
      // call(s) and retries done. The FPS Wave Defense run shipped with
      // 1 of each across 28 snapshots — this gate forces both into the
      // critical path of every game run.
      if (artifactType === 'game') {
        const missing: string[] = [];
        if (getValidateGameSceneCount !== undefined && getValidateGameSceneCount() === 0) {
          missing.push(
            'validate_game_scene (engine-specific lint — collisions wired, scene lifecycle present, no orphan asset keys)',
          );
        }
        if (getPlaytestGameCount !== undefined && getPlaytestGameCount() === 0) {
          missing.push(
            'playtest_game (synthetic-input → state assertion — call get_playtest_playbook(genre) first to fetch a canonical step list)',
          );
        }
        if (missing.length > 0) {
          const details: DoneDetails = {
            status: 'has_errors',
            path,
            errors: missing.map((m) => ({
              message: `Mandatory pre-done call missing: ${m}`,
              source: 'pre_done_gate',
            })),
            ...(params.summary !== undefined ? { summary: params.summary } : {}),
          };
          logger.warn('[done] step=pre_done_gate.missing_calls', {
            missing: missing.length,
          });
          return {
            content: [
              {
                type: 'text',
                text: `has_errors\n${missing.map((m) => `- pre_done_gate: call ${m} before done.`).join('\n')}\n\nThis is the may9 Phase 9b mandatory-validation gate (FPS Wave Defense logged 1 of each across 28 snapshots). Make these calls now and retry done.`,
              },
            ],
            details,
          };
        }
      }
      const file = fs.view(path);
      if (file === null) {
        const details: DoneDetails = {
          status: 'has_errors',
          path,
          errors: [{ message: `File not found: ${path}`, source: 'fs' }],
          ...(params.summary !== undefined ? { summary: params.summary } : {}),
        };
        return {
          content: [{ type: 'text', text: `has_errors\n- File not found: ${path}` }],
          details,
        };
      }
      // may9 Phase 8b — destructive-edit advisory. When the host wired
      // getParentArtifactBytes, compare current source size against the
      // parent snapshot's. A 40%+ shrink without remove/strip language
      // in the user prompt fires the advisory, which the agent gets in
      // the result text so it can re-justify before the next done call.
      // The first call (no parent) skips silently.
      let destructiveAdvisory: string | null = null;
      if (getParentArtifactBytes !== undefined && artifactType === 'game') {
        try {
          const priorBytes = await getParentArtifactBytes();
          const currentBytes = file.content.length;
          if (typeof priorBytes === 'number' && priorBytes > 0) {
            const advisory = checkDestructiveEdit({
              priorBytes,
              currentBytes,
              userPrompt: userPrompt ?? null,
            });
            if (advisory.triggered) {
              destructiveAdvisory = advisory.reason;
              logger.warn('[done] step=destructive_edit_warning', {
                priorBytes,
                currentBytes,
                shrinkRatio: advisory.shrinkRatio,
              });
            }
          }
        } catch {
          // Best-effort — if the host's lookup throws, skip the advisory.
        }
      }
      // Snapshot the design's other files so multi-file scanLocalRefs can
      // validate cross-file references. Best-effort: if listDir throws or
      // returns nothing, we just skip the multi-file checks.
      const knownFiles = new Set<string>();
      try {
        for (const f of fs.listDir('.')) {
          if (f !== path) knownFiles.add(f);
        }
      } catch {
        /* no-op — single-file pattern, no sibling files to validate. */
      }
      // text/babel JSX artifacts use component self-closing tags (<Card />)
      // and style={{ … }} attributes that look like malformed HTML to a
      // strict validator. Skip the HTML-only checks for them — the JSX
      // structural pass already covers what matters (compile-breaking
      // imbalances). findDuplicateIds is still valid in JSX so it stays.
      // See backlog-1 #10.
      const isJsxArtifact = isReactBabelArtifact(file.content);
      const errors: DoneError[] = [
        ...findJsxStructuralIssues(file.content),
        ...(isJsxArtifact ? [] : findUnclosedTags(file.content)),
        ...findDuplicateIds(file.content),
        ...(isJsxArtifact ? [] : findMissingAlt(file.content)),
        // Quality heuristics — content / a11y / responsive / multi-file.
        // Advisory ones show up but don't trip has_errors. Fatal ones
        // (WCAG A failures, missing local refs) DO trip has_errors so the
        // agent fixes them before `done` accepts.
        ...runHeuristics(
          file.content,
          knownFiles,
          artifactType === undefined ? {} : { artifactType },
        ),
      ];
      if (runtimeVerify) {
        try {
          const runtimeErrors = await runtimeVerify(file.content);
          errors.push(...runtimeErrors);
        } catch (err) {
          errors.push({
            message: `Runtime verifier failed: ${err instanceof Error ? err.message : String(err)}`,
            source: 'runtime',
          });
        }
      }
      // Split fatal vs advisory. Only fatal errors flip status to has_errors
      // and drive the fix loop; advisories ride along in the response so the
      // model can address them opportunistically without a forced re-run.
      const fatal = errors.filter((e) => !ADVISORY_SOURCES.has(e.source ?? ''));
      const advisory = errors.filter((e) => ADVISORY_SOURCES.has(e.source ?? ''));
      const naturalStatus: DoneDetails['status'] = fatal.length === 0 ? 'ok' : 'has_errors';

      // Force-accept after MAX_HAS_ERRORS_ROUNDS — releases the run instead
      // of burning the GENERATION_TIMEOUT on errors the model isn't fixing.
      const forceAccept =
        naturalStatus === 'has_errors' && hasErrorsRounds >= MAX_HAS_ERRORS_ROUNDS;
      const status: DoneDetails['status'] = forceAccept ? 'ok' : naturalStatus;

      // Force-accept telemetry — surfaces silent quality misses. Emitted
      // once when the threshold trips so downstream log scrapers can count
      // runs that bypassed the fix loop.
      if (forceAccept) {
        logger.warn('done.force_accept', {
          path,
          hasErrorsRounds,
          totalCalls,
          artifactBytes: file.content.length,
          fatalCount: fatal.length,
          // Cap the persisted snippet so we don't blow log lines on huge HTML.
          unresolvedSample: fatal.slice(0, 3).map((e) => ({
            source: e.source,
            message: e.message.slice(0, 200),
            ...(e.lineno ? { lineno: e.lineno } : {}),
          })),
        });
      }

      const details: DoneDetails = {
        status,
        path,
        errors,
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
      };
      let text: string;
      if (status === 'ok') {
        // Mark accepted FIRST so any racing duplicate fast-fails. The
        // terminal-stop copy is intentionally explicit — agent traces showed
        // a polite "ok — no issues detected" line being read as "tool
        // succeeded, ready for next call" rather than "we are finished".
        alreadyAccepted = true;
        if (forceAccept) {
          const unresolved = fatal
            .map((e) => `- ${e.message}${e.lineno ? ` (line ${e.lineno})` : ''}`)
            .join('\n');
          text = `ACCEPTED under best-effort policy after ${hasErrorsRounds} unfixed-error round(s). The artifact is final and the host has it. Do NOT call \`done\` (or any other tool) again. Mention these unresolved issues honestly in your 2–4 sentence summary, then end your turn:\n${unresolved}`;
        } else {
          const runtimeNote = runtimeVerify
            ? 'no syntactic or runtime issues detected'
            : 'no syntactic issues detected (runtime verification not configured in this host)';
          // Surface up to 3 advisory warnings inline so the model knows what
          // they are, not just that they exist. Kept on the OK path so the
          // run still terminates — these are guidance, not blockers.
          const advisoryBlock =
            advisory.length === 0
              ? ''
              : `\nNon-fatal warnings (do NOT trigger another \`done\` call — fix in-place if quick, otherwise note in your summary):\n${advisory
                  .slice(0, 3)
                  .map((e) => `- ${e.message}${e.lineno ? ` (line ${e.lineno})` : ''}`)
                  .join('\n')}${advisory.length > 3 ? `\n… and ${advisory.length - 3} more` : ''}`;
          text = `ACCEPTED — ${runtimeNote}. The artifact is final and the host has it. Do NOT call \`done\` (or any other tool) again. Your next and final action is a plain-text 2–4 sentence summary of the design decisions worth noting, then end your turn.${advisoryBlock}`;
        }
      } else {
        hasErrorsRounds += 1;
        const remaining = Math.max(0, MAX_HAS_ERRORS_ROUNDS - hasErrorsRounds);
        const cap =
          remaining === 0
            ? ' This was the LAST fix attempt — the next `done` call will force-accept regardless of remaining errors. Make this fix count.'
            : ` ${remaining} fix attempt${remaining === 1 ? '' : 's'} remaining before force-accept.`;
        text = `has_errors\n${fatal
          .map((e) => `- ${e.message}${e.lineno ? ` (line ${e.lineno})` : ''}`)
          .join('\n')}${cap}`;
      }
      // may9 Phase 8b — append the destructive-edit advisory if it
      // fired. This is informational, not a block: the agent sees it
      // and can re-justify in the next turn (if status was has_errors)
      // or in the user-facing summary (if status was ok). Surfacing
      // in both paths because the regression class manifests as a
      // shrunk-but-otherwise-clean source.
      if (destructiveAdvisory !== null) {
        text = `${text}\n\nDESTRUCTIVE-EDIT WARNING: ${destructiveAdvisory}`;
      }
      return { content: [{ type: 'text', text }], details };
    },
  };
}
