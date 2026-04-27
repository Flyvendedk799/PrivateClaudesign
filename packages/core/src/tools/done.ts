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
import { type CoreLogger, NOOP_LOGGER } from '../logger.js';
import { HEURISTIC_ADVISORY_SOURCES, runHeuristics } from './done-heuristics.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

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
 * Cheap structural JSX sanity check — catches the 90% of agent mistakes that
 * break Babel compile before the 3-second runtime BrowserWindow load even
 * has a chance. These are SYNCHRONOUS and deterministic so they surface in
 * every `done` call, not just when the error happens on first paint.
 *
 * Only fires for JSX-shaped artifacts. Pure HTML (legacy pastes, tests) is
 * skipped — those have their own checks via findUnclosedTags etc.
 */
function findJsxStructuralIssues(src: string): DoneError[] {
  const looksJsx =
    /ReactDOM\.createRoot\s*\(/.test(src) ||
    /\/\*\s*EDITMODE-BEGIN\s*\*\//.test(src) ||
    /(?:^|\n)\s*function\s+App\s*\(/.test(src) ||
    /(?:^|\n)\s*const\s+App\s*=/.test(src);
  if (!looksJsx) return [];

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

  // Brace / paren / bracket balance across the whole file. String-aware so
  // JSX string literals and template literals don't confuse the counter.
  const counters = { '(': 0, '{': 0, '[': 0 };
  let inStr: '"' | "'" | '`' | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      counters[ch] += 1;
      continue;
    }
    if (ch === ')') counters['('] -= 1;
    else if (ch === '}') counters['{'] -= 1;
    else if (ch === ']') counters['['] -= 1;
  }
  if (counters['('] !== 0) {
    issues.push({
      message: `Unbalanced parentheses: ${counters['(']} extra '(' (negative = extra ')').`,
      source: 'syntax',
    });
  }
  if (counters['{'] !== 0) {
    issues.push({
      message: `Unbalanced braces: ${counters['{']} extra '{' (negative = extra '}').`,
      source: 'syntax',
    });
  }
  if (counters['['] !== 0) {
    issues.push({
      message: `Unbalanced brackets: ${counters['[']} extra '[' (negative = extra ']').`,
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

  // After the final ReactDOM.createRoot(...).render(...) call there should
  // only be whitespace or comments. Stray tokens here are the exact failure
  // mode that produced "Unexpected token (line:0)" in production.
  const renderRe = /ReactDOM\.createRoot\([\s\S]*?\)\s*\.render\([\s\S]*?\)\s*;?/g;
  let lastRender: RegExpExecArray | null = null;
  let match = renderRe.exec(src);
  while (match !== null) {
    lastRender = match;
    match = renderRe.exec(src);
  }
  if (lastRender) {
    const tail = src.slice(lastRender.index + lastRender[0].length);
    // Strip /* ... */ and // ... comments + whitespace and see what's left.
    const stripped = tail
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
      .trim();
    if (stripped.length > 0) {
      const lineno = src.slice(0, lastRender.index + lastRender[0].length).split('\n').length;
      issues.push({
        message: `Unexpected content after ReactDOM.createRoot(...).render(...): "${stripped.slice(0, 80)}${stripped.length > 80 ? '…' : ''}"`,
        lineno,
        source: 'syntax',
      });
    }
  }

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

export function makeDoneTool(
  fs: TextEditorFsCallbacks,
  runtimeVerify?: DoneRuntimeVerifier,
  logger: CoreLogger = NOOP_LOGGER,
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
      const errors: DoneError[] = [
        ...findJsxStructuralIssues(file.content),
        ...findUnclosedTags(file.content),
        ...findDuplicateIds(file.content),
        ...findMissingAlt(file.content),
        // Quality heuristics — content / a11y / responsive / multi-file.
        // Advisory ones show up but don't trip has_errors. Fatal ones
        // (WCAG A failures, missing local refs) DO trip has_errors so the
        // agent fixes them before `done` accepts.
        ...runHeuristics(file.content, knownFiles),
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
      return { content: [{ type: 'text', text }], details };
    },
  };
}
