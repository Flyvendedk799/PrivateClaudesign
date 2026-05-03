/**
 * gameplan §7.1 — Game engine adapter registry.
 *
 * Each engine implements `GameEngineAdapter`. The registry is exported as a
 * frozen Map so callers (the `validate_game_scene` tool, the New-design
 * dialog, the game-html exporter) dispatch on `engine` without per-engine
 * if-trees scattered through the agent layer.
 *
 * Phase A ships `three` and `phaser`. Adding a new engine = drop a file
 * under this directory and register it in the map below — no other call
 * site changes.
 */

import { godotAdapter } from './godot';
import { phaserAdapter } from './phaser';
import { threeAdapter } from './three';
import type { GameEngineAdapter, GameEngineId } from './types';

export type { GameEngineAdapter, GameEngineId, ValidationIssue, ValidationResult } from './types';

/** Adapters registered for the current ship. Phase A: three + phaser.
 *  Phase B (this commit): + godot. Phase C: + pygame. */
export const GAME_ENGINE_ADAPTERS: ReadonlyMap<GameEngineId, GameEngineAdapter> = new Map([
  ['three', threeAdapter],
  ['phaser', phaserAdapter],
  ['godot', godotAdapter],
] as Array<[GameEngineId, GameEngineAdapter]>);

/** Look up the adapter for an engine id, or `null` when the engine is
 *  declared in the GameEngine union but not yet registered (e.g. Pygame /
 *  Godot before their phases ship). */
export function getEngineAdapter(id: GameEngineId): GameEngineAdapter | null {
  return GAME_ENGINE_ADAPTERS.get(id) ?? null;
}

/** Convenience for the New-design dialog and prompts: list engines that can
 *  preview live in the iframe today. Phase A → ['three', 'phaser']. */
export function listLivePreviewEngines(): readonly GameEngineId[] {
  const out: GameEngineId[] = [];
  for (const [id, adapter] of GAME_ENGINE_ADAPTERS) {
    if (adapter.supportsLivePreview()) out.push(id);
  }
  return out;
}
