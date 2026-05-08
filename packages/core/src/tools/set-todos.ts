/**
 * set_todos — UI-only progress tool.
 *
 * The agent calls this to publish a running checklist: each call REPLACES
 * the previous list. The tool has no side effects on the file system or
 * artifact; it simply surfaces through `tool_execution_start` events so
 * the sidebar renders a ToolCard with `variant: 'todos'` and a checkbox
 * list. Pair with `str_replace_based_edit_tool` so the user can watch
 * the plan tick off as the agent edits files.
 *
 * Schema intentionally mirrors what the renderer's ChatMessageList
 * already consumes (`args.items: Array<{text, checked}>`).
 *
 * may9 Phase 9b — server-side cap. The FPS Wave Defense run logged
 * 93 set_todos calls (Gameimprove flagged 8 as too many). Hard cap at
 * 3 calls per turn AND 12 calls per design lifetime, both tracked via
 * a host-injected counter callback (renderer/main owns the counter so
 * it survives chunk boundaries). When the cap fires the tool returns
 * a capped result and the agent is steered toward editing instead of
 * replanning.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const SetTodosParams = Type.Object({
  items: Type.Array(
    Type.Object({
      text: Type.String(),
      checked: Type.Boolean(),
    }),
  ),
});

export interface SetTodosDetails {
  items: Array<{ text: string; checked: boolean }>;
  capped?: 'turn' | 'design';
}

export const SET_TODOS_TURN_CAP = 3;
export const SET_TODOS_DESIGN_CAP = 12;

/** Host-supplied counter callback. Returns the per-turn + per-design
 *  invocation counts AFTER incrementing. Vitest paths can omit it; the
 *  caps are then dormant and the original behaviour applies. */
export type SetTodosCounter = () => { turnCount: number; designCount: number };

export function makeSetTodosTool(
  counter?: SetTodosCounter,
): AgentTool<typeof SetTodosParams, SetTodosDetails> {
  return {
    name: 'set_todos',
    label: 'Todos',
    description:
      'Publish or update a short checklist describing the plan for this turn. ' +
      'Each call REPLACES the previous list. Keep items under 8 words. ' +
      'Mark items checked as they complete. Use BEFORE making substantive edits ' +
      'so the user can see the plan, and again when steps finish. ' +
      'Hard cap: 3 calls per turn / 12 calls per design lifetime (FPS Wave ' +
      'Defense logged 93 — replanning is rarely the right move past this point).',
    parameters: SetTodosParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<SetTodosDetails>> {
      const items = params.items ?? [];
      if (counter !== undefined) {
        const { turnCount, designCount } = counter();
        if (designCount > SET_TODOS_DESIGN_CAP) {
          return {
            content: [
              {
                type: 'text',
                text: `set_todos design cap reached (${SET_TODOS_DESIGN_CAP} calls already used across this design). Continue editing instead of replanning — your existing plan is the source of truth. Mark items complete by checking them in the renderer (the user already has the latest list).`,
              },
            ],
            details: { items, capped: 'design' },
          };
        }
        if (turnCount > SET_TODOS_TURN_CAP) {
          return {
            content: [
              {
                type: 'text',
                text: `set_todos turn cap reached (${SET_TODOS_TURN_CAP} calls this turn). Stop replanning and start editing. If the plan changed substantively, finish the current step first and replan in the next turn.`,
              },
            ],
            details: { items, capped: 'turn' },
          };
        }
      }
      const text =
        items.length === 0
          ? 'Todo list cleared.'
          : items.map((t) => `${t.checked ? '[x]' : '[ ]'} ${t.text}`).join('\n');
      return {
        content: [{ type: 'text', text }],
        details: { items },
      };
    },
  };
}
