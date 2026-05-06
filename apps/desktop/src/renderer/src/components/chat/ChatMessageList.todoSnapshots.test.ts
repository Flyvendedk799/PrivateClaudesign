/**
 * Phase 1 — `planTodoSnapshots` decides which `set_todos` rows render full vs
 * collapsed vs hoisted-to-sticky. Run trace 2026-05-06 design ba2adf62 session
 * 7 produced three snapshots (0/28 → 14/28 → 28/28); the user reported the
 * chat reading as "started from scratch with no todos done" because the 0/28
 * card anchored the top of their eye-line. The plan keeps history accessible
 * while making the latest dominant.
 */

import type { ChatMessageRow, ChatToolCallPayload } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { planTodoSnapshots } from './ChatMessageList';
import { formatTodoSnapshotSummary } from './WorkingCard';

function todoRow(
  seq: number,
  items: ReadonlyArray<{ text: string; checked: boolean }>,
): ChatMessageRow {
  return {
    designId: 'd1',
    seq,
    kind: 'tool_call',
    payload: {
      toolName: 'set_todos',
      args: { items },
      status: 'done',
      startedAt: new Date(seq * 1000).toISOString(),
      verbGroup: 'Working',
    } satisfies ChatToolCallPayload as unknown as ChatMessageRow['payload'],
    createdAt: new Date(seq * 1000).toISOString(),
  } as ChatMessageRow;
}

function userRow(seq: number): ChatMessageRow {
  return {
    designId: 'd1',
    seq,
    kind: 'user',
    payload: { text: 'go' } as ChatMessageRow['payload'],
    createdAt: new Date(seq * 1000).toISOString(),
  } as ChatMessageRow;
}

const items28checked = (n: number): ReadonlyArray<{ text: string; checked: boolean }> =>
  Array.from({ length: 28 }, (_, i) => ({ text: `task ${i}`, checked: i < n }));

describe('planTodoSnapshots (Phase 1)', () => {
  it('returns empty plan when there are no set_todos rows', () => {
    const plan = planTodoSnapshots([userRow(0)], false, false);
    expect(plan.collapsedSeqs.size).toBe(0);
    expect(plan.inlineLatestSeq).toBeNull();
    expect(plan.hoistedLatestSeq).toBeNull();
  });

  it('FPS-run shape: 3 snapshots not generating → 2 collapsed, latest inline', () => {
    const messages: ChatMessageRow[] = [
      userRow(0),
      todoRow(437, items28checked(0)),
      todoRow(444, items28checked(14)),
      todoRow(484, items28checked(28)),
    ];
    const plan = planTodoSnapshots(messages, false, false);
    expect([...plan.collapsedSeqs]).toEqual([437, 444]);
    expect(plan.inlineLatestSeq).toBe(484);
    expect(plan.hoistedLatestSeq).toBeNull();
  });

  it('FPS-run shape: 3 snapshots generating → 2 collapsed, latest hoisted (sticky)', () => {
    const messages: ChatMessageRow[] = [
      userRow(0),
      todoRow(437, items28checked(0)),
      todoRow(444, items28checked(14)),
      todoRow(484, items28checked(28)),
    ];
    const plan = planTodoSnapshots(messages, false, true);
    expect([...plan.collapsedSeqs]).toEqual([437, 444]);
    expect(plan.inlineLatestSeq).toBeNull();
    expect(plan.hoistedLatestSeq).toBe(484);
  });

  it('hasPendingTodos=true: pending stream owns the live snapshot, all persisted are historical', () => {
    const messages: ChatMessageRow[] = [
      userRow(0),
      todoRow(437, items28checked(0)),
      todoRow(444, items28checked(14)),
      todoRow(484, items28checked(28)),
    ];
    const plan = planTodoSnapshots(messages, true, true);
    expect([...plan.collapsedSeqs]).toEqual([437, 444, 484]);
    expect(plan.inlineLatestSeq).toBeNull();
    expect(plan.hoistedLatestSeq).toBeNull();
  });

  it('single set_todos generating → no collapsed, hoisted to sticky', () => {
    const messages: ChatMessageRow[] = [userRow(0), todoRow(50, items28checked(0))];
    const plan = planTodoSnapshots(messages, false, true);
    expect(plan.collapsedSeqs.size).toBe(0);
    expect(plan.inlineLatestSeq).toBeNull();
    expect(plan.hoistedLatestSeq).toBe(50);
  });

  it('single set_todos not generating → no collapsed, inline latest', () => {
    const messages: ChatMessageRow[] = [userRow(0), todoRow(50, items28checked(28))];
    const plan = planTodoSnapshots(messages, false, false);
    expect(plan.collapsedSeqs.size).toBe(0);
    expect(plan.inlineLatestSeq).toBe(50);
    expect(plan.hoistedLatestSeq).toBeNull();
  });

  it('non-set_todos tool_calls are ignored', () => {
    const messages: ChatMessageRow[] = [
      userRow(0),
      {
        designId: 'd1',
        seq: 5,
        kind: 'tool_call',
        payload: {
          toolName: 'str_replace_based_edit_tool',
          args: {},
          status: 'done',
          startedAt: '2026-05-06T19:00:00.000Z',
          verbGroup: 'Working',
        } satisfies ChatToolCallPayload as unknown as ChatMessageRow['payload'],
        createdAt: '2026-05-06T19:00:00.000Z',
      } as ChatMessageRow,
    ];
    const plan = planTodoSnapshots(messages, false, false);
    expect(plan.collapsedSeqs.size).toBe(0);
    expect(plan.inlineLatestSeq).toBeNull();
    expect(plan.hoistedLatestSeq).toBeNull();
  });
});

describe('formatTodoSnapshotSummary (Phase 1)', () => {
  it('formats N / M done with timestamp', () => {
    const call: ChatToolCallPayload = {
      toolName: 'set_todos',
      args: { items: items28checked(14) },
      status: 'done',
      startedAt: '2026-05-06T19:14:22.000Z',
      verbGroup: 'Working',
    };
    const summary = formatTodoSnapshotSummary(call);
    expect(summary.done).toBe(14);
    expect(summary.total).toBe(28);
    expect(summary.label).toMatch(/^Plan revised — 14 \/ 28 done at \d{2}:\d{2}:22$/);
  });

  it('omits timestamp when startedAt is missing', () => {
    const call: ChatToolCallPayload = {
      toolName: 'set_todos',
      args: { items: items28checked(7) },
      status: 'done',
      startedAt: '',
      verbGroup: 'Working',
    } as ChatToolCallPayload;
    const summary = formatTodoSnapshotSummary(call);
    expect(summary.label).toBe('Plan revised — 7 / 28 done');
  });
});
