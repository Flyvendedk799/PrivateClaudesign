/**
 * gameplan §A5 + §7.6 — `validate_game_scene` agent tool.
 *
 * Engine-discriminated lint over the current game project bundle. The agent
 * is instructed to call this before `done` so engine-specific foot-guns
 * (orphan asset keys, missing physics block, eval, frame-rate-dependent
 * movement signatures) surface as actionable issues rather than runtime
 * blank-screens.
 *
 * Dispatch lives in the host (apps/desktop/src/main) — the host wires a
 * `validate(engine, files)` callback that imports the runtime adapter
 * registry and calls `adapter.validate(files)`. Keeping the dispatch in
 * the host avoids pulling `@open-codesign/runtime` into core's deps and
 * keeps the tool itself trivially testable with a mocked validator.
 *
 * Lazy-load: the adapter `validate()` body is regex-only (no AST deps),
 * so the host's dispatch does the lazy import; the tool itself is light.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { TextEditorFsCallbacks } from './text-editor.js';

const ValidateGameSceneParams = Type.Object({
  engine: Type.Optional(
    Type.Union([
      Type.Literal('three'),
      Type.Literal('phaser'),
      Type.Literal('pygame'),
      Type.Literal('godot'),
    ]),
  ),
});

export type ValidateEngine = 'three' | 'phaser' | 'pygame' | 'godot';

export interface ValidateIssue {
  path: string;
  line?: number | undefined;
  message: string;
  severity: 'error' | 'warn';
}

export interface ValidateOutcome {
  ok: boolean;
  engine: ValidateEngine;
  issues: ValidateIssue[];
}

export interface ValidateGameSceneDetails {
  engine: ValidateEngine;
  ok: boolean;
  errorCount: number;
  warnCount: number;
  issues: ValidateIssue[];
}

export interface ValidateInputFile {
  path: string;
  content: string;
}

/** Host-supplied: walks the runtime engine adapter registry, calls
 *  `adapter.validate(files)`, normalises the result. */
export type ValidateGameSceneFn = (
  engine: ValidateEngine,
  files: ReadonlyArray<ValidateInputFile>,
) => Promise<ValidateOutcome> | ValidateOutcome;

export interface ValidateGameSceneDeps {
  fs: TextEditorFsCallbacks;
  /** Returns the engine pinned for this run (set via `choose_engine`). When
   *  the agent omits the `engine` param on the tool call we fall back to
   *  this; if it also returns null the tool reports an error. */
  getCurrentEngine(): ValidateEngine | null;
  validate: ValidateGameSceneFn;
}

/** Walk the design's virtual FS depth-first so the validator sees every
 *  source file, not just `index.html`. Used for game-mode validation; the
 *  same idiom can be exposed later for design-mode lint. */
function readAllFiles(fs: TextEditorFsCallbacks): ValidateInputFile[] {
  const out: ValidateInputFile[] = [];
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
      // listDir returns either bare names or full paths depending on
      // implementation. Normalise to a single relative path.
      const rel = entry.startsWith(dir) ? entry : dir.length > 0 ? `${dir}/${entry}` : entry;
      const file = fs.view(rel);
      if (file !== null) {
        out.push({ path: rel, content: file.content });
      } else {
        // Treat as a directory and recurse.
        if (!visited.has(rel)) queue.push(rel);
      }
    }
  }
  return out;
}

function formatIssue(issue: ValidateIssue): string {
  const lineHint = typeof issue.line === 'number' ? `:${issue.line}` : '';
  const tag = issue.severity === 'error' ? 'ERROR' : 'WARN';
  return `[${tag}] ${issue.path}${lineHint} — ${issue.message}`;
}

export function makeValidateGameSceneTool(
  deps: ValidateGameSceneDeps,
): AgentTool<typeof ValidateGameSceneParams, ValidateGameSceneDetails> {
  return {
    name: 'validate_game_scene',
    label: 'Validate game',
    description:
      'Run engine-specific lint over the current project bundle. ' +
      'Checks the gameplan §7.6 heuristics for the chosen engine: scene/lifecycle wiring, ' +
      'asset-load ordering, physics block, version-pin drift, no eval. ' +
      'Call once before `done` to surface foot-guns the runtime would otherwise blank-screen on.',
    parameters: ValidateGameSceneParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<ValidateGameSceneDetails>> {
      const engineParam = (params.engine ?? null) as ValidateEngine | null;
      const engine = engineParam ?? deps.getCurrentEngine();
      if (engine === null) {
        throw new Error(
          'validate_game_scene called without an engine and no engine has been chosen for this run yet. Call `choose_engine` first.',
        );
      }
      const files = readAllFiles(deps.fs);
      const outcome = await deps.validate(engine, files);
      const errorCount = outcome.issues.filter((i) => i.severity === 'error').length;
      const warnCount = outcome.issues.filter((i) => i.severity === 'warn').length;
      const summary = outcome.ok
        ? `validate_game_scene OK — ${engine} project passed. ${files.length} file(s) checked.`
        : `validate_game_scene FAILED — ${engine} project has ${errorCount} error(s) and ${warnCount} warning(s). Fix BEFORE \`done\`:\n\n${outcome.issues.map(formatIssue).join('\n')}`;
      return {
        content: [{ type: 'text', text: summary }],
        details: {
          engine,
          ok: outcome.ok,
          errorCount,
          warnCount,
          issues: outcome.issues,
        },
      };
    },
  };
}
