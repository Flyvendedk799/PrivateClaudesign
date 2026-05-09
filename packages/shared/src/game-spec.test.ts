/**
 * may9 Phase 4 — GameSpec round-trip + engine-fit gate.
 *
 * Covers the brawler regression case (3D fighting on Pygame must reject)
 * and the FPS vault-iteration coherence case (amend preserves untouched
 * features verbatim).
 */
import { describe, expect, it } from 'vitest';
import { GameSpec, applyGameSpecPatch, checkEngineFit } from './game-spec';

describe('GameSpec — Zod round-trip', () => {
  it('parses a complete spec', () => {
    const parsed = GameSpec.parse({
      schemaVersion: 1,
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Clear all enemy waves and reach the exit door.',
      loseCondition: 'Player health reaches zero.',
      features: {
        vault: { trigger: 'manual', directional: true, animated: true },
        reload: { hud: 'holographic', duration_ms: 1500 },
      },
    });
    expect(parsed.genre).toBe('fps');
    expect(parsed.features['vault']?.['trigger']).toBe('manual');
  });

  it('rejects an invalid genre', () => {
    expect(() =>
      GameSpec.parse({
        schemaVersion: 1,
        genre: 'mmo',
        dimensions: '3d',
        perspective: 'first_person',
        cameraKind: 'first_person',
        primaryInputs: ['keyboard'],
        numActors: 1,
        winCondition: 'Survive.',
        loseCondition: 'Die.',
      }),
    ).toThrow();
  });

  it('requires at least one primary input', () => {
    expect(() =>
      GameSpec.parse({
        genre: 'puzzle',
        dimensions: '2d',
        perspective: 'fixed_screen',
        cameraKind: 'static',
        primaryInputs: [],
        numActors: 1,
        winCondition: 'Match all tiles.',
        loseCondition: '—',
      }),
    ).toThrow();
  });
});

describe('applyGameSpecPatch — feature carry-forward (FPS vault case)', () => {
  it('preserves untouched features when amending one feature', () => {
    const prior = GameSpec.parse({
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Reach the exit.',
      loseCondition: 'Health hits zero.',
      features: {
        vault: { trigger: 'auto', directional: false, animated: false },
        melee: { weapon: 'knife', binding: 'v' },
      },
    });
    // Amend ONLY the vault feature with the user-corrected values.
    const after = applyGameSpecPatch(prior, {
      features: {
        vault: { trigger: 'manual', directional: true, animated: true },
      },
      reason: 'User asked for press-jump-to-vault, directional, smooth anim',
    });
    expect(after.features['vault']?.['trigger']).toBe('manual');
    expect(after.features['vault']?.['directional']).toBe(true);
    expect(after.features['vault']?.['animated']).toBe(true);
    // Melee feature must survive verbatim.
    expect(after.features['melee']?.['weapon']).toBe('knife');
    expect(after.features['melee']?.['binding']).toBe('v');
  });

  it('amend without features keeps all features intact', () => {
    const prior = GameSpec.parse({
      genre: 'platformer',
      dimensions: '2d',
      perspective: 'side_scroll',
      cameraKind: 'follow_horizontal',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reach the flag.',
      loseCondition: 'Run out of lives.',
      features: { jump: { height: 5 }, dash: { distance: 3 } },
    });
    const after = applyGameSpecPatch(prior, { numActors: 4 });
    expect(after.numActors).toBe(4);
    expect(after.features['jump']?.['height']).toBe(5);
    expect(after.features['dash']?.['distance']).toBe(3);
  });
});

describe('checkEngineFit — gating matrix', () => {
  it('REJECTS 3D fighting on pygame (the brawler case)', () => {
    const spec = GameSpec.parse({
      genre: 'fighting',
      dimensions: '3d',
      perspective: 'top_down',
      cameraKind: 'follow_3d',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reduce opponent HP to zero.',
      loseCondition: 'Your HP hits zero.',
    });
    const fit = checkEngineFit(spec, 'pygame');
    expect(fit.verdict).toBe('reject');
  });

  it('REJECTS FPS on pygame (raycasting + pointer-lock)', () => {
    const spec = GameSpec.parse({
      genre: 'fps',
      dimensions: '3d',
      perspective: 'first_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse', 'pointer_lock'],
      numActors: 8,
      winCondition: 'Survive all waves.',
      loseCondition: 'HP hits zero.',
    });
    expect(checkEngineFit(spec, 'pygame').verdict).toBe('reject');
    expect(checkEngineFit(spec, 'phaser').verdict).toBe('warn');
    expect(checkEngineFit(spec, 'three').verdict).toBe('ok');
  });

  it('OKs Phaser for 2D platformer', () => {
    const spec = GameSpec.parse({
      genre: 'platformer',
      dimensions: '2d',
      perspective: 'side_scroll',
      cameraKind: 'follow_horizontal',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reach the flag.',
      loseCondition: 'Out of lives.',
    });
    expect(checkEngineFit(spec, 'phaser').verdict).toBe('ok');
  });

  it('WARNs when cameraKind=first_person but perspective is not', () => {
    const spec = GameSpec.parse({
      genre: 'tps',
      dimensions: '3d',
      perspective: 'third_person',
      cameraKind: 'first_person',
      primaryInputs: ['keyboard', 'mouse'],
      numActors: 1,
      winCondition: 'Beat the level.',
      loseCondition: 'HP zero.',
    });
    expect(checkEngineFit(spec, 'three').verdict).toBe('warn');
  });

  it('OKs Unity for 3D third-person combat (the AAA-target case)', () => {
    const spec = GameSpec.parse({
      genre: 'tps',
      dimensions: '3d',
      perspective: 'third_person',
      cameraKind: 'follow_3d',
      primaryInputs: ['keyboard', 'mouse'],
      numActors: 4,
      winCondition: 'Defeat the boss.',
      loseCondition: 'HP zero.',
    });
    expect(checkEngineFit(spec, 'unity').verdict).toBe('ok');
  });

  it('REJECTS Unity for idle / topdown_arcade / rhythm / tycoon (build loop overkill)', () => {
    const baseSpec = {
      dimensions: '2d' as const,
      perspective: 'top_down' as const,
      cameraKind: 'static' as const,
      primaryInputs: ['keyboard' as const],
      numActors: 1,
      winCondition: 'win',
      loseCondition: 'lose',
    };
    expect(checkEngineFit(GameSpec.parse({ ...baseSpec, genre: 'idle' }), 'unity').verdict).toBe(
      'reject',
    );
    expect(
      checkEngineFit(GameSpec.parse({ ...baseSpec, genre: 'topdown_arcade' }), 'unity').verdict,
    ).toBe('reject');
    expect(checkEngineFit(GameSpec.parse({ ...baseSpec, genre: 'rhythm' }), 'unity').verdict).toBe(
      'reject',
    );
    expect(checkEngineFit(GameSpec.parse({ ...baseSpec, genre: 'tycoon' }), 'unity').verdict).toBe(
      'reject',
    );
  });

  it('WARNs Unity for 2D briefs (Phaser ships faster)', () => {
    const spec = GameSpec.parse({
      genre: 'platformer',
      dimensions: '2d',
      perspective: 'side_scroll',
      cameraKind: 'follow_horizontal',
      primaryInputs: ['keyboard'],
      numActors: 2,
      winCondition: 'Reach the flag.',
      loseCondition: 'Out of lives.',
    });
    expect(checkEngineFit(spec, 'unity').verdict).toBe('warn');
  });
});
