/**
 * Phase 2 / 4 — `chat_kinds_v3` schema migration. The CHECK constraint on
 * `chat_messages.kind` was previously locked to 5 values. New persisted
 * kinds (`reasoning_summary`, `continuation_pending`, plus the long-broken
 * `checkpoint`) require relaxing the CHECK; SQLite has no ALTER MODIFY
 * CONSTRAINT so the migration rebuilds the table. This test asserts:
 *   1. After init, the live CHECK admits all the new kinds.
 *   2. The migration is idempotent — running it twice is a no-op.
 *   3. Existing rows survive the rebuild (round-trip integrity).
 *   4. `appendChatMessage` writes succeed for each new kind.
 */

import { describe, expect, it } from 'vitest';
import {
  appendChatMessage,
  applySchema,
  createDesign,
  initInMemoryDb,
  listChatMessages,
} from './snapshots-db';

describe('chat_kinds_v3 migration (Phase 2 / 4)', () => {
  it('accepts the new kinds on a fresh in-memory DB', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');

    appendChatMessage(db, {
      designId: design.id,
      kind: 'reasoning_summary',
      payload: {
        fullText: 'thinking…',
        durationMs: 1234,
        tokenEstimate: 3,
        finalisedAt: '2026-05-06T19:14:22.000Z',
      },
    });
    appendChatMessage(db, {
      designId: design.id,
      kind: 'continuation_pending',
      payload: {
        reason: 'context_threshold',
        decisionRecap: 'recap',
        outputTokens: 50000,
        contextUsedPct: 0.85,
        wallClockMs: 850000,
      },
    });
    appendChatMessage(db, {
      designId: design.id,
      kind: 'checkpoint',
      payload: { turnCount: 5, elapsedMs: 600000, lastAssistantText: '' },
    });

    const rows = listChatMessages(db, design.id);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('reasoning_summary');
    expect(kinds).toContain('continuation_pending');
    expect(kinds).toContain('checkpoint');
    db.close();
  });

  it('still rejects an unknown kind (defensive — CHECK is not a free-for-all)', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    expect(() =>
      appendChatMessage(db, {
        designId: design.id,
        // biome-ignore lint/suspicious/noExplicitAny: deliberate boundary test
        kind: 'banana_split' as any,
        payload: {},
      }),
    ).toThrow();
    db.close();
  });

  it('is idempotent — running applySchema twice is safe and preserves rows', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'd');
    appendChatMessage(db, {
      designId: design.id,
      kind: 'reasoning_summary',
      payload: {
        fullText: 'hello',
        durationMs: 100,
        tokenEstimate: 1,
        finalisedAt: '2026-01-01T00:00:00Z',
      },
    });
    applySchema(db); // second pass — should no-op
    applySchema(db); // third pass — still safe
    const rows = listChatMessages(db, design.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('reasoning_summary');
    db.close();
  });

  it('relaxes the CHECK on a legacy DB whose chat_messages table only allows the original 5 kinds', () => {
    // Simulate the on-disk shape captured 2026-05-06 from the user's machine:
    // CHECK admits only the original 5 kinds, missing checkpoint /
    // reasoning_summary / continuation_pending. We start from a healthy DB
    // and downgrade chat_messages to legacy shape, clear the migration
    // marker, then call applySchema again to verify the rebuild path.
    const db = initInMemoryDb();
    const design = createDesign(db, 'legacy');
    appendChatMessage(db, {
      designId: design.id,
      kind: 'user',
      payload: { text: 'hi' },
    });
    db.exec(`
      CREATE TABLE chat_messages_legacy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'user', 'assistant_text', 'tool_call', 'artifact_delivered', 'error'
        )),
        payload TEXT NOT NULL,
        snapshot_id TEXT REFERENCES design_snapshots(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        session_id INTEGER NOT NULL DEFAULT 0,
        UNIQUE (design_id, seq)
      );
      INSERT INTO chat_messages_legacy
        (id, schema_version, design_id, seq, kind, payload, snapshot_id, created_at, session_id)
        SELECT id, schema_version, design_id, seq, kind, payload, snapshot_id, created_at,
               COALESCE(session_id, 0)
          FROM chat_messages;
      DROP TABLE chat_messages;
      ALTER TABLE chat_messages_legacy RENAME TO chat_messages;
      DELETE FROM db_meta WHERE key = 'chat_kinds_v3';
    `);
    // Pre-migration: legacy CHECK rejects new kinds.
    expect(() =>
      appendChatMessage(db, {
        designId: design.id,
        kind: 'reasoning_summary',
        payload: {},
      }),
    ).toThrow();
    // Run migration and verify post-migration CHECK admits new kinds.
    applySchema(db);
    appendChatMessage(db, {
      designId: design.id,
      kind: 'reasoning_summary',
      payload: {
        fullText: 'after-migration',
        durationMs: 1,
        tokenEstimate: 1,
        finalisedAt: '2026-01-01T00:00:00Z',
      },
    });
    const rows = listChatMessages(db, design.id);
    expect(rows.map((r) => r.kind)).toEqual(['user', 'reasoning_summary']);
    expect((rows[0]?.payload as { text: string }).text).toBe('hi');
    db.close();
  });
});
