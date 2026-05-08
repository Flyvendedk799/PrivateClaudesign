/**
 * Phase 1 of pause-prune-fix-2026-05-08 — single, idempotent
 * `continuation_pending` writer with explicit dedupe tracking.
 *
 * Replaces the two opposite-gated writers in index.ts that left the
 * row unpersisted when a planned pause was followed by an unplanned
 * abort (the bug observed in run mox8xixd-j8cr2o, where the planned-
 * pause writer's success-path branch was never reached and the catch-
 * path writer skipped because `continuationHints.has(id) === true`).
 *
 * Three call sites in index.ts feed this helper:
 *   - planned pause, run finished cleanly → `source: 'planned'`,
 *     `reason: <continuation reason>`.
 *   - planned pause then thrown error → `source: 'planned'`,
 *     `reason: <continuation reason>`. Idempotent against the success
 *     branch via the shared `rowsWritten` Set.
 *   - unplanned mid-work abort → `source: 'unplanned'`,
 *     `reason: 'unplanned_abort'`.
 *
 * The actual DB write is injected via `doAppend` so the dedupe logic
 * is testable without a real SQLite handle. See `persist-continuation.test.ts`.
 */

export interface PersistContinuationLog {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
}

export type PersistContinuationOutcome = 'wrote' | 'already_written' | 'append_failed';

export interface PersistContinuationCallParams {
  generationId: string;
  source: 'planned' | 'unplanned';
  reason: string;
  outputTokens: number;
  wallClockMs: number;
  hasTodos: boolean;
  hasBrief: boolean;
}

/**
 * Attempt to persist exactly one `continuation_pending` row for a given
 * generation. The dedupe `rowsWritten` Set is mutated on success. The
 * caller injects `doAppend` to perform the actual DB write so tests can
 * verify the dedupe contract without a real database.
 *
 * Returns the outcome so call sites can handle persist failures
 * separately from "already written" — both are non-throwing but only
 * the failure case warrants a `continuation.persist.fail` warn (the
 * `doAppend` is expected to throw on DB errors; this helper catches it
 * so the surrounding error-classification logic isn't disturbed).
 */
export function persistContinuationRowOnce(
  rowsWritten: Set<string>,
  log: PersistContinuationLog,
  params: PersistContinuationCallParams,
  doAppend: () => void,
): PersistContinuationOutcome {
  if (rowsWritten.has(params.generationId)) {
    log.info('continuation.row_skipped', {
      generationId: params.generationId,
      reason: 'already_written',
    });
    return 'already_written';
  }
  try {
    doAppend();
    rowsWritten.add(params.generationId);
    log.info('continuation.row_persisted', {
      generationId: params.generationId,
      source: params.source,
      reason: params.reason,
      wallClockMs: params.wallClockMs,
      outputTokens: params.outputTokens,
      hasTodos: params.hasTodos,
      hasBrief: params.hasBrief,
    });
    return 'wrote';
  } catch (err) {
    log.warn('continuation.persist.fail', {
      generationId: params.generationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return 'append_failed';
  }
}
