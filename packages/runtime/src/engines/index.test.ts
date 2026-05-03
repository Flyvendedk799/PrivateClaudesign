/**
 * gameplan §7.1 — adapter registry tests.
 */

import { describe, expect, it } from 'vitest';
import { GAME_ENGINE_ADAPTERS, getEngineAdapter, listLivePreviewEngines } from './index';

describe('GAME_ENGINE_ADAPTERS registry', () => {
  it('registers all four engines once Phase C ships pygame', () => {
    expect(GAME_ENGINE_ADAPTERS.has('three')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('phaser')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('godot')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('pygame')).toBe(true);
  });

  it('returns the adapter via getEngineAdapter for every registered id', () => {
    expect(getEngineAdapter('three')?.id).toBe('three');
    expect(getEngineAdapter('phaser')?.id).toBe('phaser');
    expect(getEngineAdapter('godot')?.id).toBe('godot');
    expect(getEngineAdapter('pygame')?.id).toBe('pygame');
  });

  it('listLivePreviewEngines covers three + phaser + pygame (Pyodide); godot stays project-download until Phase D', () => {
    const live = listLivePreviewEngines();
    expect(live).toContain('three');
    expect(live).toContain('phaser');
    expect(live).toContain('pygame');
    expect(live).not.toContain('godot');
  });
});
