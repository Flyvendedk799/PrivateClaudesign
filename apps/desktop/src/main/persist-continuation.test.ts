import { describe, expect, it, vi } from 'vitest';
import {
  type PersistContinuationCallParams,
  type PersistContinuationLog,
  persistContinuationRowOnce,
} from './persist-continuation';

function makeLog(): PersistContinuationLog & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function params(over: Partial<PersistContinuationCallParams> = {}): PersistContinuationCallParams {
  return {
    generationId: 'gen-1',
    source: 'planned',
    reason: 'context_threshold',
    outputTokens: 0,
    wallClockMs: 1234,
    hasTodos: false,
    hasBrief: false,
    ...over,
  };
}

describe('persistContinuationRowOnce — single, idempotent continuation_pending writer', () => {
  it('writes on first call and tracks the row in the dedupe set', () => {
    const set = new Set<string>();
    const log = makeLog();
    const append = vi.fn();
    const outcome = persistContinuationRowOnce(set, log, params(), append);
    expect(outcome).toBe('wrote');
    expect(append).toHaveBeenCalledTimes(1);
    expect(set.has('gen-1')).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      'continuation.row_persisted',
      expect.objectContaining({
        generationId: 'gen-1',
        source: 'planned',
        reason: 'context_threshold',
      }),
    );
  });

  it('skips on the second call and logs row_skipped (no double-write)', () => {
    // Repro of the bug fixed by this helper — run mox8xixd-j8cr2o had
    // the success-path writer never reached AND the catch-path writer
    // skipped because of a wrong gate. With dedupe via the Set, both
    // paths can call in safely; whichever fires first wins.
    const set = new Set<string>();
    const log = makeLog();
    const append = vi.fn();
    expect(persistContinuationRowOnce(set, log, params(), append)).toBe('wrote');
    expect(persistContinuationRowOnce(set, log, params(), append)).toBe('already_written');
    expect(append).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'continuation.row_skipped',
      expect.objectContaining({
        generationId: 'gen-1',
        reason: 'already_written',
      }),
    );
  });

  it('returns append_failed and warns when doAppend throws (does not mark as written)', () => {
    // When the DB write fails — for example the chat_messages schema
    // is mid-migration or the connection is dead — we must NOT mark
    // the row as written. A subsequent retry on the same generationId
    // should be allowed to try again.
    const set = new Set<string>();
    const log = makeLog();
    const append = vi.fn(() => {
      throw new Error('SQLITE_LOCKED');
    });
    const outcome = persistContinuationRowOnce(set, log, params(), append);
    expect(outcome).toBe('append_failed');
    expect(set.has('gen-1')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'continuation.persist.fail',
      expect.objectContaining({
        generationId: 'gen-1',
        message: 'SQLITE_LOCKED',
      }),
    );
    // A retry after a transient failure can succeed without the
    // dedupe set blocking it.
    const append2 = vi.fn();
    expect(persistContinuationRowOnce(set, log, params(), append2)).toBe('wrote');
    expect(append2).toHaveBeenCalledTimes(1);
  });

  it('persists distinct rows for distinct generationIds in the same dedupe set', () => {
    const set = new Set<string>();
    const log = makeLog();
    const a = vi.fn();
    const b = vi.fn();
    expect(persistContinuationRowOnce(set, log, params({ generationId: 'gen-a' }), a)).toBe(
      'wrote',
    );
    expect(persistContinuationRowOnce(set, log, params({ generationId: 'gen-b' }), b)).toBe(
      'wrote',
    );
    expect(set.has('gen-a')).toBe(true);
    expect(set.has('gen-b')).toBe(true);
  });

  it('forwards source and reason verbatim to the row_persisted log so audit greps work', () => {
    const set = new Set<string>();
    const log = makeLog();
    persistContinuationRowOnce(
      set,
      log,
      params({ source: 'unplanned', reason: 'unplanned_abort' }),
      vi.fn(),
    );
    expect(log.info).toHaveBeenCalledWith(
      'continuation.row_persisted',
      expect.objectContaining({
        source: 'unplanned',
        reason: 'unplanned_abort',
      }),
    );
  });
});
