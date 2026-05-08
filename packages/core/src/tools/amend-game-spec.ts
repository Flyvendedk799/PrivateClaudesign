/**
 * may9 Phase 4 — `amend_game_spec` agent tool.
 *
 * Patches the prior turn's spec with a partial update. `features` are
 * per-key replaced (the agent restates the full FeatureSpec for any
 * feature it changes), so untouched features pass through verbatim
 * from the prior turn. Catches the FPS vault-iteration coherence loss
 * (defect D6 in docs/may9.md §0b).
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { GameSpec, GameSpecPatch, applyGameSpecPatch } from '@open-codesign/shared';
import { Type } from '@sinclair/typebox';

const FeatureValue = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String()),
  Type.Null(),
]);
const FeatureRecord = Type.Record(Type.String(), FeatureValue);

const AmendGameSpecParams = Type.Object({
  genre: Type.Optional(Type.String()),
  dimensions: Type.Optional(Type.String()),
  perspective: Type.Optional(Type.String()),
  cameraKind: Type.Optional(Type.String()),
  primaryInputs: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  numActors: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  winCondition: Type.Optional(Type.String({ minLength: 3, maxLength: 280 })),
  loseCondition: Type.Optional(Type.String({ minLength: 3, maxLength: 280 })),
  features: Type.Optional(Type.Record(Type.String(), FeatureRecord)),
  reason: Type.Optional(
    Type.String({
      maxLength: 500,
      description: 'One sentence on WHY this amend was needed (audit only).',
    }),
  ),
});

export interface AmendGameSpecDetails {
  changedKeys: string[];
  featureKeys: string[];
}

export type GetGameSpecFn = () =>
  | import('@open-codesign/shared').GameSpec
  | undefined
  | Promise<import('@open-codesign/shared').GameSpec | undefined>;

export type SetGameSpecFn = (
  spec: import('@open-codesign/shared').GameSpec,
) => void | Promise<void>;

export function makeAmendGameSpecTool(
  getSpec: GetGameSpecFn | undefined,
  setSpec: SetGameSpecFn | undefined,
): AgentTool<typeof AmendGameSpecParams, AmendGameSpecDetails> {
  return {
    name: 'amend_game_spec',
    label: 'Amend game spec',
    description:
      'Patch the prior spec with a partial update. ONLY use when the user asks for a feature change ' +
      'that meaningfully changes invariants (e.g. "vault should be manual now"). Restate the FULL feature spec ' +
      'for any feature you change — untouched features pass through verbatim. Always include `reason` so the ' +
      'audit trail makes sense. Cheaper than re-emitting the whole spec via declare_game_spec.',
    parameters: AmendGameSpecParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<AmendGameSpecDetails>> {
      if (getSpec === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'ERROR: amend_game_spec unavailable — no prior spec recorded. Call declare_game_spec first.',
            },
          ],
          details: { changedKeys: [], featureKeys: [] },
        };
      }
      const prior = await getSpec();
      if (prior === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'ERROR: No prior spec to amend. Call declare_game_spec first.',
            },
          ],
          details: { changedKeys: [], featureKeys: [] },
        };
      }
      const patch = GameSpecPatch.parse(params);
      const after = applyGameSpecPatch(prior, patch);
      if (setSpec !== undefined) {
        await setSpec(after);
      }
      const changedKeys = Object.keys(patch).filter((k) => k !== 'reason');
      const featureKeys = Object.keys(after.features);
      const reasonLine = patch.reason !== undefined ? `Reason: ${patch.reason}. ` : '';
      const activeLine = featureKeys.length > 0 ? featureKeys.join(', ') : '(none)';
      return {
        content: [
          {
            type: 'text',
            text: `Spec amended: ${changedKeys.join(', ')}. ${reasonLine}Active features: ${activeLine}.`,
          },
        ],
        details: { changedKeys, featureKeys },
      };
    },
  };
}
