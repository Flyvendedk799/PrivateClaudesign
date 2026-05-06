/**
 * Unit tests for the Backlog-3 §10 budgets / daily_usage tables in
 * snapshots-db.ts. Covers:
 *   - getBudget / upsertBudget roundtrip + null-limit semantics
 *   - listDailyUsage ordering + cap
 *   - recordRunUsage rolling daily_usage forward via UPSERT
 *
 * Uses an isolated in-memory SQLite instance — no Electron, no filesystem.
 */

import { describe, expect, it } from 'vitest';
import {
  getBudget,
  initInMemoryDb,
  listDailyUsage,
  recordRunUsage,
  upsertBudget,
} from './snapshots-db';

describe('Budget records', () => {
  it('returns null for an unset id', () => {
    const db = initInMemoryDb();
    expect(getBudget(db, 'global')).toBeNull();
    expect(getBudget(db, 'design-1')).toBeNull();
  });

  it('roundtrips a fully populated record', () => {
    const db = initInMemoryDb();
    upsertBudget(db, {
      id: 'global',
      dailyLimitUsd: 5,
      perDesignLimitUsd: 1,
      alertAtPct: 80,
    });
    expect(getBudget(db, 'global')).toEqual({
      id: 'global',
      dailyLimitUsd: 5,
      perDesignLimitUsd: 1,
      alertAtPct: 80,
    });
  });

  it('preserves null limits as "no cap"', () => {
    const db = initInMemoryDb();
    upsertBudget(db, {
      id: 'global',
      dailyLimitUsd: null,
      perDesignLimitUsd: null,
      alertAtPct: 100,
    });
    const r = getBudget(db, 'global');
    expect(r?.dailyLimitUsd).toBeNull();
    expect(r?.perDesignLimitUsd).toBeNull();
    expect(r?.alertAtPct).toBe(100);
  });

  it('updates an existing record by primary key', () => {
    const db = initInMemoryDb();
    upsertBudget(db, {
      id: 'global',
      dailyLimitUsd: 5,
      perDesignLimitUsd: 1,
      alertAtPct: 80,
    });
    upsertBudget(db, {
      id: 'global',
      dailyLimitUsd: 10,
      perDesignLimitUsd: null,
      alertAtPct: 90,
    });
    const r = getBudget(db, 'global');
    expect(r?.dailyLimitUsd).toBe(10);
    expect(r?.perDesignLimitUsd).toBeNull();
    expect(r?.alertAtPct).toBe(90);
  });

  it('per-design and global rows coexist independently', () => {
    const db = initInMemoryDb();
    upsertBudget(db, {
      id: 'global',
      dailyLimitUsd: 10,
      perDesignLimitUsd: null,
      alertAtPct: 80,
    });
    upsertBudget(db, {
      id: 'design-x',
      dailyLimitUsd: null,
      perDesignLimitUsd: 0.5,
      alertAtPct: 90,
    });
    expect(getBudget(db, 'global')?.dailyLimitUsd).toBe(10);
    expect(getBudget(db, 'design-x')?.perDesignLimitUsd).toBe(0.5);
  });
});

describe('daily_usage rollup via recordRunUsage', () => {
  it('adds a row on the first run of the day', () => {
    const db = initInMemoryDb();
    recordRunUsage(db, {
      generationId: 'r1',
      designId: null,
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 500,
      cacheCreationInputTokens: 0,
      costUsd: 0.05,
      totalChunks: 1,
      totalMs: 1000,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    const days = listDailyUsage(db, 7);
    expect(days).toHaveLength(1);
    expect(days[0]?.costUsd).toBeCloseTo(0.05);
    expect(days[0]?.inputTokens).toBe(1000);
    expect(days[0]?.outputTokens).toBe(100);
    expect(days[0]?.cachedInputTokens).toBe(500);
    expect(days[0]?.runCount).toBe(1);
  });

  it('accumulates totals on the same day across runs', () => {
    const db = initInMemoryDb();
    for (let i = 0; i < 3; i += 1) {
      recordRunUsage(db, {
        generationId: `r-${i}`,
        designId: null,
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 500,
        cacheCreationInputTokens: 0,
        costUsd: 0.05,
        totalChunks: 1,
        totalMs: 1000,
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
      });
    }
    const days = listDailyUsage(db, 7);
    expect(days).toHaveLength(1);
    expect(days[0]?.runCount).toBe(3);
    expect(days[0]?.costUsd).toBeCloseTo(0.15);
    expect(days[0]?.inputTokens).toBe(3000);
    expect(days[0]?.cachedInputTokens).toBe(1500);
  });

  it('all-zero usage is skipped (no row written)', () => {
    const db = initInMemoryDb();
    recordRunUsage(db, {
      generationId: 'noop',
      designId: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      totalChunks: 0,
      totalMs: 0,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect(listDailyUsage(db, 7)).toHaveLength(0);
  });
});

describe('listDailyUsage', () => {
  it('returns oldest → newest ordering', () => {
    // Insert raw daily_usage rows directly to bypass the same-day
    // collision in recordRunUsage; this tests the ORDER BY.
    const db = initInMemoryDb();
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO daily_usage (date, schema_version, cost_usd, input_tokens, output_tokens, cached_input_tokens, run_count, updated_at)
       VALUES (?, 1, ?, 0, 0, 0, ?, ?)`,
    );
    insert.run('2026-05-01', 0.1, 1, now);
    insert.run('2026-05-03', 0.3, 3, now);
    insert.run('2026-05-02', 0.2, 2, now);
    const days = listDailyUsage(db, 7);
    expect(days.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
  });

  it('caps the result to the requested daysBack', () => {
    const db = initInMemoryDb();
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO daily_usage (date, schema_version, cost_usd, input_tokens, output_tokens, cached_input_tokens, run_count, updated_at)
       VALUES (?, 1, 0, 0, 0, 0, 1, ?)`,
    );
    for (let i = 1; i <= 30; i += 1) {
      insert.run(`2026-04-${String(i).padStart(2, '0')}`, now);
    }
    const days = listDailyUsage(db, 7);
    expect(days).toHaveLength(7);
    // Last 7 = days 24..30 (oldest → newest after the reverse).
    expect(days[0]?.date).toBe('2026-04-24');
    expect(days[6]?.date).toBe('2026-04-30');
  });

  it('clamps daysBack to a sensible maximum', () => {
    const db = initInMemoryDb();
    const days = listDailyUsage(db, 99_999);
    // No rows yet → empty; the test is that the call doesn't throw on
    // a wild input (the helper internally clamps to 365).
    expect(days).toHaveLength(0);
  });
});
