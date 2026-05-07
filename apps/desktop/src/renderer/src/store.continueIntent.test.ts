/**
 * 2026-05-07 — pure helpers behind the free-text "continue" rerouter.
 * Both functions are exported from store.ts so we can test them without
 * spinning up the full zustand store.
 */

import type { ChatMessageRow } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { hasFreshContinuationPending, isFreeTextResumeIntent } from './store';

function row(
  partial: Partial<ChatMessageRow> & Pick<ChatMessageRow, 'kind' | 'seq' | 'designId'>,
): ChatMessageRow {
  return {
    schemaVersion: 2 as const,
    id: partial.seq + 1000,
    payload: {},
    snapshotId: null,
    createdAt: '2026-05-07T21:00:00.000Z',
    sessionId: 0,
    ...partial,
  } as ChatMessageRow;
}

describe('isFreeTextResumeIntent', () => {
  it('matches bare resume verbs in any case', () => {
    expect(isFreeTextResumeIntent('continue')).toBe(true);
    expect(isFreeTextResumeIntent('Continue')).toBe(true);
    expect(isFreeTextResumeIntent('CONTINUE')).toBe(true);
    expect(isFreeTextResumeIntent('resume')).toBe(true);
    expect(isFreeTextResumeIntent('keep going')).toBe(true);
    expect(isFreeTextResumeIntent('proceed')).toBe(true);
    expect(isFreeTextResumeIntent('go on')).toBe(true);
  });

  it('matches resume verbs with trailing punctuation', () => {
    expect(isFreeTextResumeIntent('Continue.')).toBe(true);
    expect(isFreeTextResumeIntent('continue!')).toBe(true);
    expect(isFreeTextResumeIntent('Resume?')).toBe(true);
  });

  it('matches surrounding whitespace', () => {
    expect(isFreeTextResumeIntent('   continue   ')).toBe(true);
    expect(isFreeTextResumeIntent('\nresume\n')).toBe(true);
  });

  it('does not match longer prompts that merely contain a resume verb', () => {
    expect(isFreeTextResumeIntent('continue with the next phase')).toBe(false);
    expect(isFreeTextResumeIntent('please continue')).toBe(false);
    expect(isFreeTextResumeIntent('keep going on the hero section')).toBe(false);
  });

  it('does not match unrelated short prompts', () => {
    expect(isFreeTextResumeIntent('done')).toBe(false);
    expect(isFreeTextResumeIntent('stop')).toBe(false);
    expect(isFreeTextResumeIntent('')).toBe(false);
  });
});

describe('hasFreshContinuationPending', () => {
  const D = 'design-x';

  it('true when the most recent row of the design is continuation_pending', () => {
    expect(
      hasFreshContinuationPending(
        [
          row({ seq: 0, designId: D, kind: 'user', payload: { text: 'brief' } }),
          row({ seq: 1, designId: D, kind: 'continuation_pending', payload: {} }),
        ],
        D,
      ),
    ).toBe(true);
  });

  it('false when a user row appears AFTER the continuation_pending (already consumed)', () => {
    expect(
      hasFreshContinuationPending(
        [
          row({ seq: 0, designId: D, kind: 'user', payload: { text: 'brief' } }),
          row({ seq: 1, designId: D, kind: 'continuation_pending', payload: {} }),
          row({ seq: 2, designId: D, kind: 'user', payload: { text: 'continue' } }),
        ],
        D,
      ),
    ).toBe(false);
  });

  it('false when no continuation_pending row exists', () => {
    expect(
      hasFreshContinuationPending(
        [row({ seq: 0, designId: D, kind: 'user', payload: { text: 'brief' } })],
        D,
      ),
    ).toBe(false);
  });

  it('ignores rows from other designs', () => {
    expect(
      hasFreshContinuationPending(
        [
          row({ seq: 0, designId: 'other', kind: 'continuation_pending', payload: {} }),
          row({ seq: 1, designId: D, kind: 'user', payload: { text: 'brief' } }),
        ],
        D,
      ),
    ).toBe(false);
  });

  it('false on an empty list', () => {
    expect(hasFreshContinuationPending([], D)).toBe(false);
  });

  it('tool_call / assistant_text / error rows between the continuation row and the most recent user row do not consume the pending state', () => {
    expect(
      hasFreshContinuationPending(
        [
          row({ seq: 0, designId: D, kind: 'user', payload: { text: 'brief' } }),
          row({ seq: 1, designId: D, kind: 'continuation_pending', payload: {} }),
          row({ seq: 2, designId: D, kind: 'tool_call', payload: {} }),
          row({ seq: 3, designId: D, kind: 'error', payload: { message: 'boom' } }),
          row({ seq: 4, designId: D, kind: 'assistant_text', payload: { text: 'hmm' } }),
        ],
        D,
      ),
    ).toBe(true);
  });
});
