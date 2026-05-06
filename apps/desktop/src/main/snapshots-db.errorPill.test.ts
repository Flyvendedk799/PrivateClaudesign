/**
 * Phase 5 — `countDiagnosticEvents` powers the chrome's "N errors today"
 * pill. Tests cover the date-range filter, level grouping, and the
 * default exclusion of transient noise.
 */

import { describe, expect, it } from 'vitest';
import { countDiagnosticEvents, initInMemoryDb, recordDiagnosticEvent } from './snapshots-db';

describe('countDiagnosticEvents (Phase 5)', () => {
  // Helpers — events get a unique fingerprint so the de-dup window
  // doesn't merge them.
  const event = (
    overrides: Partial<{
      level: 'info' | 'warn' | 'error';
      code: string;
      transient: boolean;
    }> = {},
  ) => ({
    level: (overrides.level ?? 'error') as 'info' | 'warn' | 'error',
    code: overrides.code ?? 'TEST',
    scope: 'generate',
    runId: undefined,
    fingerprint: `${overrides.code ?? 'TEST'}-${Math.random().toString(36).slice(2, 8)}`,
    message: 'msg',
    stack: undefined,
    transient: overrides.transient ?? false,
  });

  it('groups by level and totals across the requested range', () => {
    const db = initInMemoryDb();
    const ts = Date.now();
    recordDiagnosticEvent(db, event({ level: 'error', code: 'A' }), () => ts - 1000);
    recordDiagnosticEvent(db, event({ level: 'error', code: 'B' }), () => ts - 500);
    recordDiagnosticEvent(db, event({ level: 'warn', code: 'C' }), () => ts - 200);
    const counts = countDiagnosticEvents(db, { sinceMs: ts - 2000, untilMs: ts });
    expect(counts.error).toBe(2);
    expect(counts.warn).toBe(1);
    expect(counts.total).toBe(3);
    db.close();
  });

  it('excludes events outside the time window', () => {
    const db = initInMemoryDb();
    const ts = Date.now();
    recordDiagnosticEvent(db, event({ code: 'OLD' }), () => ts - 100_000);
    recordDiagnosticEvent(db, event({ code: 'RECENT' }), () => ts - 100);
    const counts = countDiagnosticEvents(db, { sinceMs: ts - 1000, untilMs: ts });
    expect(counts.error).toBe(1);
    db.close();
  });

  it('excludes transient events by default (the pill shows real failures, not retry chatter)', () => {
    const db = initInMemoryDb();
    const ts = Date.now();
    recordDiagnosticEvent(db, event({ code: 'TRANSIENT', transient: true }), () => ts);
    recordDiagnosticEvent(db, event({ code: 'PERMANENT' }), () => ts);
    const defaultCounts = countDiagnosticEvents(db, { sinceMs: 0, untilMs: ts + 1 });
    expect(defaultCounts.error).toBe(1);
    const allCounts = countDiagnosticEvents(db, {
      sinceMs: 0,
      untilMs: ts + 1,
      includeTransient: true,
    });
    expect(allCounts.error).toBe(2);
    db.close();
  });

  it('returns all-zero counts when no events match', () => {
    const db = initInMemoryDb();
    expect(countDiagnosticEvents(db, { sinceMs: 0 })).toEqual({
      info: 0,
      warn: 0,
      error: 0,
      total: 0,
    });
    db.close();
  });
});
