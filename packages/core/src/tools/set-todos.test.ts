/**
 * may9 Phase 9b — set_todos cap tests.
 *
 * The FPS Wave Defense logged 93 set_todos calls in one design. The
 * cap (3/turn, 12/design) prevents this class of replanning-storm.
 */
import { describe, expect, it } from 'vitest';
import { SET_TODOS_DESIGN_CAP, SET_TODOS_TURN_CAP, makeSetTodosTool } from './set-todos';

describe('set_todos — caps', () => {
  it('passes through unchanged when no counter is supplied (vitest path)', async () => {
    const tool = makeSetTodosTool();
    const res = await tool.execute('call-1', {
      items: [{ text: 'Make it work', checked: false }],
    });
    expect(res.details.capped).toBeUndefined();
    expect(res.details.items).toHaveLength(1);
  });

  it('caps at 3 calls per turn', async () => {
    let turn = 0;
    let design = 0;
    const tool = makeSetTodosTool(() => {
      turn += 1;
      design += 1;
      return { turnCount: turn, designCount: design };
    });
    for (let i = 0; i < SET_TODOS_TURN_CAP; i++) {
      const ok = await tool.execute(`c${i}`, { items: [{ text: 'x', checked: false }] });
      expect(ok.details.capped).toBeUndefined();
    }
    const overTurn = await tool.execute('over', { items: [{ text: 'y', checked: false }] });
    expect(overTurn.details.capped).toBe('turn');
  });

  it('caps at 12 calls per design lifetime', async () => {
    let design = 0;
    const tool = makeSetTodosTool(() => {
      design += 1;
      // Mimic counter that resets turn but not design.
      return { turnCount: 1, designCount: design };
    });
    for (let i = 0; i < SET_TODOS_DESIGN_CAP; i++) {
      const ok = await tool.execute(`c${i}`, { items: [{ text: 'x', checked: false }] });
      expect(ok.details.capped).toBeUndefined();
    }
    const over = await tool.execute('over', { items: [{ text: 'y', checked: false }] });
    expect(over.details.capped).toBe('design');
  });
});
