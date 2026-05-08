/**
 * may9 Phase 4 — `declare_game_spec` agent tool.
 *
 * The agent emits this BEFORE `choose_engine` and BEFORE touching any
 * file. The spec captures genre / dimensions / perspective / camera /
 * inputs / actors / win+lose conditions / per-feature invariants. The
 * host persists the validated spec on the next snapshot via
 * `setSpec(spec)` so follow-up turns can re-inject it into the system
 * prompt and `choose_engine` can validate engine fit.
 *
 * Refusing to emit a spec is not an option: the system prompt forbids
 * `text_editor.create` / `choose_engine` until this tool returns
 * successfully.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { GAME_SPEC_SCHEMA_VERSION, GameSpec } from '@open-codesign/shared';
import { Type } from '@sinclair/typebox';

const FeatureValue = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String()),
  Type.Null(),
]);
const FeatureRecord = Type.Record(Type.String(), FeatureValue);

const DeclareGameSpecParams = Type.Object({
  genre: Type.Union([
    Type.Literal('platformer'),
    Type.Literal('topdown_arcade'),
    Type.Literal('fps'),
    Type.Literal('tps'),
    Type.Literal('fighting'),
    Type.Literal('puzzle'),
    Type.Literal('runner'),
    Type.Literal('rpg'),
    Type.Literal('shmup'),
    Type.Literal('racing'),
    Type.Literal('tower_defense'),
    Type.Literal('visual_novel'),
    Type.Literal('roguelike'),
    Type.Literal('sandbox'),
    Type.Literal('tycoon'),
    Type.Literal('rhythm'),
    Type.Literal('idle'),
    Type.Literal('other'),
  ]),
  dimensions: Type.Union([Type.Literal('2d'), Type.Literal('2_5d'), Type.Literal('3d')]),
  perspective: Type.Union([
    Type.Literal('side_scroll'),
    Type.Literal('top_down'),
    Type.Literal('isometric'),
    Type.Literal('first_person'),
    Type.Literal('third_person'),
    Type.Literal('fixed_screen'),
    Type.Literal('orbital'),
  ]),
  cameraKind: Type.Union([
    Type.Literal('static'),
    Type.Literal('follow_horizontal'),
    Type.Literal('follow_2d'),
    Type.Literal('follow_3d'),
    Type.Literal('first_person'),
    Type.Literal('third_person'),
    Type.Literal('orbital'),
    Type.Literal('parallax'),
  ]),
  primaryInputs: Type.Array(
    Type.Union([
      Type.Literal('keyboard'),
      Type.Literal('mouse'),
      Type.Literal('pointer_lock'),
      Type.Literal('touch'),
      Type.Literal('gamepad'),
    ]),
    { minItems: 1 },
  ),
  numActors: Type.Integer({ minimum: 1, maximum: 64 }),
  winCondition: Type.String({ minLength: 3, maxLength: 280 }),
  loseCondition: Type.String({ minLength: 3, maxLength: 280 }),
  features: Type.Optional(Type.Record(Type.String(), FeatureRecord)),
});

export interface DeclareGameSpecDetails {
  schemaVersion: 1;
  genre: string;
  dimensions: string;
  perspective: string;
  cameraKind: string;
  inputs: number;
  actors: number;
  features: number;
}

export type SetGameSpecFn = (
  spec: import('@open-codesign/shared').GameSpec,
) => void | Promise<void>;

export function makeDeclareGameSpecTool(
  setSpec: SetGameSpecFn | undefined,
): AgentTool<typeof DeclareGameSpecParams, DeclareGameSpecDetails> {
  return {
    name: 'declare_game_spec',
    label: 'Declare game spec',
    description:
      'MANDATORY first step in every game run. Declare the spec — genre, dimensions, perspective, camera, ' +
      'inputs, actors, win/lose conditions, and per-feature invariants — BEFORE calling choose_engine or ' +
      'text_editor. The spec is persisted on the next snapshot and re-injected on every follow-up turn so ' +
      'feature invariants (e.g. "vault: manual trigger, directional, animated") survive across edits without ' +
      'the user re-stating them. Use amend_game_spec for follow-up changes — never restate the whole spec.',
    parameters: DeclareGameSpecParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<DeclareGameSpecDetails>> {
      const candidate = {
        schemaVersion: GAME_SPEC_SCHEMA_VERSION,
        ...params,
        features: params.features ?? {},
      };
      const spec = GameSpec.parse(candidate);
      if (setSpec !== undefined) {
        await setSpec(spec);
      }
      const featureNames = Object.keys(spec.features);
      const featuresLine =
        featureNames.length > 0
          ? `Features pinned: ${featureNames.join(', ')}.`
          : 'No per-feature invariants yet.';
      return {
        content: [
          {
            type: 'text',
            text: `Spec recorded: ${spec.genre}/${spec.dimensions} (${spec.perspective}, camera=${spec.cameraKind}). ${spec.numActors} actor(s), inputs=${spec.primaryInputs.join('+')}. ${featuresLine} Now call choose_engine.`,
          },
        ],
        details: {
          schemaVersion: 1,
          genre: spec.genre,
          dimensions: spec.dimensions,
          perspective: spec.perspective,
          cameraKind: spec.cameraKind,
          inputs: spec.primaryInputs.length,
          actors: spec.numActors,
          features: featureNames.length,
        },
      };
    },
  };
}
