/**
 * may9 Phase 13 follow-up #30 — escalation-hint selector tests.
 */
import { describe, expect, it } from 'vitest';
import {
  ESCALATION_MIN_FAILURES,
  type EscalationSignal,
  selectEscalationHint,
} from './escalation-hint';

const NOW = Date.parse('2026-05-09T12:00:00.000Z');

function recent(modelId: string, minutesAgo: number): EscalationSignal {
  return {
    modelId,
    at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    kind: 'failed',
  };
}

describe('selectEscalationHint', () => {
  it('returns null when there are no failures', () => {
    const r = selectEscalationHint([], 'claude-sonnet-4-6', NOW);
    expect(r).toBeNull();
  });

  it('returns null when the threshold is not yet reached', () => {
    const signals: EscalationSignal[] = [recent('claude-sonnet-4-6', 1)];
    const r = selectEscalationHint(signals, 'claude-sonnet-4-6', NOW);
    expect(r).toBeNull();
  });

  it('SUGGESTS opus after 2 sonnet failures within the window', () => {
    const signals: EscalationSignal[] = [
      recent('claude-sonnet-4-6', 1),
      recent('claude-sonnet-4-6', 2),
    ];
    const r = selectEscalationHint(signals, 'claude-sonnet-4-6', NOW);
    expect(r).not.toBeNull();
    expect(r?.fromModel).toBe('claude-sonnet-4-6');
    expect(r?.toModel).toBe('claude-opus-4-7');
    expect(r?.consecutiveFailures).toBe(ESCALATION_MIN_FAILURES);
    expect(r?.costNote.toLowerCase()).toContain('per run');
  });

  it('SUGGESTS sonnet from haiku', () => {
    const signals: EscalationSignal[] = [
      recent('claude-haiku-4-5-20251001', 1),
      recent('claude-haiku-4-5-20251001', 2),
    ];
    const r = selectEscalationHint(signals, 'claude-haiku-4-5-20251001', NOW);
    expect(r?.toModel).toBe('claude-sonnet-4-6');
  });

  it('returns null when failures are outside the 5-minute window', () => {
    const signals: EscalationSignal[] = [
      recent('claude-sonnet-4-6', 6),
      recent('claude-sonnet-4-6', 10),
    ];
    const r = selectEscalationHint(signals, 'claude-sonnet-4-6', NOW);
    expect(r).toBeNull();
  });

  it('IGNORES signals on a different model', () => {
    const signals: EscalationSignal[] = [
      recent('claude-haiku-4-5-20251001', 1),
      recent('claude-sonnet-4-6', 2), // only 1 sonnet failure
    ];
    const r = selectEscalationHint(signals, 'claude-sonnet-4-6', NOW);
    expect(r).toBeNull();
  });

  it('returns null when the user is already on opus (top of ladder)', () => {
    const signals: EscalationSignal[] = [
      recent('claude-opus-4-7', 1),
      recent('claude-opus-4-7', 2),
      recent('claude-opus-4-7', 3),
    ];
    const r = selectEscalationHint(signals, 'claude-opus-4-7', NOW);
    expect(r).toBeNull();
  });

  it('returns null on an unknown model id (forward-compat)', () => {
    const signals: EscalationSignal[] = [
      recent('claude-future-9-9', 1),
      recent('claude-future-9-9', 2),
    ];
    const r = selectEscalationHint(signals, 'claude-future-9-9', NOW);
    expect(r).toBeNull();
  });

  it('counts more than the threshold when many failures stack up', () => {
    const signals: EscalationSignal[] = [
      recent('claude-sonnet-4-6', 1),
      recent('claude-sonnet-4-6', 2),
      recent('claude-sonnet-4-6', 3),
      recent('claude-sonnet-4-6', 4),
    ];
    const r = selectEscalationHint(signals, 'claude-sonnet-4-6', NOW);
    expect(r?.consecutiveFailures).toBe(4);
  });
});
