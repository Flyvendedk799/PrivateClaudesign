/**
 * gameplan §A5 — `choose_engine` agent tool.
 *
 * The agent emits `{ engine, rationale }` early in a game-mode run. The
 * host wires a `setEngine` callback that captures the choice into a
 * per-run mutable; on the next snapshot, the host writes
 * `design_snapshots.engine` + `engine_version` from that mutable.
 *
 * No-op when the host doesn't pass `setEngine` (design-mode path) — the
 * tool still returns a confirmation so the agent loop terminates cleanly,
 * but the choice goes nowhere. In practice this branch never fires
 * because `agent.ts` only registers the tool when game-mode is active.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const ChooseEngineParams = Type.Object({
  engine: Type.Union([
    Type.Literal('three'),
    Type.Literal('phaser'),
    Type.Literal('pygame'),
    Type.Literal('godot'),
  ]),
  rationale: Type.String({
    description:
      'One sentence on WHY this engine fits the brief — referenced in the chat to ' +
      'help the user understand the auto-pick (e.g. "2D arcade — Phaser has the deepest training corpus").',
  }),
});

export type ChooseEngineEngine = 'three' | 'phaser' | 'pygame' | 'godot';

export interface ChooseEngineDetails {
  engine: ChooseEngineEngine;
  rationale: string;
}

export type ChooseEngineFn = (
  engine: ChooseEngineEngine,
  rationale: string,
) => void | Promise<void>;

export function makeChooseEngineTool(
  setEngine: ChooseEngineFn | undefined,
): AgentTool<typeof ChooseEngineParams, ChooseEngineDetails> {
  return {
    name: 'choose_engine',
    label: 'Choose engine',
    description:
      'Pick the game engine for this run BEFORE writing any project files. ' +
      'Match to the brief: 3D / WebGL / parallax → three; 2D arcade / platformer / top-down / puzzle → phaser; ' +
      'retro / Python source / generative → pygame; "real RPG" / dialog-heavy / tilemap-heavy → godot. ' +
      'The choice is persisted on the next snapshot and drives the engine guide, validator, and exporter.',
    parameters: ChooseEngineParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<ChooseEngineDetails>> {
      const engine = params.engine;
      const rationale = params.rationale.trim();
      if (setEngine !== undefined) {
        await setEngine(engine, rationale);
      }
      return {
        content: [
          {
            type: 'text',
            text: `Engine pinned: ${engine}.${rationale.length > 0 ? ` (${rationale})` : ''}`,
          },
        ],
        details: { engine, rationale },
      };
    },
  };
}
