/**
 * Plan 2026-05-08 P3 — unit tests for `buildReasoningSummaryPayload`.
 *
 * The helper is the pure portion of `rollupThinkingIfPending`. Locking
 * its shape here means a future refactor of the rollup transition can't
 * silently change the persisted row format (which would break replay of
 * any chat that already has reasoning_summary rows on disk). Provider
 * emission of `thinking_delta` is a separate concern — when those events
 * arrive, the payload they produce must match this contract.
 */

import { describe, expect, it } from 'vitest';
import { buildReasoningSummaryPayload } from './useAgentStream';

describe('buildReasoningSummaryPayload (Phase 2 → Plan 2026-05-08 P3)', () => {
  it('builds the canonical payload with toolName when provided', () => {
    const startedAt = 1_700_000_000_000;
    const now = startedAt + 12_400; // 12.4 s burst
    const out = buildReasoningSummaryPayload(
      'I should plan the hero before writing it.',
      startedAt,
      now,
      'str_replace_based_edit_tool',
    );
    expect(out.fullText).toBe('I should plan the hero before writing it.');
    expect(out.durationMs).toBe(12_400);
    // 'I should plan the hero before writing it.' is 41 chars; ceil(41/4) = 11.
    expect(out.tokenEstimate).toBe(11);
    expect(out.toolName).toBe('str_replace_based_edit_tool');
    expect(out.finalisedAt).toBe(new Date(now).toISOString());
  });

  it('omits toolName entirely when not provided (no empty-string placeholder)', () => {
    const out = buildReasoningSummaryPayload('hmm', 1_000, 2_000);
    expect(out).not.toHaveProperty('toolName');
    expect(out.durationMs).toBe(1_000);
  });

  it('omits toolName when explicitly empty string (formatter relies on absence)', () => {
    const out = buildReasoningSummaryPayload('hmm', 1_000, 2_000, '');
    expect(out).not.toHaveProperty('toolName');
  });

  it('clamps durationMs at 0 when now < startedAt (clock skew on resume)', () => {
    const out = buildReasoningSummaryPayload('hmm', 5_000, 4_000);
    expect(out.durationMs).toBe(0);
  });

  it('uses ceil(chars/4) for tokenEstimate (Claude rough English ratio)', () => {
    // 8 chars → ceil(8/4) = 2.
    expect(buildReasoningSummaryPayload('12345678', 0, 0).tokenEstimate).toBe(2);
    // 9 chars → ceil(9/4) = 3.
    expect(buildReasoningSummaryPayload('123456789', 0, 0).tokenEstimate).toBe(3);
  });

  it('finalisedAt is the ISO of `now`, not Date.now() at call time', () => {
    // Determinism guard — the helper must take `now` as a parameter so
    // the row's timestamp can be tested without faking the system clock.
    const now = 1_700_000_000_000;
    const out = buildReasoningSummaryPayload('hmm', now - 1_000, now);
    expect(out.finalisedAt).toBe('2023-11-14T22:13:20.000Z');
  });
});
