import type { ChatMessageRow } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { computeAbortContinuationRecap } from './abort-continuation';

function row(
  partial: Partial<ChatMessageRow> & Pick<ChatMessageRow, 'kind' | 'seq'>,
): ChatMessageRow {
  return {
    schemaVersion: 2 as const,
    id: partial.seq + 1000,
    designId: 'design-x',
    payload: {},
    snapshotId: null,
    createdAt: '2026-05-07T21:00:00.000Z',
    sessionId: 0,
    ...partial,
  } as ChatMessageRow;
}

describe('computeAbortContinuationRecap', () => {
  it('falls back to a stub when no assistant text exists yet', () => {
    const out = computeAbortContinuationRecap([
      row({ seq: 0, kind: 'user', payload: { text: 'build me a landing page' } }),
    ]);
    expect(out.decisionRecap).toMatch(/interrupted/i);
    expect(out.lastUserBrief).toBe('build me a landing page');
    expect(out.todoSnapshotSeq).toBeUndefined();
  });

  it('picks the most recent non-empty assistant_text as the recap', () => {
    const out = computeAbortContinuationRecap([
      row({ seq: 0, kind: 'user', payload: { text: 'first brief' } }),
      row({ seq: 1, kind: 'assistant_text', payload: { text: 'older summary' } }),
      row({ seq: 2, kind: 'tool_call', payload: { toolName: 'str_replace_based_edit_tool' } }),
      row({ seq: 3, kind: 'assistant_text', payload: { text: '' } }),
      row({ seq: 4, kind: 'assistant_text', payload: { text: 'newest summary' } }),
    ]);
    expect(out.decisionRecap).toBe('newest summary');
  });

  it('captures the seq of the most recent set_todos tool_call', () => {
    const out = computeAbortContinuationRecap([
      row({ seq: 0, kind: 'user', payload: { text: 'hi' } }),
      row({ seq: 1, kind: 'tool_call', payload: { toolName: 'set_todos', args: { items: [] } } }),
      row({ seq: 2, kind: 'tool_call', payload: { toolName: 'str_replace_based_edit_tool' } }),
      row({ seq: 3, kind: 'tool_call', payload: { toolName: 'set_todos', args: { items: [] } } }),
      row({ seq: 4, kind: 'tool_call', payload: { toolName: 'str_replace_based_edit_tool' } }),
    ]);
    expect(out.todoSnapshotSeq).toBe(3);
  });

  it('skips literal resume verbs ("continue", "resume") when picking lastUserBrief', () => {
    const out = computeAbortContinuationRecap([
      row({ seq: 0, kind: 'user', payload: { text: 'add melee + aiming + enemy types' } }),
      row({ seq: 1, kind: 'assistant_text', payload: { text: 'on it' } }),
      row({ seq: 2, kind: 'error', payload: { message: 'aborted' } }),
      row({ seq: 3, kind: 'user', payload: { text: 'continue' } }),
    ]);
    expect(out.lastUserBrief).toBe('add melee + aiming + enemy types');
  });

  it('matches "Continue." with trailing punctuation as a resume verb', () => {
    const out = computeAbortContinuationRecap([
      row({ seq: 0, kind: 'user', payload: { text: 'objective brief' } }),
      row({ seq: 1, kind: 'user', payload: { text: 'Continue.' } }),
    ]);
    expect(out.lastUserBrief).toBe('objective brief');
  });

  it('truncates briefs longer than 2000 chars with an ellipsis', () => {
    const long = 'a'.repeat(2400);
    const out = computeAbortContinuationRecap([
      row({ seq: 0, kind: 'user', payload: { text: long } }),
    ]);
    expect(out.lastUserBrief).toBeDefined();
    expect((out.lastUserBrief as string).length).toBeLessThanOrEqual(2000);
    expect((out.lastUserBrief as string).endsWith('…')).toBe(true);
  });

  it('handles an empty row list (returns the stub recap, no fields)', () => {
    const out = computeAbortContinuationRecap([]);
    expect(out.decisionRecap).toMatch(/interrupted/i);
    expect(out.lastUserBrief).toBeUndefined();
    expect(out.todoSnapshotSeq).toBeUndefined();
  });
});
