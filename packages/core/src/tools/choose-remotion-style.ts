/**
 * motion-graphics-plan §3 — `choose_remotion_style` agent tool.
 *
 * Mirrors `choose_engine` for game-mode runs. The agent picks one of the
 * MotionStyle values early in a motion-mode run; the host wires a setter
 * callback that captures the choice into the per-run mutable, and the
 * next snapshot writer can persist it on the design row.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const ChooseStyleParams = Type.Object({
  style: Type.Union([
    Type.Literal('2d'),
    Type.Literal('3d'),
    Type.Literal('kinetic-text'),
    Type.Literal('data-viz'),
    Type.Literal('mixed'),
  ]),
  rationale: Type.String({
    description:
      'One sentence on WHY this style fits the brief — surfaced in the chat to help the user understand the auto-pick (e.g. "Animated headline + supporting text → kinetic-text").',
  }),
});

export type MotionStyleName = '2d' | '3d' | 'kinetic-text' | 'data-viz' | 'mixed';

export interface ChooseMotionStyleDetails {
  style: MotionStyleName;
  rationale: string;
}

export type ChooseMotionStyleFn = (
  style: MotionStyleName,
  rationale: string,
) => void | Promise<void>;

export function makeChooseRemotionStyleTool(
  setStyle: ChooseMotionStyleFn | undefined,
): AgentTool<typeof ChooseStyleParams, ChooseMotionStyleDetails> {
  return {
    name: 'choose_remotion_style',
    label: 'Choose Remotion style',
    description:
      'Pick the visual style for this motion run BEFORE writing any composition files. ' +
      'Match to the brief: 2D illustration / shapes → 2d; 3D scene / Three.js inside Remotion → 3d; ' +
      'animated headlines / lyric video / typographic intro → kinetic-text; chart reveal / animated graph → data-viz; ' +
      'a blend of the above → mixed. The choice is persisted on the next snapshot and drives the prompt + validator.',
    parameters: ChooseStyleParams,
    async execute(_id, params): Promise<AgentToolResult<ChooseMotionStyleDetails>> {
      const style = params.style;
      const rationale = params.rationale.trim();
      if (setStyle !== undefined) await setStyle(style, rationale);
      return {
        content: [
          {
            type: 'text',
            text: `Style pinned: ${style}.${rationale.length > 0 ? ` (${rationale})` : ''}`,
          },
        ],
        details: { style, rationale },
      };
    },
  };
}
