/**
 * motion-graphics-plan §3 / §0.5 — `validate_motion_composition` agent tool.
 *
 * Two-phase validator. Phase 1 (regex pre-filter, sub-millisecond) catches
 * the obvious foot-guns: missing `registerRoot`, invalid prop literals,
 * forbidden globals (`setTimeout`, `Math.random`). Phase 2 (host-supplied,
 * ~1–4 s on cold bundle) invokes `@remotion/bundler.bundle()` and surfaces
 * any compile error string back to the agent.
 *
 * Dispatch lives in the host (apps/desktop/src/main/motion-mode-runtime.ts)
 * so core stays free of the heavy `@remotion/*` deps. Headless / vitest
 * runs simply omit the host validator and degrade to the regex pre-filter.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { MotionStyleName } from './choose-remotion-style.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

const Params = Type.Object({
  /** Optional path to the entrypoint. Defaults to `src/Root.tsx`. */
  entryFile: Type.Optional(Type.String()),
});

export interface ValidateMotionIssue {
  path: string;
  line?: number | undefined;
  message: string;
  severity: 'error' | 'warn';
}

export interface ValidateMotionDetails {
  ok: boolean;
  errorCount: number;
  warnCount: number;
  issues: ValidateMotionIssue[];
}

export interface ValidateMotionFile {
  path: string;
  content: string;
}

export interface ValidateMotionResult {
  ok: boolean;
  issues: ValidateMotionIssue[];
}

/** Host-supplied: bundles the project via `@remotion/bundler` and returns
 *  the result. Implementation lives in the host runtime so core stays
 *  free of webpack/Remotion deps. */
export type ValidateMotionCompositionFn = (
  files: ReadonlyArray<ValidateMotionFile>,
) => Promise<ValidateMotionResult> | ValidateMotionResult;

export interface ValidateMotionCompositionDeps {
  fs: TextEditorFsCallbacks;
  getCurrentStyle(): MotionStyleName | null;
  validate: ValidateMotionCompositionFn;
}

function readAllFiles(fs: TextEditorFsCallbacks): ValidateMotionFile[] {
  const out: ValidateMotionFile[] = [];
  const queue: string[] = [''];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries: string[] = [];
    try {
      entries = fs.listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = entry.startsWith(dir) ? entry : dir.length > 0 ? `${dir}/${entry}` : entry;
      const file = fs.view(rel);
      if (file !== null) {
        out.push({ path: rel, content: file.content });
      } else if (!visited.has(rel)) {
        queue.push(rel);
      }
    }
  }
  return out;
}

/** Regex pre-filter — cheap, runs first. Catches the obvious foot-guns
 *  without needing to spin up the bundler. Each issue carries a path so
 *  the agent can route its fix without ambiguity. */
export function preFilterMotionIssues(
  files: ReadonlyArray<ValidateMotionFile>,
  entryFile: string,
): ValidateMotionIssue[] {
  const issues: ValidateMotionIssue[] = [];
  const entry = files.find((f) => f.path === entryFile);
  if (entry === undefined) {
    issues.push({
      path: entryFile,
      message: `Entry file ${entryFile} not found in the design fs. Author it via text_editor.create.`,
      severity: 'error',
    });
    return issues;
  }
  if (!/registerRoot\s*\(/.test(entry.content)) {
    issues.push({
      path: entryFile,
      message:
        'Entry file does not call registerRoot(). Wrap your <Composition> registrations in a RemotionRoot component and call registerRoot(RemotionRoot).',
      severity: 'error',
    });
  }
  if (!/<Composition\s/.test(entry.content)) {
    issues.push({
      path: entryFile,
      message:
        'Entry file does not register any <Composition>. Add at least one <Composition id="..." component={...} durationInFrames={...} fps={...} width={...} height={...} />.',
      severity: 'error',
    });
  }
  // Walk every src/ file for the obvious anti-patterns.
  for (const f of files) {
    if (!f.path.endsWith('.tsx') && !f.path.endsWith('.ts') && !f.path.endsWith('.jsx')) continue;
    if (/\bsetTimeout\s*\(/.test(f.content) || /\bsetInterval\s*\(/.test(f.content)) {
      issues.push({
        path: f.path,
        message:
          'setTimeout / setInterval is forbidden in Remotion compositions. Use useCurrentFrame() + interpolate() instead.',
        severity: 'error',
      });
    }
    if (/\brequestAnimationFrame\s*\(/.test(f.content)) {
      issues.push({
        path: f.path,
        message:
          'requestAnimationFrame is forbidden in Remotion compositions — Remotion is frame-driven, not time-driven.',
        severity: 'error',
      });
    }
    if (/\bMath\.random\s*\(/.test(f.content)) {
      issues.push({
        path: f.path,
        message:
          'Math.random() is non-deterministic and breaks reproducible rendering. Use random("some-seed") from "remotion".',
        severity: 'warn',
      });
    }
    if (/\bnew\s+Date\s*\(/.test(f.content) || /\bDate\.now\s*\(/.test(f.content)) {
      issues.push({
        path: f.path,
        message:
          'Date.now() / new Date() inside a composition body is non-deterministic. Hardcode dates or pass them via inputProps.',
        severity: 'warn',
      });
    }
    if (/from\s+['"]framer-motion['"]/.test(f.content)) {
      issues.push({
        path: f.path,
        message:
          "framer-motion is forbidden in Remotion compositions. Use Remotion's spring() / interpolate() instead.",
        severity: 'error',
      });
    }
  }
  // Validate the prop literals on every <Composition>.
  for (const f of files) {
    if (!f.path.endsWith('.tsx') && !f.path.endsWith('.jsx')) continue;
    const compositionRegex = /<Composition\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null = compositionRegex.exec(f.content);
    while (m !== null) {
      const propsBlock = m[1] ?? '';
      const dur = /durationInFrames\s*=\s*\{(-?\d+)/.exec(propsBlock);
      if (dur !== null) {
        const n = Number.parseInt(dur[1] ?? '0', 10);
        if (!Number.isFinite(n) || n <= 0) {
          issues.push({
            path: f.path,
            message: `<Composition> has durationInFrames=${dur[1]}; must be > 0.`,
            severity: 'error',
          });
        }
      }
      const fps = /fps\s*=\s*\{(\d+)/.exec(propsBlock);
      if (fps !== null) {
        const n = Number.parseInt(fps[1] ?? '0', 10);
        if (![24, 25, 30, 50, 60].includes(n)) {
          issues.push({
            path: f.path,
            message: `<Composition> fps=${fps[1]} is unusual; standard values are 24, 25, 30, 50, 60.`,
            severity: 'warn',
          });
        }
      }
      m = compositionRegex.exec(f.content);
    }
  }
  return issues;
}

function formatIssue(issue: ValidateMotionIssue): string {
  const lineHint = typeof issue.line === 'number' ? `:${issue.line}` : '';
  const tag = issue.severity === 'error' ? 'ERROR' : 'WARN';
  return `[${tag}] ${issue.path}${lineHint} — ${issue.message}`;
}

export function makeValidateMotionCompositionTool(
  deps: ValidateMotionCompositionDeps,
): AgentTool<typeof Params, ValidateMotionDetails> {
  return {
    name: 'validate_motion_composition',
    label: 'Validate motion composition',
    description:
      'Run a regex pre-filter (registerRoot present, <Composition> registered, no setTimeout / framer-motion / Math.random) ' +
      'followed by a real bundle check via @remotion/bundler. The bundle is ground truth — if it succeeds your compositions render in the iframe; ' +
      'if it fails, the bundler error string comes back here so you can fix it without leaving the loop. ' +
      'Call once before `done` (and ideally between major sections) to surface foot-guns early.',
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<ValidateMotionDetails>> {
      const entryFile = params.entryFile ?? 'src/Root.tsx';
      const files = readAllFiles(deps.fs);
      const preFiltered = preFilterMotionIssues(files, entryFile);
      // If the pre-filter found a hard error (e.g. no registerRoot), short-
      // circuit before paying for the bundle. The agent should fix the
      // structural problem first.
      const blocking = preFiltered.filter((i) => i.severity === 'error');
      let bundleIssues: ValidateMotionIssue[] = [];
      if (blocking.length === 0) {
        const result = await deps.validate(files);
        bundleIssues = result.issues;
      }
      const allIssues = [...preFiltered, ...bundleIssues];
      const errorCount = allIssues.filter((i) => i.severity === 'error').length;
      const warnCount = allIssues.filter((i) => i.severity === 'warn').length;
      const ok = errorCount === 0;
      const summary = ok
        ? `validate_motion_composition OK — ${files.length} file(s) checked${
            warnCount > 0
              ? `, ${warnCount} warning(s):\n${allIssues
                  .filter((i) => i.severity === 'warn')
                  .map(formatIssue)
                  .join('\n')}`
              : '.'
          }`
        : `validate_motion_composition FAILED — ${errorCount} error(s) and ${warnCount} warning(s). Fix BEFORE \`done\`:\n\n${allIssues
            .map(formatIssue)
            .join('\n')}`;
      return {
        content: [{ type: 'text', text: summary }],
        details: { ok, errorCount, warnCount, issues: allIssues },
      };
    },
  };
}
