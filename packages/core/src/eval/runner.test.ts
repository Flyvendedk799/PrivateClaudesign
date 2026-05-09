/**
 * may9 Phase 14 — eval runner assertion tests.
 *
 * Covers each assertion class against canonical fixture shapes so a
 * future contributor adding a new field gets immediate guidance on
 * how it behaves.
 */
import { describe, expect, it } from 'vitest';
import { EvalFixture } from './fixture';
import { type RunObservation, evaluateFixture } from './runner';

const FPS_FIXTURE: EvalFixture = EvalFixture.parse({
  name: 'FPS Wave Defense',
  slug: 'fps-wave-defense',
  description: 'replay of the May-8 baseline FPS run',
  brief:
    'Create a simple 3D first-person shooter where the player fights through waves of enemies.',
  playtestPlaybook: 'fps',
  assertions: {
    expectedEngine: 'three',
    expectedGenre: 'fps',
    requiredFiles: ['index.html'],
    requiredAudio: true,
    maxInputTokens: 1_400_000,
    maxStrReplaceFailureRate: 0.05,
    maxSetTodosCalls: 8,
    minValidateGameSceneCalls: 1,
    minPlaytestGameCalls: 1,
    maxRenderPreviewCalls: 0,
    maxCorrections: 2,
  },
});

const PASSING_OBS: RunObservation = {
  engine: 'three',
  genre: 'fps',
  inputTokens: 1_000_000,
  outputTokens: 50_000,
  cachedInputTokens: 750_000,
  toolCounts: {
    str_replace_based_edit_tool: 80,
    set_todos: 4,
    validate_game_scene: 2,
    playtest_game: 1,
    render_preview: 0,
    generate_audio_asset: 1,
  },
  strReplaceFailures: 2,
  filePaths: ['index.html', 'src/scene.js'],
  snapshotCount: 1,
  correctionCount: 1,
};

describe('evaluateFixture — passing case', () => {
  it('PASSES when every assertion holds', () => {
    const r = evaluateFixture(FPS_FIXTURE, PASSING_OBS);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.observed.engine).toBe('three');
    expect(r.observed.cacheHitRate).toBeCloseTo(0.75, 2);
  });
});

describe('evaluateFixture — engine + genre assertions', () => {
  it('FAILS when engine != expected (brawler-on-pygame class)', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, engine: 'pygame' });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('engine: expected');
  });

  it('FAILS when genre != expected', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, genre: 'platformer' });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('genre: expected');
  });
});

describe('evaluateFixture — file + audio assertions', () => {
  it('FAILS when a required file is missing', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, filePaths: [] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain("'index.html' is missing");
  });

  it('FAILS when requiredAudio=true and no audio calls recorded', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, generate_audio_asset: 0 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('requiredAudio');
  });
});

describe('evaluateFixture — token + count caps', () => {
  it('FAILS on the FPS-baseline 4.78M input-tokens case', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, inputTokens: 4_780_000 });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('inputTokens');
  });

  it('FAILS on the FPS-baseline 93 set_todos case', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, set_todos: 93 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('set_todos calls: 93');
  });

  it('FAILS when validate_game_scene was never called (FPS D1)', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, validate_game_scene: 0 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('validate_game_scene calls: 0');
  });

  it('FAILS when playtest_game was never called (FPS D1)', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, playtest_game: 0 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('playtest_game calls: 0');
  });

  it('FAILS when render_preview was called in game mode (FPS D3)', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, render_preview: 5 },
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('render_preview calls: 5');
  });

  it('FAILS on the brawler 6-correction baseline', () => {
    const r = evaluateFixture(FPS_FIXTURE, { ...PASSING_OBS, correctionCount: 6 });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('corrections: 6');
  });
});

describe('evaluateFixture — str_replace failure rate', () => {
  it('FAILS at the FPS 19% miss-rate baseline', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, str_replace_based_edit_tool: 100 },
      strReplaceFailures: 19,
    });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toContain('strReplaceFailureRate');
  });

  it('PASSES at the post-V2 5% target', () => {
    const r = evaluateFixture(FPS_FIXTURE, {
      ...PASSING_OBS,
      toolCounts: { ...PASSING_OBS.toolCounts, str_replace_based_edit_tool: 100 },
      strReplaceFailures: 5,
    });
    expect(r.pass).toBe(true);
  });
});
