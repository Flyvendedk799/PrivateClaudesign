/**
 * `playtest_game` — host-driven synthetic-input playtest for game-mode runs.
 *
 * The 2026-05-03 c44763af trace shipped a sign error (`rotation.y =
 * -playerAngle`) through three snapshots because the only pre-`done`
 * verifier was a rendering check — nobody asserted that pressing D
 * actually moved the player toward +x. This tool plugs that gap: the
 * agent declares a small step list (`{ kind: 'key', code: 'KeyD',
 * frames: 30 }` etc.); the host loads the artifact in a hidden
 * BrowserWindow, dispatches each event, ticks a few frames, and reads
 * back `window.__game.debug.snapshot()` between steps. The agent gets
 * a serialised trace it can reason against.
 *
 * The contract is intentionally cheap: the host does NOT evaluate
 * predicates — it just returns the trace. The agent is the one that
 * decides whether `playerPos.x` increased; that gives the model a
 * chance to phrase the assertion in genre-specific terms (a brawler
 * checks aim/hitbox parity; a platformer checks gravity/jump arc).
 *
 * Core stays Electron-agnostic: the host injects a `Playtester`
 * function. When the host doesn't supply one (vitest, headless CI),
 * the tool isn't registered at all — same pattern as `render_preview`.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { TextEditorFsCallbacks } from './text-editor.js';

const PlaytestKeyStep = Type.Object({
  kind: Type.Literal('key'),
  code: Type.String({
    description: "DOM KeyboardEvent.code, e.g. 'KeyD', 'Space', 'ArrowLeft'.",
  }),
  frames: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 240,
      description: 'How many RAF frames to keep the key pressed before keyup. Default 15.',
    }),
  ),
});

const PlaytestMouseMoveStep = Type.Object({
  kind: Type.Literal('mouseMove'),
  /** Normalised viewport coordinate (0..1, top-left origin). The host
   *  multiplies by the actual window size before dispatch. */
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
});

const PlaytestMouseDownStep = Type.Object({
  kind: Type.Literal('mouseDown'),
  /** DOM `MouseEvent.button` — 0 = left, 1 = middle, 2 = right. */
  button: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
});

const PlaytestMouseUpStep = Type.Object({
  kind: Type.Literal('mouseUp'),
  button: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
});

const PlaytestWaitStep = Type.Object({
  kind: Type.Literal('wait'),
  frames: Type.Integer({ minimum: 1, maximum: 240 }),
});

const PlaytestStep = Type.Union([
  PlaytestKeyStep,
  PlaytestMouseMoveStep,
  PlaytestMouseDownStep,
  PlaytestMouseUpStep,
  PlaytestWaitStep,
]);

export type PlaytestStep =
  | { kind: 'key'; code: string; frames?: number }
  | { kind: 'mouseMove'; x: number; y: number }
  | { kind: 'mouseDown'; button?: number }
  | { kind: 'mouseUp'; button?: number }
  | { kind: 'wait'; frames: number };

const PlaytestGameParams = Type.Object({
  /** Ordered list of input steps to dispatch. The host snapshots
   *  `window.__game.debug.snapshot()` between every step. */
  steps: Type.Array(PlaytestStep, { minItems: 1, maxItems: 24 }),
  /** Path of the artifact to load. Defaults to `index.html`. */
  path: Type.Optional(Type.String()),
  /** Optional viewport hint for the hidden BrowserWindow. Mirrors the
   *  `render_preview` viewport presets. Defaults to `desktop`. */
  viewport: Type.Optional(
    Type.Union([Type.Literal('iphone'), Type.Literal('ipad'), Type.Literal('desktop')]),
  ),
});

export type PlaytestViewport = 'iphone' | 'ipad' | 'desktop';

export interface PlaytestStepResult {
  step: PlaytestStep;
  /** The serialised return of `window.__game.debug.snapshot()` after the
   *  step ran. `null` when the agent never overrode the default getter. */
  snapshotAfter: unknown;
  /** Any runtime error from the iframe captured between this step and the
   *  next. Empty when the page stayed clean. */
  errors: ReadonlyArray<string>;
}

export interface PlaytesterInput {
  artifactSource: string;
  viewport: PlaytestViewport;
  steps: ReadonlyArray<PlaytestStep>;
}

export interface PlaytesterOutput {
  /** When the bootstrap default getter was never replaced this stays
   *  false — the trace still includes any thrown errors so the agent
   *  knows the load itself worked. */
  hasDebugContract: boolean;
  baselineSnapshot: unknown;
  steps: ReadonlyArray<PlaytestStepResult>;
  /** Top-level errors before the first step ran (load / boot crashes). */
  bootErrors: ReadonlyArray<string>;
}

export type Playtester = (input: PlaytesterInput) => Promise<PlaytesterOutput>;

export interface PlaytestGameDetails {
  hasDebugContract: boolean;
  stepCount: number;
  bootErrorCount: number;
  stepErrorCount: number;
  baselineSnapshot: unknown;
  steps: ReadonlyArray<PlaytestStepResult>;
  bootErrors: ReadonlyArray<string>;
  viewport: PlaytestViewport;
}

const PLAYTEST_TOOL_DESCRIPTION =
  'Run a synthetic-input playtest of the current game. Provide an ordered ' +
  '`steps` list — keys, mouse moves, clicks, waits — and the host loads the ' +
  'artifact in a hidden BrowserWindow, dispatches each event, and returns the ' +
  'trace of `window.__game.debug.snapshot()` after every step. Use this BEFORE ' +
  '`done` to assert input → state mapping (e.g. KeyD increments playerPos.x; ' +
  'a mousedown at the reticle damages the entity in front). Catches the ' +
  'rotation/aim sign-error class that pure rendering checks miss. The agent ' +
  'is responsible for setting `window.__game.debug = { snapshot: () => ({…}) }` ' +
  'somewhere in the boot script — the bootstrap default returns null, in which ' +
  'case this tool reports `no_debug_contract` and you must wire one up before ' +
  'the next call.';

export function makePlaytestGameTool(
  fs: TextEditorFsCallbacks,
  playtester: Playtester,
): AgentTool<typeof PlaytestGameParams, PlaytestGameDetails> {
  return {
    name: 'playtest_game',
    label: 'Playtest game',
    description: PLAYTEST_TOOL_DESCRIPTION,
    parameters: PlaytestGameParams,
    async execute(_id, params): Promise<AgentToolResult<PlaytestGameDetails>> {
      const path = params.path ?? 'index.html';
      const viewport: PlaytestViewport = params.viewport ?? 'desktop';
      const file = fs.view(path);
      if (file === null) {
        throw new Error(
          `playtest_game: file "${path}" not found in the design fs. Use \`text_editor view\` to confirm the path or pass a different one.`,
        );
      }
      const steps = params.steps as ReadonlyArray<PlaytestStep>;
      const out = await playtester({ artifactSource: file.content, viewport, steps });

      const stepErrorCount = out.steps.reduce((acc, s) => acc + s.errors.length, 0);
      const summaryLines: string[] = [];
      if (!out.hasDebugContract) {
        summaryLines.push(
          'playtest_game: NO DEBUG CONTRACT — `window.__game.debug.snapshot()` returned null on baseline. ' +
            'Wire a snapshot getter exposing the fields your assertions need (player position, angle, hp, score) ' +
            'before re-running. The trace still captured runtime errors below.',
        );
      } else {
        summaryLines.push(
          `playtest_game: contract OK, ran ${out.steps.length} step(s), ${stepErrorCount} runtime error(s).`,
        );
      }
      if (out.bootErrors.length > 0) {
        summaryLines.push(`Boot errors:\n${out.bootErrors.map((e) => `  • ${e}`).join('\n')}`);
      }
      summaryLines.push(`Baseline snapshot: ${formatSnapshot(out.baselineSnapshot)}`);
      out.steps.forEach((res, idx) => {
        summaryLines.push(
          `Step ${idx + 1} ${describeStep(res.step)} → ${formatSnapshot(res.snapshotAfter)}${res.errors.length > 0 ? `\n  err: ${res.errors.join(' | ')}` : ''}`,
        );
      });

      return {
        content: [{ type: 'text', text: summaryLines.join('\n') }],
        details: {
          hasDebugContract: out.hasDebugContract,
          stepCount: out.steps.length,
          bootErrorCount: out.bootErrors.length,
          stepErrorCount,
          baselineSnapshot: out.baselineSnapshot,
          steps: out.steps,
          bootErrors: out.bootErrors,
          viewport,
        },
      };
    },
  };
}

function describeStep(s: PlaytestStep): string {
  switch (s.kind) {
    case 'key':
      return `key ${s.code}${s.frames !== undefined ? ` x${s.frames}f` : ''}`;
    case 'mouseMove':
      return `mouseMove (${s.x.toFixed(2)}, ${s.y.toFixed(2)})`;
    case 'mouseDown':
      return `mouseDown b${s.button ?? 0}`;
    case 'mouseUp':
      return `mouseUp b${s.button ?? 0}`;
    case 'wait':
      return `wait ${s.frames}f`;
  }
}

function formatSnapshot(snap: unknown): string {
  if (snap === null || snap === undefined) return 'null';
  try {
    const json = JSON.stringify(snap);
    return json.length > 240 ? `${json.slice(0, 237)}...` : json;
  } catch {
    return '<unserialisable>';
  }
}
