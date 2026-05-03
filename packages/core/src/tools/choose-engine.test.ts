/**
 * gameplan §A5 — choose_engine tool tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { type ChooseEngineEngine, makeChooseEngineTool } from './choose-engine';

describe('makeChooseEngineTool', () => {
  it('forwards engine + rationale to the host setEngine callback', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine);
    const result = await tool.execute('id-1', {
      engine: 'phaser',
      rationale: 'Brief is a 2D platformer — Phaser is the natural fit.',
    });
    expect(setEngine).toHaveBeenCalledWith(
      'phaser',
      'Brief is a 2D platformer — Phaser is the natural fit.',
    );
    expect(result.details.engine).toBe('phaser');
    expect(result.details.rationale).toContain('Phaser');
  });

  it('accepts all four engine ids', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine);
    for (const engine of ['three', 'phaser', 'pygame', 'godot'] satisfies ChooseEngineEngine[]) {
      await tool.execute(`id-${engine}`, { engine, rationale: 'because' });
    }
    expect(setEngine).toHaveBeenCalledTimes(4);
  });

  it('runs as a no-op when the host did not wire setEngine', async () => {
    const tool = makeChooseEngineTool(undefined);
    const result = await tool.execute('id-1', { engine: 'three', rationale: 'r' });
    expect(result.details.engine).toBe('three');
  });

  it('returns a human-readable confirmation message', async () => {
    const tool = makeChooseEngineTool(vi.fn());
    const result = await tool.execute('id-1', { engine: 'godot', rationale: 'real RPG' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('godot');
    expect(text).toContain('real RPG');
  });

  it('trims the rationale before persisting', async () => {
    const setEngine = vi.fn();
    const tool = makeChooseEngineTool(setEngine);
    await tool.execute('id-1', { engine: 'three', rationale: '   trimmed   ' });
    expect(setEngine).toHaveBeenCalledWith('three', 'trimmed');
  });
});
