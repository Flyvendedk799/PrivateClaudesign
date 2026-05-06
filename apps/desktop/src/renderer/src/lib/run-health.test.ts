import { describe, expect, it } from 'vitest';
import { computeRunHealth } from './run-health';

describe('computeRunHealth — Improver1 §10', () => {
  it('returns neutral for short runs (under the 8-turn floor)', () => {
    const r = computeRunHealth({
      turnCount: 5,
      runToolCount: 50,
      runFailureCount: 10,
      recentTurns: Array.from({ length: 5 }, () => ({ tools: 10, edits: 0, failures: 5 })),
    });
    expect(r.level).toBe('neutral');
  });

  it('warns when tools-per-turn crosses 2.5 but no other signal', () => {
    const r = computeRunHealth({
      turnCount: 20,
      runToolCount: 60, // 3.0 tools/turn
      runFailureCount: 0,
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 3, edits: 1, failures: 0 })),
    });
    expect(r.level).toBe('warn');
    expect(r.reasons.some((r) => /tools\/turn/.test(r))).toBe(true);
  });

  it('alerts when tools-per-turn crosses 3.5', () => {
    const r = computeRunHealth({
      turnCount: 20,
      runToolCount: 80, // 4.0 tools/turn
      runFailureCount: 0,
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 4, edits: 1, failures: 0 })),
    });
    expect(r.level).toBe('alert');
  });

  it('warns when edits-per-turn drops below 0.3 over the lookback', () => {
    // 10 turns × 2 tools each, only 2 of which are edits across the
    // whole window → 0.2 edits/turn. Falls in warn band.
    const r = computeRunHealth({
      turnCount: 30,
      runToolCount: 60,
      runFailureCount: 0,
      recentTurns: [
        { tools: 2, edits: 1, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
        { tools: 2, edits: 1, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
        { tools: 2, edits: 0, failures: 0 },
      ],
    });
    expect(r.level).toBe('warn');
    expect(r.reasons.some((r) => /edits\/turn/.test(r))).toBe(true);
  });

  it('alerts when edits-per-turn drops below 0.1', () => {
    const r = computeRunHealth({
      turnCount: 40,
      runToolCount: 80,
      runFailureCount: 0,
      // 10 turns, 2 tools each, 0 edits. Tools/turn = 2.0 (healthy);
      // edits/turn = 0 (alert).
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 2, edits: 0, failures: 0 })),
    });
    expect(r.level).toBe('alert');
  });

  it('alerts when failure-rate crosses 35 %', () => {
    const r = computeRunHealth({
      turnCount: 20,
      runToolCount: 40,
      runFailureCount: 15,
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 4, edits: 1, failures: 2 })),
      // 10 × 4 = 40 tools, 10 × 2 = 20 failures → 50 % rate
    });
    expect(r.level).toBe('alert');
    expect(r.reasons.some((r) => /50 % tool failures/.test(r))).toBe(true);
  });

  it('warns at 20-34 % failure-rate', () => {
    const r = computeRunHealth({
      turnCount: 20,
      runToolCount: 40,
      runFailureCount: 10,
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 4, edits: 1, failures: 1 })),
      // 10 × 4 = 40 tools, 10 × 1 = 10 failures → 25 % rate
    });
    expect(r.level).toBe('warn');
  });

  it('reports neutral when all signals are healthy', () => {
    const r = computeRunHealth({
      turnCount: 25,
      runToolCount: 40, // 1.6 tools/turn
      runFailureCount: 1,
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 2, edits: 1, failures: 0 })),
    });
    expect(r.level).toBe('neutral');
    expect(r.reasons).toEqual([]);
  });

  it('alert beats warn when both fire', () => {
    const r = computeRunHealth({
      turnCount: 20,
      runToolCount: 60, // 3.0 → warn band
      runFailureCount: 20,
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 6, edits: 0, failures: 3 })),
      // 10 × 0 edits = 0/turn → alert; failure rate = 30/60 = 50 % → alert
    });
    expect(r.level).toBe('alert');
    // Multiple reasons recorded.
    expect(r.reasons.length).toBeGreaterThan(1);
  });

  it('exposes raw metrics for tooltips', () => {
    const r = computeRunHealth({
      turnCount: 10,
      runToolCount: 30,
      runFailureCount: 3,
      recentTurns: Array.from({ length: 10 }, () => ({ tools: 3, edits: 1, failures: 1 })),
    });
    expect(r.metrics.toolsPerTurn).toBeCloseTo(3.0, 1);
    expect(r.metrics.editsPerTurn).toBeCloseTo(1.0, 1);
    expect(r.metrics.failureRate).toBeCloseTo(1 / 3, 2);
  });
});
