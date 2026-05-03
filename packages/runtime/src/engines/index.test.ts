/**
 * gameplan §7.1 — adapter registry tests.
 */

import { describe, expect, it } from 'vitest';
import { GAME_ENGINE_ADAPTERS, getEngineAdapter, listLivePreviewEngines } from './index';

describe('GAME_ENGINE_ADAPTERS registry', () => {
  it('registers three + phaser in Phase A', () => {
    expect(GAME_ENGINE_ADAPTERS.has('three')).toBe(true);
    expect(GAME_ENGINE_ADAPTERS.has('phaser')).toBe(true);
  });

  it('does not register pygame / godot until their phases ship', () => {
    expect(GAME_ENGINE_ADAPTERS.has('pygame' as never)).toBe(false);
    expect(GAME_ENGINE_ADAPTERS.has('godot' as never)).toBe(false);
  });

  it('returns the adapter via getEngineAdapter', () => {
    expect(getEngineAdapter('three')?.id).toBe('three');
    expect(getEngineAdapter('phaser')?.id).toBe('phaser');
  });

  it('returns null for an unregistered engine', () => {
    expect(getEngineAdapter('pygame')).toBeNull();
    expect(getEngineAdapter('godot')).toBeNull();
  });

  it('listLivePreviewEngines includes both Phase A engines', () => {
    const live = listLivePreviewEngines();
    expect(live).toContain('three');
    expect(live).toContain('phaser');
    expect(live).not.toContain('pygame');
    expect(live).not.toContain('godot');
  });
});
