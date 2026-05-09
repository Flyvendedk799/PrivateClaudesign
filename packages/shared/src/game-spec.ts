/**
 * may9 Phase 4 — Game spec schema.
 *
 * The agent emits a GameSpec via the `declare_game_spec` tool BEFORE
 * touching the engine, files, or anything else. The spec is persisted on
 * the next snapshot and re-injected into the system prompt on every
 * follow-up turn so feature-level invariants (e.g. "vault: manual
 * trigger, directional, animated") survive across edits without the
 * user re-stating them. This addresses defect D6 from docs/may9.md §0b
 * and the brawler `c44763af…` 6-correction class of failure.
 *
 * `amend_game_spec` accepts a partial patch; the renderer + IPC layer
 * preserve untouched features verbatim.
 */
import { z } from 'zod';

export const GAME_SPEC_SCHEMA_VERSION = 1 as const;

export const GameGenre = z.enum([
  'platformer',
  'topdown_arcade',
  'fps',
  'tps',
  'fighting',
  'puzzle',
  'runner',
  'rpg',
  'shmup',
  'racing',
  'tower_defense',
  'visual_novel',
  'roguelike',
  'sandbox',
  'tycoon',
  'rhythm',
  'idle',
  'other',
]);
export type GameGenre = z.infer<typeof GameGenre>;

export const GameDimensions = z.enum(['2d', '2_5d', '3d']);
export type GameDimensions = z.infer<typeof GameDimensions>;

export const GamePerspective = z.enum([
  'side_scroll',
  'top_down',
  'isometric',
  'first_person',
  'third_person',
  'fixed_screen',
  'orbital',
]);
export type GamePerspective = z.infer<typeof GamePerspective>;

export const GameCameraKind = z.enum([
  'static',
  'follow_horizontal',
  'follow_2d',
  'follow_3d',
  'first_person',
  'third_person',
  'orbital',
  'parallax',
]);
export type GameCameraKind = z.infer<typeof GameCameraKind>;

export const GameInputKind = z.enum(['keyboard', 'mouse', 'pointer_lock', 'touch', 'gamepad']);
export type GameInputKind = z.infer<typeof GameInputKind>;

/**
 * Free-form per-feature spec. Keys are user-meaningful feature names
 * (e.g. "vault", "melee", "reload_hud") chosen by the agent. Values
 * carry the invariants the follow-up turns must preserve unless the
 * user explicitly amends them.
 *
 * Intentionally permissive — too tight a schema here would force the
 * agent to fight the type system instead of writing the game. The Phase
 * 4 carry-forward logic only needs to round-trip the JSON.
 */
export const GameFeatureSpec = z.record(
  z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .describe('Primitive or string array — keep human-readable.'),
);
export type GameFeatureSpec = z.infer<typeof GameFeatureSpec>;

export const GameSpec = z.object({
  schemaVersion: z.literal(GAME_SPEC_SCHEMA_VERSION).default(GAME_SPEC_SCHEMA_VERSION),
  genre: GameGenre,
  dimensions: GameDimensions,
  perspective: GamePerspective,
  cameraKind: GameCameraKind,
  primaryInputs: z.array(GameInputKind).min(1),
  numActors: z.number().int().min(1).max(64),
  winCondition: z
    .string()
    .min(3)
    .max(280)
    .describe('One sentence on how the player wins. "—" if endless.'),
  loseCondition: z
    .string()
    .min(3)
    .max(280)
    .describe('One sentence on how the player loses. "—" if no fail state.'),
  features: z
    .record(GameFeatureSpec)
    .default({})
    .describe(
      'Map of named feature → invariants. The agent commits to these and ' +
        'follow-up turns MUST preserve them unless an explicit amend_game_spec ' +
        'patches the named feature.',
    ),
});
export type GameSpec = z.infer<typeof GameSpec>;

/** Partial patch shape used by `amend_game_spec`. All top-level fields
 *  optional; `features` is merged shallow (per-key replace, not deep
 *  merge — the agent must restate the full feature spec when amending
 *  it, so partial-update bugs can't quietly drop invariants). */
export const GameSpecPatch = z.object({
  genre: GameGenre.optional(),
  dimensions: GameDimensions.optional(),
  perspective: GamePerspective.optional(),
  cameraKind: GameCameraKind.optional(),
  primaryInputs: z.array(GameInputKind).min(1).optional(),
  numActors: z.number().int().min(1).max(64).optional(),
  winCondition: z.string().min(3).max(280).optional(),
  loseCondition: z.string().min(3).max(280).optional(),
  features: z.record(GameFeatureSpec).optional(),
  /** Optional human-readable note on WHY the amend was needed. Stored
   *  for audit only. */
  reason: z.string().max(500).optional(),
});
export type GameSpecPatch = z.infer<typeof GameSpecPatch>;

/** Apply a patch on top of an existing spec. `features` keys are
 *  per-key replaced — the agent restates the full FeatureSpec for any
 *  feature it changes — and untouched features pass through verbatim
 *  from the prior turn. Returns a freshly validated GameSpec or throws.
 */
export function applyGameSpecPatch(prior: GameSpec, patch: GameSpecPatch): GameSpec {
  const merged: GameSpec = {
    ...prior,
    ...(patch.genre !== undefined ? { genre: patch.genre } : {}),
    ...(patch.dimensions !== undefined ? { dimensions: patch.dimensions } : {}),
    ...(patch.perspective !== undefined ? { perspective: patch.perspective } : {}),
    ...(patch.cameraKind !== undefined ? { cameraKind: patch.cameraKind } : {}),
    ...(patch.primaryInputs !== undefined ? { primaryInputs: patch.primaryInputs } : {}),
    ...(patch.numActors !== undefined ? { numActors: patch.numActors } : {}),
    ...(patch.winCondition !== undefined ? { winCondition: patch.winCondition } : {}),
    ...(patch.loseCondition !== undefined ? { loseCondition: patch.loseCondition } : {}),
    features: { ...prior.features, ...(patch.features ?? {}) },
  };
  return GameSpec.parse(merged);
}

/**
 * Engine ↔ spec capability matrix. Returns a fit verdict:
 *   - 'ok'   — engine is a natural fit for this spec
 *   - 'warn' — engine can do it but is not the best choice
 *   - 'reject' — engine cannot reasonably do it; pick a different one
 *
 * Driven by the `choose_engine` gate (Phase 4). The brawler case
 * (3D fighting on Pygame) returns 'reject'; FPS on Phaser returns
 * 'warn'; FPS on Three returns 'ok'.
 */
export type EngineFitVerdict = 'ok' | 'warn' | 'reject';

export interface EngineFit {
  verdict: EngineFitVerdict;
  reason: string;
}

export type GameEngineId = 'three' | 'phaser' | 'pygame' | 'godot' | 'unity';

export function checkEngineFit(spec: GameSpec, engine: GameEngineId): EngineFit {
  // Unity is overkill for lightweight genres — the 5–15 min build loop
  // wastes iteration. Reject when the brief is clearly browser-engine
  // territory.
  if (
    engine === 'unity' &&
    (spec.genre === 'idle' ||
      spec.genre === 'topdown_arcade' ||
      spec.genre === 'rhythm' ||
      spec.genre === 'tycoon')
  ) {
    return {
      verdict: 'reject',
      reason:
        "Unity's 5–15 min build loop is wasted iteration for idle / arcade / rhythm / tycoon briefs. Pick three or phaser.",
    };
  }
  if (engine === 'unity' && spec.dimensions === '2d') {
    return {
      verdict: 'warn',
      reason:
        'Unity supports 2D, but Phaser ships faster for browser 2D and Three.js handles parallax fine. Pick unity only when Steam distribution is the goal.',
    };
  }

  // 3D briefs: pygame can't sustain ≥60 fps for any 3D scene of
  // interest; phaser is 2.5D-only.
  if (spec.dimensions === '3d') {
    if (engine === 'pygame') {
      return {
        verdict: 'reject',
        reason:
          'Pygame on Pyodide cannot maintain ≥60 fps for 3D scenes. Pick three (preferred), godot, or unity.',
      };
    }
    if (engine === 'phaser') {
      return {
        verdict: 'warn',
        reason: 'Phaser supports 2.5D layering only. For real 3D pick three or unity.',
      };
    }
  }

  // Genre-specific gates.
  if (spec.genre === 'fighting' && engine === 'pygame') {
    return {
      verdict: 'reject',
      reason:
        'Frame-data fighting on Pygame/Pyodide loses ~10 fps under contention. Pick three or phaser.',
    };
  }
  if (spec.genre === 'fps' && engine === 'pygame') {
    return {
      verdict: 'reject',
      reason: 'FPS pointer-lock + raycasting needs WebGL. Pick three.',
    };
  }
  if (spec.genre === 'fps' && engine === 'phaser') {
    return {
      verdict: 'warn',
      reason: 'Phaser FPS is fake-3D raycaster territory. Three is the natural choice.',
    };
  }
  if (spec.genre === 'rpg' && engine === 'pygame') {
    return {
      verdict: 'warn',
      reason: 'Pygame works for retro RPG demos; godot is built for it.',
    };
  }
  if (spec.genre === 'visual_novel' && (engine === 'three' || engine === 'pygame')) {
    return {
      verdict: 'warn',
      reason:
        'Visual novels are dialog/branching-heavy; godot has the editor + scenes built for it.',
    };
  }

  // Camera-kind gates (catch the "FPS without first-person" misconfig).
  if (spec.cameraKind === 'first_person' && spec.perspective !== 'first_person') {
    return {
      verdict: 'warn',
      reason:
        'cameraKind=first_person but perspective is not first_person — restate the spec to keep them aligned.',
    };
  }

  return { verdict: 'ok', reason: 'Engine fits the spec.' };
}
