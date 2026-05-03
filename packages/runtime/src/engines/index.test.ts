/**
 * gameplan §7.1 — adapter registry tests.
 */

import { describe, expect, it } from 'vitest';
import { GAME_ENGINE_ADAPTERS, getEngineAdapter, listLivePreviewEngines } from './index';

describe('GAME_ENGINE_ADAPTERS registry', () => {
  it('registers three + phaser in Phase A and godot in Phase B', () => {
    expect(GAME_ENGINE_ADAPTERS.has('three')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('phaser')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('godot')).toBe(true);
  });

  it('does not register pygame until Phase C ships', () => {
    expect(GAME_ENGINE_ADAPTERS.has('pygame' as never)).toBe(false);
  });

  it('returns the adapter via getEngineAdapter', () => {
    expect(getEngineAdapter('three')?.id).toBe('three');
    expect(getEngineAdapter('phaser')?.id).toBe('phaser');
    expect(getEngineAdapter('godot')?.id).toBe('godot');
  });

  it('returns null for an unregistered engine', () => {
    expect(getEngineAdapter('pygame')).toBeNull();
  });

  it('listLivePreviewEngines includes the JS engines but not godot (Phase B = project download only)', () => {
    const live = listLivePreviewEngines();
    expect(live).toContain('three');
    expect(live).toContain('phaser');
    expect(live).not.toContain('godot');
    expect(live).not.toContain('pygame');
  });
});
