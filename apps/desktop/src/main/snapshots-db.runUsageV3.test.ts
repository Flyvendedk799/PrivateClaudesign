/**
 * may9 Phase 0 — run_usage v3 columns.
 *
 * Adds artifact_type, engine, abort_kind, narration_dropped, prompt_version,
 * first_tool_call_ms. All optional on RunUsageInput; default to NULL/0 when
 * the caller omits them. Legacy DBs without the columns must auto-add them
 * on init; existing rows backfill to NULL/0.
 */

import { describe, expect, it } from 'vitest';
import { createDesign, initInMemoryDb, recordRunUsage } from './snapshots-db';

interface UsageRowV3 {
  artifact_type: string | null;
  engine: string | null;
  abort_kind: string | null;
  narration_dropped: number;
  prompt_version: string | null;
  first_tool_call_ms: number | null;
}

describe('run_usage v3 — measurement-context columns', () => {
  it('persists artifact_type/engine/abort_kind/narration_dropped/prompt_version/first_tool_call_ms', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordRunUsage(db, {
      generationId: 'gen-game-1',
      designId: design.id,
      inputTokens: 100,
      outputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.01,
      totalChunks: 1,
      totalMs: 100,
      artifactType: 'game',
      engine: 'three',
      abortKind: 'stream_interrupted',
      narrationDropped: 3,
      promptVersion: 'gw.v1+three.v1',
      firstToolCallMs: 1234,
    });
    const row = db
      .prepare(
        'SELECT artifact_type, engine, abort_kind, narration_dropped, prompt_version, first_tool_call_ms FROM run_usage WHERE generation_id = ?',
      )
      .get('gen-game-1') as UsageRowV3;
    expect(row.artifact_type).toBe('game');
    expect(row.engine).toBe('three');
    expect(row.abort_kind).toBe('stream_interrupted');
    expect(row.narration_dropped).toBe(3);
    expect(row.prompt_version).toBe('gw.v1+three.v1');
    expect(row.first_tool_call_ms).toBe(1234);
    db.close();
  });

  it('omitted optional fields default to NULL / 0', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordRunUsage(db, {
      generationId: 'gen-design-1',
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
      .prepare(
        'SELECT artifact_type, engine, abort_kind, narration_dropped, prompt_version, first_tool_call_ms FROM run_usage WHERE generation_id = ?',
      )
      .get('gen-design-1') as UsageRowV3;
    expect(row.artifact_type).toBeNull();
    expect(row.engine).toBeNull();
    expect(row.abort_kind).toBeNull();
    expect(row.narration_dropped).toBe(0);
    expect(row.prompt_version).toBeNull();
    expect(row.first_tool_call_ms).toBeNull();
    db.close();
  });

  it('UPSERT path overwrites measurement context on retry', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    recordRunUsage(db, {
      generationId: 'gen-retry',
      designId: design.id,
      inputTokens: 50,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.01,
      totalChunks: 1,
      totalMs: 100,
      artifactType: 'design',
      narrationDropped: 1,
    });
    recordRunUsage(db, {
      generationId: 'gen-retry',
      designId: design.id,
      inputTokens: 100,
      outputTokens: 200,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.02,
      totalChunks: 2,
      totalMs: 200,
      artifactType: 'game',
      engine: 'phaser',
      narrationDropped: 0,
    });
    const row = db
      .prepare(
        'SELECT artifact_type, engine, narration_dropped FROM run_usage WHERE generation_id = ?',
      )
      .get('gen-retry') as UsageRowV3;
    expect(row.artifact_type).toBe('game');
    expect(row.engine).toBe('phaser');
    expect(row.narration_dropped).toBe(0);
    db.close();
  });
});
