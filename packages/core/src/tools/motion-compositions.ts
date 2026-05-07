/**
 * motion-graphics-plan §3 — `register_composition` + `list_compositions`
 * agent tools.
 *
 * Mirrors the game-artifacts registry pattern. The agent calls
 * `register_composition` after authoring src/Root.tsx so the host's
 * Compositions tab and the iframe URL can find it; `list_compositions`
 * is the read-only sibling for refinement turns. Host wires the actual
 * SQLite-backed CRUD via the `MotionCompositionRegistryDeps` shape.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

export interface MotionCompositionRow {
  id: string;
  designId: string;
  compositionId: string;
  name: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  entryFile: string;
  createdAt: number;
  updatedAt: number;
}

export interface MotionCompositionRegistryDeps {
  list(): MotionCompositionRow[];
  upsert(input: {
    compositionId: string;
    name: string;
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
    entryFile: string;
  }): MotionCompositionRow;
}

const RegisterParams = Type.Object({
  /** Must equal the `id` prop on the matching <Composition> tag. */
  compositionId: Type.String({ minLength: 1 }),
  /** Display name shown in the Compositions tab. Defaults to compositionId. */
  name: Type.Optional(Type.String()),
  durationInFrames: Type.Integer({ minimum: 1 }),
  fps: Type.Integer({ minimum: 1, maximum: 240 }),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  /** Path to the file that registers this composition. Defaults to
   *  `src/Root.tsx`. */
  entryFile: Type.Optional(Type.String()),
});

export interface RegisterCompositionDetails {
  compositionId: string;
  name: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  entryFile: string;
}

export function makeRegisterCompositionTool(
  deps: MotionCompositionRegistryDeps,
): AgentTool<typeof RegisterParams, RegisterCompositionDetails> {
  return {
    name: 'register_composition',
    label: 'Register composition',
    description:
      "Persist a Remotion <Composition> registration into the design's composition registry. " +
      'Call this once per <Composition id="..."> tag you added to src/Root.tsx so the host\'s ' +
      'Compositions tab and the iframe URL can find it. compositionId MUST match the JSX exactly. ' +
      'Idempotent: re-calling with the same compositionId updates the existing row.',
    parameters: RegisterParams,
    async execute(_id, params): Promise<AgentToolResult<RegisterCompositionDetails>> {
      const row = deps.upsert({
        compositionId: params.compositionId,
        name: params.name ?? params.compositionId,
        durationInFrames: params.durationInFrames,
        fps: params.fps,
        width: params.width,
        height: params.height,
        entryFile: params.entryFile ?? 'src/Root.tsx',
      });
      const summary = `register_composition OK — ${row.compositionId} (${row.width}x${row.height}@${row.fps}fps, ${row.durationInFrames}f).`;
      return {
        content: [{ type: 'text', text: summary }],
        details: {
          compositionId: row.compositionId,
          name: row.name,
          durationInFrames: row.durationInFrames,
          fps: row.fps,
          width: row.width,
          height: row.height,
          entryFile: row.entryFile,
        },
      };
    },
  };
}

const ListParams = Type.Object({});

export interface ListCompositionsDetails {
  compositions: ReadonlyArray<{
    compositionId: string;
    name: string;
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
    entryFile: string;
  }>;
}

export function makeListCompositionsTool(
  deps: MotionCompositionRegistryDeps,
): AgentTool<typeof ListParams, ListCompositionsDetails> {
  return {
    name: 'list_compositions',
    label: 'List compositions',
    description:
      'List every <Composition> currently registered for this design. Use this on refinement turns ' +
      'to remember what you previously authored without re-reading src/Root.tsx. Returns compositionId, ' +
      'duration, fps, dimensions, and the entry file each composition lives in.',
    parameters: ListParams,
    async execute(): Promise<AgentToolResult<ListCompositionsDetails>> {
      const rows = deps.list();
      const compositions = rows.map((r) => ({
        compositionId: r.compositionId,
        name: r.name,
        durationInFrames: r.durationInFrames,
        fps: r.fps,
        width: r.width,
        height: r.height,
        entryFile: r.entryFile,
      }));
      const summary =
        compositions.length === 0
          ? 'list_compositions: no compositions registered for this design yet.'
          : `list_compositions: ${compositions.length} composition(s).\n${compositions
              .map(
                (c) =>
                  `- ${c.compositionId} — ${c.width}x${c.height}@${c.fps}fps, ${c.durationInFrames}f (${c.entryFile})`,
              )
              .join('\n')}`;
      return {
        content: [{ type: 'text', text: summary }],
        details: { compositions },
      };
    },
  };
}
