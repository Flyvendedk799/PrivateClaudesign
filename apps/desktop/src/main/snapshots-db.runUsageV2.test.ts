/**
 * Phase 3 — run_usage v2 + run_tool_durations migrations.
 *
 *  - `run_usage` gains `implied_cost_usd` (REAL NOT NULL DEFAULT 0). Legacy
 *    DBs without the column must auto-add it on init; existing rows
 *    backfill to 0.
 *  - `run_tool_durations` is a new table; idempotent CREATE.
 *
 * Both must round-trip via `recordRunUsage` and `recordToolDuration`
 * without errors and produce the expected aggregate stats.
 */

import { describe, expect, it } from 'vitest';
import {
  applySchema,
  createDesign,
  initInMemoryDb,
  listToolDurationStats,
  recordRunUsage,
  recordToolDuration,
} from './snapshots-db';

describe('run_usage v2 — implied_cost_usd column', () => {
  it('persists implied_cost_usd alongside cost_usd on a fresh DB', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordRunUsage(db, {
      generationId: 'gen-1',
      designId: design.id,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 800_000,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      impliedCostUsd: 7.65,
      totalChunks: 1,
      totalMs: 12_000,
      provider: 'claude-code-imported',
      modelId: 'claude-sonnet-4-6',
    });
    const row = db
      .prepare('SELECT cost_usd, implied_cost_usd FROM run_usage WHERE generation_id = ?')
      .get('gen-1') as { cost_usd: number; implied_cost_usd: number };
    expect(row.cost_usd).toBe(0);
    expect(row.implied_cost_usd).toBeCloseTo(7.65, 6);
    db.close();
  });

  it('omitted impliedCostUsd defaults to 0 (back-compat for callers)', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordRunUsage(db, {
      generationId: 'gen-2',
      designId: design.id,
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.01,
      totalChunks: 1,
      totalMs: 100,
    });
    const row = db
      .prepare('SELECT implied_cost_usd FROM run_usage WHERE generation_id = ?')
      .get('gen-2') as { implied_cost_usd: number };
    expect(row.implied_cost_usd).toBe(0);
    db.close();
  });

  it('legacy DB without implied_cost_usd column gets the column added on init', () => {
    // Build a DB that mirrors what a pre-Phase-3 install looks like on disk:
    // run_usage exists but lacks implied_cost_usd. applySchema must spot
    // this and ALTER TABLE to add it without losing existing rows.
    const db = initInMemoryDb();
    const design = createDesign(db, 'legacy');
    db.exec(`
      CREATE TABLE run_usage_legacy (
        generation_id              TEXT PRIMARY KEY,
        schema_version             INTEGER NOT NULL DEFAULT 1,
        design_id                  TEXT REFERENCES designs(id) ON DELETE CASCADE,
        input_tokens               INTEGER NOT NULL DEFAULT 0,
        output_tokens              INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens        INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd                   REAL NOT NULL DEFAULT 0,
        total_chunks               INTEGER NOT NULL DEFAULT 0,
        total_ms                   INTEGER NOT NULL DEFAULT 0,
        provider                   TEXT,
        model_id                   TEXT,
        created_at                 TEXT NOT NULL
      );
      INSERT INTO run_usage_legacy
        (generation_id, schema_version, design_id, input_tokens, output_tokens,
         cached_input_tokens, cache_creation_input_tokens, cost_usd, total_chunks,
         total_ms, provider, model_id, created_at)
        SELECT generation_id, schema_version, design_id, input_tokens, output_tokens,
               cached_input_tokens, cache_creation_input_tokens, cost_usd, total_chunks,
               total_ms, provider, model_id, created_at
          FROM run_usage;
      DROP TABLE run_usage;
      ALTER TABLE run_usage_legacy RENAME TO run_usage;
    `);
    // Insert a row in legacy shape (no implied_cost_usd column).
    db.prepare(
      `INSERT INTO run_usage (
        generation_id, design_id, input_tokens, output_tokens,
        cached_input_tokens, cache_creation_input_tokens, cost_usd, total_chunks,
        total_ms, created_at
      ) VALUES (?, ?, 100, 50, 0, 0, 0.001, 1, 1000, '2026-01-01T00:00:00Z')`,
    ).run('legacy-row', design.id);
    // Re-apply schema — should ALTER TABLE add the column.
    applySchema(db);
    // Legacy row backfills to 0.
    const legacy = db
      .prepare('SELECT implied_cost_usd FROM run_usage WHERE generation_id = ?')
      .get('legacy-row') as { implied_cost_usd: number };
    expect(legacy.implied_cost_usd).toBe(0);
    // New writes carry the value.
    recordRunUsage(db, {
      generationId: 'post-migration',
      designId: design.id,
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      impliedCostUsd: 1.23,
      totalChunks: 1,
      totalMs: 100,
    });
    const fresh = db
      .prepare('SELECT implied_cost_usd FROM run_usage WHERE generation_id = ?')
      .get('post-migration') as { implied_cost_usd: number };
    expect(fresh.implied_cost_usd).toBeCloseTo(1.23, 6);
    db.close();
  });
});

describe('run_tool_durations — new table', () => {
  it('persists tool durations and aggregates correctly per tool', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordToolDuration(db, {
      generationId: 'gen-1',
      designId: design.id,
      toolName: 'str_replace_based_edit_tool',
      command: 'patch',
      durationMs: 120,
      status: 'done',
    });
    recordToolDuration(db, {
      generationId: 'gen-1',
      designId: design.id,
      toolName: 'str_replace_based_edit_tool',
      command: 'view',
      durationMs: 80,
      status: 'done',
    });
    recordToolDuration(db, {
      generationId: 'gen-1',
      designId: design.id,
      toolName: 'verify_artifact',
      durationMs: 600,
      status: 'done',
    });
    recordToolDuration(db, {
      generationId: 'gen-1',
      designId: design.id,
      toolName: 'verify_artifact',
      durationMs: 800,
      status: 'error',
    });

    const stats = listToolDurationStats(db, { generationId: 'gen-1' });
    const byName = new Map(stats.map((s) => [s.toolName, s]));
    const verify = byName.get('verify_artifact');
    expect(verify).toBeDefined();
    expect(verify?.count).toBe(2);
    expect(verify?.maxMs).toBe(800);
    expect(verify?.errorCount).toBe(1);
    const editor = byName.get('str_replace_based_edit_tool');
    expect(editor?.count).toBe(2);
    expect(editor?.avgMs).toBe(100);
    expect(editor?.errorCount).toBe(0);
    db.close();
  });

  it('rejects unknown status values (CHECK constraint)', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    expect(() =>
      recordToolDuration(db, {
        generationId: 'gen-x',
        designId: design.id,
        toolName: 'foo',
        durationMs: 10,
        // biome-ignore lint/suspicious/noExplicitAny: deliberate boundary test
        status: 'banana' as any,
      }),
    ).toThrow();
    db.close();
  });

  it('global query (no generationId filter) sums across runs', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordToolDuration(db, {
      generationId: 'a',
      designId: design.id,
      toolName: 'verify_artifact',
      durationMs: 100,
      status: 'done',
    });
    recordToolDuration(db, {
      generationId: 'b',
      designId: design.id,
      toolName: 'verify_artifact',
      durationMs: 200,
      status: 'done',
    });
    const stats = listToolDurationStats(db);
    expect(stats[0]?.toolName).toBe('verify_artifact');
    expect(stats[0]?.count).toBe(2);
    expect(stats[0]?.avgMs).toBe(150);
    db.close();
  });

  it('migration is idempotent — applySchema twice keeps run_tool_durations rows intact', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordToolDuration(db, {
      generationId: 'a',
      designId: design.id,
      toolName: 'set_todos',
      durationMs: 5,
      status: 'done',
    });
    applySchema(db);
    applySchema(db);
    const stats = listToolDurationStats(db);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.count).toBe(1);
    db.close();
  });
});
