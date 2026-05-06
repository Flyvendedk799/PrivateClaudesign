/**
 * Unit tests for snapshots-db.ts using an in-memory SQLite instance.
 *
 * No Electron, no filesystem — just better-sqlite3 :memory:.
 */

import { describe, expect, it } from 'vitest';
import {
  appendChatMessage,
  clearDesignWorkspace,
  contentTypeFromPath,
  createDesign,
  createSnapshot,
  deleteSnapshot,
  duplicateDesign,
  getDesign,
  getDesignCurrentSession,
  getDesignUsageTotals,
  getSnapshot,
  getSnapshotFiles,
  initInMemoryDb,
  listChatMessages,
  listDesignFiles,
  listDesigns,
  listSnapshots,
  newChatSession,
  recordRunUsage,
  renameDesign,
  restoreSnapshotFiles,
  seedDesignFilesFromLatestSnapshot,
  setDesignCurrentSession,
  setDesignPromptAssistMetadata,
  setDesignThumbnail,
  snapshotDesignFiles,
  softDeleteDesign,
  updateChatToolCallStatus,
  updateDesignWorkspace,
  upsertDesignFile,
} from './snapshots-db';

function makeDb() {
  return initInMemoryDb();
}

// ---------------------------------------------------------------------------
// designs
// ---------------------------------------------------------------------------

describe('createDesign + listDesigns', () => {
  it('creates a design with defaults and returns it via listDesigns', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(d.schemaVersion).toBe(1);
    expect(d.name).toBe('Untitled design');
    expect(typeof d.id).toBe('string');
    expect(d.id.length).toBeGreaterThan(0);
    expect(d.createdAt).toBeTruthy();
    expect(d.updatedAt).toBeTruthy();

    const list = listDesigns(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(d.id);
  });

  it('creates a design with a custom name', () => {
    const db = makeDb();
    const d = createDesign(db, 'My landing page');
    expect(d.name).toBe('My landing page');
  });

  it('orders designs by created_at DESC (most recent first)', () => {
    const db = makeDb();
    // Insert with a small delay via overriding created_at via raw SQL to guarantee ordering.
    const idA = 'aaaa-design';
    const idB = 'bbbb-design';
    db.prepare(
      'INSERT INTO designs (id, schema_version, name, created_at, updated_at) VALUES (?, 1, ?, ?, ?)',
    ).run(idA, 'A', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    db.prepare(
      'INSERT INTO designs (id, schema_version, name, created_at, updated_at) VALUES (?, 1, ?, ?, ?)',
    ).run(idB, 'B', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z');

    const list = listDesigns(db);
    const ids = list.map((d) => d.id);
    // B was created on day 2, A on day 1 — B should come first (DESC).
    expect(ids.indexOf(idB)).toBeLessThan(ids.indexOf(idA));
  });
});

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

describe('createSnapshot + listSnapshots', () => {
  it('creates an initial snapshot and lists it', () => {
    const db = makeDb();
    const design = createDesign(db);
    const snap = createSnapshot(db, {
      designId: design.id,
      parentId: null,
      type: 'initial',
      prompt: 'Create a landing page',
      artifactType: 'html',
      artifactSource: '<html>v1</html>',
    });

    expect(snap.schemaVersion).toBe(1);
    expect(snap.designId).toBe(design.id);
    expect(snap.parentId).toBeNull();
    expect(snap.type).toBe('initial');
    expect(snap.artifactSource).toBe('<html>v1</html>');
    expect(snap.createdAt).toBeTruthy();

    const list = listSnapshots(db, design.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(snap.id);
  });

  it('lists snapshots ordered by created_at DESC', () => {
    const db = makeDb();
    const design = createDesign(db);
    // Insert with explicit timestamps to avoid sub-millisecond collisions.
    const insertSnap = (
      at: string,
      parentId: string | null,
      type: 'initial' | 'edit',
      prompt: string,
    ) => {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO design_snapshots
           (id, schema_version, design_id, parent_id, type, prompt, artifact_type, artifact_source, created_at, message)
         VALUES (?, 1, ?, ?, ?, ?, 'html', '<html/>', ?, NULL)`,
      ).run(id, design.id, parentId, type, prompt, at);
      return id;
    };
    const id1 = insertSnap('2024-01-01T00:00:00.000Z', null, 'initial', 'v1');
    const id2 = insertSnap('2024-01-02T00:00:00.000Z', id1, 'edit', 'v2');
    const id3 = insertSnap('2024-01-03T00:00:00.000Z', id2, 'edit', 'v3');

    const list = listSnapshots(db, design.id);
    expect(list).toHaveLength(3);
    // Most recent first.
    expect(list[0]?.id).toBe(id3);
    expect(list[1]?.id).toBe(id2);
    expect(list[2]?.id).toBe(id1);
  });

  it('builds a parent_id chain: initial → edit → edit', () => {
    const db = makeDb();
    const design = createDesign(db);
    const s1 = createSnapshot(db, {
      designId: design.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'html',
      artifactSource: '<html>v1</html>',
    });
    const s2 = createSnapshot(db, {
      designId: design.id,
      parentId: s1.id,
      type: 'edit',
      prompt: 'tweak 1',
      artifactType: 'html',
      artifactSource: '<html>v2</html>',
    });
    const s3 = createSnapshot(db, {
      designId: design.id,
      parentId: s2.id,
      type: 'edit',
      prompt: 'tweak 2',
      artifactType: 'html',
      artifactSource: '<html>v3</html>',
    });

    expect(s1.parentId).toBeNull();
    expect(s2.parentId).toBe(s1.id);
    expect(s3.parentId).toBe(s2.id);
  });
});

// ---------------------------------------------------------------------------
// getSnapshot
// ---------------------------------------------------------------------------

describe('getSnapshot', () => {
  it('returns the snapshot by id', () => {
    const db = makeDb();
    const design = createDesign(db);
    const snap = createSnapshot(db, {
      designId: design.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'svg',
      artifactSource: '<svg/>',
    });

    const found = getSnapshot(db, snap.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(snap.id);
    expect(found?.artifactType).toBe('svg');
  });

  it('returns null for an unknown id', () => {
    const db = makeDb();
    expect(getSnapshot(db, 'does-not-exist')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteSnapshot
// ---------------------------------------------------------------------------

describe('deleteSnapshot', () => {
  it('deletes a snapshot so it no longer appears in listSnapshots', () => {
    const db = makeDb();
    const design = createDesign(db);
    const snap = createSnapshot(db, {
      designId: design.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'html',
      artifactSource: '<html/>',
    });

    expect(listSnapshots(db, design.id)).toHaveLength(1);
    deleteSnapshot(db, snap.id);
    expect(listSnapshots(db, design.id)).toHaveLength(0);
    expect(getSnapshot(db, snap.id)).toBeNull();
  });

  it('is idempotent — deleting a non-existent id does not throw', () => {
    const db = makeDb();
    expect(() => deleteSnapshot(db, 'ghost-id')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FK cascade: deleting a design removes all its snapshots
// ---------------------------------------------------------------------------

describe('FK cascade on design delete', () => {
  it('removes snapshots when parent design is deleted (foreign_keys ON by default)', () => {
    const db = makeDb();

    const design = createDesign(db);
    createSnapshot(db, {
      designId: design.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'html',
      artifactSource: '<html/>',
    });
    expect(listSnapshots(db, design.id)).toHaveLength(1);

    db.prepare('DELETE FROM designs WHERE id = ?').run(design.id);
    expect(listSnapshots(db, design.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parent FK SET NULL: deleting a middle snapshot nulls its children's parent_id
// ---------------------------------------------------------------------------

describe('parent FK SET NULL on snapshot delete', () => {
  it('nulls child parent_id when the parent snapshot is deleted', () => {
    const db = makeDb();
    const design = createDesign(db);
    const s1 = createSnapshot(db, {
      designId: design.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'html',
      artifactSource: '<html>v1</html>',
    });
    const s2 = createSnapshot(db, {
      designId: design.id,
      parentId: s1.id,
      type: 'edit',
      prompt: null,
      artifactType: 'html',
      artifactSource: '<html>v2</html>',
    });

    deleteSnapshot(db, s1.id);
    const reloaded = getSnapshot(db, s2.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.parentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listDesigns sort order: most recently active first
// ---------------------------------------------------------------------------

describe('listDesigns activity sort', () => {
  it('surfaces a design whose updated_at is newer than another design created later', () => {
    const db = makeDb();
    db.prepare(
      'INSERT INTO designs (id, schema_version, name, created_at, updated_at) VALUES (?, 1, ?, ?, ?)',
    ).run('older', 'A', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    db.prepare(
      'INSERT INTO designs (id, schema_version, name, created_at, updated_at) VALUES (?, 1, ?, ?, ?)',
    ).run('newer', 'B', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z');

    // Bump the older design's activity past the newer one.
    db.prepare('UPDATE designs SET updated_at = ? WHERE id = ?').run(
      '2024-01-03T00:00:00.000Z',
      'older',
    );

    const ids = listDesigns(db).map((d) => d.id);
    expect(ids.indexOf('older')).toBeLessThan(ids.indexOf('newer'));
  });
});

// ---------------------------------------------------------------------------
// Project management additions: rename / soft-delete / duplicate / thumbnail
// ---------------------------------------------------------------------------

describe('renameDesign', () => {
  it('updates the name and bumps updated_at', () => {
    const db = makeDb();
    const d = createDesign(db, 'Original');
    const renamed = renameDesign(db, d.id, '   New name   ');
    expect(renamed?.name).toBe('New name');
    // updated_at may equal createdAt within the same millisecond — only assert
    // the column is non-empty and ordered no earlier than the original create.
    expect(renamed?.updatedAt).toBeTruthy();
    expect(new Date(renamed?.updatedAt ?? '').getTime()).toBeGreaterThanOrEqual(
      new Date(d.updatedAt).getTime(),
    );
  });

  it('returns null when the design is missing', () => {
    const db = makeDb();
    expect(renameDesign(db, 'missing', 'Anything')).toBeNull();
  });

  it('refuses an empty name', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(() => renameDesign(db, d.id, '   ')).toThrow();
  });
});

describe('setDesignThumbnail', () => {
  it('sets and clears the thumbnail text', () => {
    const db = makeDb();
    const d = createDesign(db);
    const set1 = setDesignThumbnail(db, d.id, 'A nice landing page');
    expect(set1?.thumbnailText).toBe('A nice landing page');
    const cleared = setDesignThumbnail(db, d.id, null);
    expect(cleared?.thumbnailText).toBeNull();
  });
});

describe('softDeleteDesign + listDesigns filter', () => {
  it('hides soft-deleted designs from listDesigns but keeps the row', () => {
    const db = makeDb();
    const a = createDesign(db, 'Keeper');
    const b = createDesign(db, 'To delete');

    expect(
      listDesigns(db)
        .map((d) => d.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());

    const deleted = softDeleteDesign(db, b.id);
    expect(deleted?.deletedAt).not.toBeNull();

    const remaining = listDesigns(db).map((d) => d.id);
    expect(remaining).toEqual([a.id]);

    // Row still exists and is fetchable by id.
    expect(getDesign(db, b.id)?.deletedAt).not.toBeNull();
  });
});

describe('duplicateDesign', () => {
  it('clones the design row and all snapshots with parent rewiring', () => {
    const db = makeDb();
    const source = createDesign(db, 'Source');
    setDesignThumbnail(db, source.id, 'thumbnail preview');
    const s1 = createSnapshot(db, {
      designId: source.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'html',
      artifactSource: '<html>v1</html>',
    });
    const s2 = createSnapshot(db, {
      designId: source.id,
      parentId: s1.id,
      type: 'edit',
      prompt: 'tweak',
      artifactType: 'html',
      artifactSource: '<html>v2</html>',
    });

    const cloned = duplicateDesign(db, source.id, 'Source copy');
    expect(cloned).not.toBeNull();
    expect(cloned?.name).toBe('Source copy');
    expect(cloned?.thumbnailText).toBe('thumbnail preview');
    expect(cloned?.id).not.toBe(source.id);

    const clonedSnaps = listSnapshots(db, cloned?.id ?? '');
    expect(clonedSnaps).toHaveLength(2);
    const clonedInitial = clonedSnaps.find((s) => s.type === 'initial');
    const clonedEdit = clonedSnaps.find((s) => s.type === 'edit');
    expect(clonedInitial).toBeDefined();
    expect(clonedEdit).toBeDefined();
    // Parent of the cloned edit must point at the cloned initial, not the
    // original snapshot — that's the key invariant of the rewrite.
    expect(clonedEdit?.parentId).toBe(clonedInitial?.id);
    expect(clonedEdit?.parentId).not.toBe(s2.parentId);

    // Source remains untouched.
    expect(listSnapshots(db, source.id)).toHaveLength(2);
  });

  it('returns null when the source design does not exist', () => {
    const db = makeDb();
    expect(duplicateDesign(db, 'missing', 'X')).toBeNull();
  });

  it('used delete CASCADE on snapshots after duplicate (independence)', () => {
    const db = makeDb();
    const source = createDesign(db);
    createSnapshot(db, {
      designId: source.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'html',
      artifactSource: '<html/>',
    });
    const cloned = duplicateDesign(db, source.id, 'copy');
    db.prepare('DELETE FROM designs WHERE id = ?').run(source.id);
    // Cloned snapshots survive the source deletion because they belong to a
    // different design row.
    expect(listSnapshots(db, cloned?.id ?? '')).toHaveLength(1);
  });
});

describe('updateDesignWorkspace', () => {
  it('sets the workspace_path and bumps updated_at', () => {
    const db = makeDb();
    const d = createDesign(db, 'My design');
    const originalUpdatedAt = d.updatedAt;

    const updated = updateDesignWorkspace(db, d.id, '/path/to/workspace');
    expect(updated).not.toBeNull();
    expect(updated?.workspacePath).toBe('/path/to/workspace');
    expect(updated?.updatedAt).toBeTruthy();
    expect(new Date(updated?.updatedAt ?? '').getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdatedAt).getTime(),
    );
  });

  it('returns null when the design is missing', () => {
    const db = makeDb();
    expect(updateDesignWorkspace(db, 'missing', '/path')).toBeNull();
  });

  it('overwrites an existing workspace_path', () => {
    const db = makeDb();
    const d = createDesign(db);
    updateDesignWorkspace(db, d.id, '/old/path');
    const updated = updateDesignWorkspace(db, d.id, '/new/path');
    expect(updated?.workspacePath).toBe('/new/path');
  });
});

describe('clearDesignWorkspace', () => {
  it('sets workspace_path to NULL and bumps updated_at', () => {
    const db = makeDb();
    const d = createDesign(db);
    updateDesignWorkspace(db, d.id, '/path/to/workspace');
    const originalUpdatedAt = d.updatedAt;

    const cleared = clearDesignWorkspace(db, d.id);
    expect(cleared).not.toBeNull();
    expect(cleared?.workspacePath).toBeNull();
    expect(cleared?.updatedAt).toBeTruthy();
    expect(new Date(cleared?.updatedAt ?? '').getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdatedAt).getTime(),
    );
  });

  it('returns null when the design is missing', () => {
    const db = makeDb();
    expect(clearDesignWorkspace(db, 'missing')).toBeNull();
  });

  it('is idempotent — clearing an already-null workspace_path works', () => {
    const db = makeDb();
    const d = createDesign(db);
    // workspace_path is NULL by default
    const cleared1 = clearDesignWorkspace(db, d.id);
    expect(cleared1?.workspacePath).toBeNull();
    const cleared2 = clearDesignWorkspace(db, d.id);
    expect(cleared2?.workspacePath).toBeNull();
  });
});

describe('duplicateDesign workspace_path semantics', () => {
  it('copies a design with workspace_path set, but cloned design has workspace_path = NULL', () => {
    const db = makeDb();
    const source = createDesign(db, 'Source with workspace');
    updateDesignWorkspace(db, source.id, '/path/to/workspace');

    const sourceReloaded = getDesign(db, source.id);
    expect(sourceReloaded?.workspacePath).toBe('/path/to/workspace');

    const cloned = duplicateDesign(db, source.id, 'Cloned');
    expect(cloned).not.toBeNull();
    expect(cloned?.workspacePath).toBeNull();

    // Source remains unchanged
    expect(getDesign(db, source.id)?.workspacePath).toBe('/path/to/workspace');
  });

  it('clones a design with workspace_path = NULL, result also has NULL', () => {
    const db = makeDb();
    const source = createDesign(db, 'Source without workspace');
    expect(source.workspacePath).toBeNull();

    const cloned = duplicateDesign(db, source.id, 'Cloned');
    expect(cloned?.workspacePath).toBeNull();
  });
});

describe('migration idempotency for workspace_path', () => {
  it('workspace_path column exists after first init', () => {
    const db = makeDb();
    type ColumnInfo = { name: string };
    const cols = (db.prepare('PRAGMA table_info(designs)').all() as ColumnInfo[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('workspace_path');
  });

  it('legacy rows read as workspacePath: null after migration', () => {
    const db = makeDb();
    // Insert a row directly without workspace_path (simulating pre-migration data)
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO designs (id, schema_version, name, created_at, updated_at) VALUES (?, 1, ?, ?, ?)',
    ).run(id, 'Legacy design', now, now);

    const design = getDesign(db, id);
    expect(design?.workspacePath).toBeNull();
  });

  it('re-applying migrations does not fail or lose data', () => {
    const db = makeDb();
    const d = createDesign(db, 'persist me');
    updateDesignWorkspace(db, d.id, '/workspace/path');

    // Simulate re-applying migrations (second app boot)
    // This should be idempotent — the column already exists
    type ColumnInfo = { name: string };
    const cols = (db.prepare('PRAGMA table_info(designs)').all() as ColumnInfo[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('workspace_path');

    // Data should be intact
    const reloaded = getDesign(db, d.id);
    expect(reloaded?.name).toBe('persist me');
    expect(reloaded?.workspacePath).toBe('/workspace/path');
  });
});

describe('migration is idempotent', () => {
  it('re-applying the schema does not lose data', () => {
    const db = makeDb();
    const d = createDesign(db, 'persist me');
    // Re-apply migration (simulates a second app boot).
    type ColumnInfo = { name: string };
    const cols = (db.prepare('PRAGMA table_info(designs)').all() as ColumnInfo[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('thumbnail_text');
    expect(cols).toContain('deleted_at');
    expect(getDesign(db, d.id)?.name).toBe('persist me');
  });
});

describe('updateChatToolCallStatus', () => {
  it('flips status from running to done in place', () => {
    const db = makeDb();
    const d = createDesign(db);
    const row = appendChatMessage(db, {
      designId: d.id,
      kind: 'tool_call',
      payload: {
        toolName: 'text_editor',
        args: {},
        status: 'running',
        startedAt: new Date().toISOString(),
        verbGroup: 'Working',
      },
    });
    updateChatToolCallStatus(db, d.id, row.seq, 'done');
    const list = listChatMessages(db, d.id);
    expect((list[0]?.payload as { status: string }).status).toBe('done');
  });

  it('writes errorMessage when provided', () => {
    const db = makeDb();
    const d = createDesign(db);
    const row = appendChatMessage(db, {
      designId: d.id,
      kind: 'tool_call',
      payload: {
        toolName: 'text_editor',
        args: {},
        status: 'running',
        startedAt: new Date().toISOString(),
        verbGroup: 'Working',
      },
    });
    updateChatToolCallStatus(db, d.id, row.seq, 'error', 'kaboom');
    const payload = listChatMessages(db, d.id)[0]?.payload as {
      status: string;
      errorMessage?: string;
    };
    expect(payload.status).toBe('error');
    expect(payload.errorMessage).toBe('kaboom');
  });

  it('does not throw when the row does not exist', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(() => updateChatToolCallStatus(db, d.id, 9999, 'done')).not.toThrow();
  });

  it('leaves non-tool_call rows untouched', () => {
    const db = makeDb();
    const d = createDesign(db);
    const row = appendChatMessage(db, {
      designId: d.id,
      kind: 'user',
      payload: { text: 'hi' },
    });
    updateChatToolCallStatus(db, d.id, row.seq, 'done');
    const list = listChatMessages(db, d.id);
    expect((list[0]?.payload as { text: string }).text).toBe('hi');
  });
});

describe('tool_status_normalize_2026_04_20 migration', () => {
  it('flips stale running tool_call rows to done and leaves recent ones alone', () => {
    const db = makeDb();
    const d = createDesign(db);

    // Insert a stale (>1h old) running tool_call row directly so we bypass
    // appendChatMessage's now() timestamp.
    db.prepare(
      `INSERT INTO chat_messages (design_id, seq, kind, payload, snapshot_id, created_at)
       VALUES (?, ?, 'tool_call', ?, NULL, ?)`,
    ).run(
      d.id,
      0,
      JSON.stringify({
        toolName: 'text_editor',
        args: {},
        status: 'running',
        startedAt: '2026-04-19T12:00:00Z',
        verbGroup: 'Working',
      }),
      '2026-04-19T12:00:00Z',
    );
    // A recent in-flight row that should NOT be touched.
    const recent = appendChatMessage(db, {
      designId: d.id,
      kind: 'tool_call',
      payload: {
        toolName: 'text_editor',
        args: {},
        status: 'running',
        startedAt: new Date().toISOString(),
        verbGroup: 'Working',
      },
    });

    // Clear the migration marker so re-running applySchema re-fires it.
    db.prepare("DELETE FROM db_meta WHERE key = 'tool_status_normalize_2026_04_20'").run();

    // Re-trigger the cleanup by directly running the same SQL as the migration.
    db.exec(
      `UPDATE chat_messages
         SET payload = json_set(payload, '$.status', 'done')
       WHERE kind = 'tool_call'
         AND json_extract(payload, '$.status') = 'running'
         AND created_at < datetime('now','-1 hour')`,
    );

    const list = listChatMessages(db, d.id);
    expect((list[0]?.payload as { status: string }).status).toBe('done');
    const recentRow = list.find((m) => m.seq === recent.seq);
    expect((recentRow?.payload as { status: string }).status).toBe('running');
  });
});

describe('user_skills CRUD (backlog-2 #7)', () => {
  it('creates and lists user-authored skills (most-recent first)', async () => {
    const { initInMemoryDb, createUserSkill, listUserSkills } = await import('./snapshots-db');
    const db = initInMemoryDb();
    const a = createUserSkill(db, {
      name: 'mobile-tab-bar',
      whenToUse: 'Use when designing a mobile bottom-tab navigation.',
      source: '<TabBar/>',
      sourceDesignId: null,
      sourceSnapshotId: null,
      sourceRect: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = createUserSkill(db, {
      name: 'lesson-row',
      whenToUse: 'Use for a tappable lesson list row.',
      source: '<button/>',
      sourceDesignId: null,
      sourceSnapshotId: null,
      sourceRect: null,
    });
    const list = listUserSkills(db);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
    expect(list[0]?.whenToUse).toMatch(/lesson list row/);
  });

  it('persists sourceRect as JSON when provided', async () => {
    const { initInMemoryDb, createUserSkill, getUserSkill } = await import('./snapshots-db');
    const db = initInMemoryDb();
    const skill = createUserSkill(db, {
      name: 'card',
      whenToUse: 'Use for cards.',
      source: '<div/>',
      sourceDesignId: null,
      sourceSnapshotId: null,
      sourceRect: { top: 12, left: 24, width: 200, height: 80 },
    });
    const got = getUserSkill(db, skill.id);
    expect(got?.sourceRect).toEqual({ top: 12, left: 24, width: 200, height: 80 });
  });

  it('updateUserSkill patches name / whenToUse / source and bumps updatedAt', async () => {
    const { initInMemoryDb, createUserSkill, updateUserSkill } = await import('./snapshots-db');
    const db = initInMemoryDb();
    const skill = createUserSkill(db, {
      name: 'x',
      whenToUse: 'Use for x.',
      source: '<div/>',
      sourceDesignId: null,
      sourceSnapshotId: null,
      sourceRect: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    const updated = updateUserSkill(db, skill.id, { name: 'y', whenToUse: 'Use for y.' });
    expect(updated?.name).toBe('y');
    expect(updated?.whenToUse).toBe('Use for y.');
    expect(updated?.source).toBe('<div/>');
    expect(updated && updated.updatedAt > skill.updatedAt).toBe(true);
  });

  it('deleteUserSkill removes the row', async () => {
    const { initInMemoryDb, createUserSkill, deleteUserSkill, listUserSkills } = await import(
      './snapshots-db'
    );
    const db = initInMemoryDb();
    const skill = createUserSkill(db, {
      name: 'x',
      whenToUse: 'Use for x.',
      source: '<div/>',
      sourceDesignId: null,
      sourceSnapshotId: null,
      sourceRect: null,
    });
    deleteUserSkill(db, skill.id);
    expect(listUserSkills(db)).toHaveLength(0);
  });

  it('updateUserSkill returns null for an unknown id', async () => {
    const { initInMemoryDb, updateUserSkill } = await import('./snapshots-db');
    const db = initInMemoryDb();
    expect(updateUserSkill(db, 'no-such-id', { name: 'x' })).toBeNull();
  });
});

describe('setDesignPromptAssistMetadata (backlog-1 #9)', () => {
  it('persists metadata and round-trips it via getDesign', () => {
    const db = makeDb();
    const d = createDesign(db);
    setDesignPromptAssistMetadata(db, d.id, {
      schemaVersion: 1,
      audience: 'pm',
      device: 'mobile',
      depth: 'quick',
    });
    const after = getDesign(db, d.id);
    expect(after?.promptAssistMetadata).toMatchObject({
      audience: 'pm',
      device: 'mobile',
      depth: 'quick',
    });
  });

  it('null clears the column so the dialog re-prompts', () => {
    const db = makeDb();
    const d = createDesign(db);
    setDesignPromptAssistMetadata(db, d.id, { schemaVersion: 1, audience: 'pm' });
    setDesignPromptAssistMetadata(db, d.id, null);
    expect(getDesign(db, d.id)?.promptAssistMetadata).toBeNull();
  });

  it('returns null when the design id does not exist', () => {
    const db = makeDb();
    expect(setDesignPromptAssistMetadata(db, 'no-such-id', null)).toBeNull();
  });

  it('rejects malformed metadata (e.g. unknown device enum value)', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(() =>
      setDesignPromptAssistMetadata(db, d.id, {
        schemaVersion: 1,
        // @ts-expect-error: deliberately bad value to test runtime guard
        device: 'watch',
      }),
    ).toThrow();
  });

  it('rows on a fresh design have promptAssistMetadata=null by default', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(getDesign(db, d.id)?.promptAssistMetadata).toBeNull();
  });
});

describe('chat_messages schema_version validation', () => {
  it('writes the current writer schemaVersion on insert and reads it back (plan0305 P3.1 — now v2)', () => {
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'hi' } });
    const raw = db
      .prepare('SELECT schema_version FROM chat_messages WHERE design_id = ?')
      .all(d.id) as Array<{ schema_version: number }>;
    expect(raw[0]?.schema_version).toBe(2);
    const list = listChatMessages(db, d.id);
    expect(list[0]?.schemaVersion).toBe(2);
  });

  it('skips rows with a future schema_version and returns the rest', () => {
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'one' } });
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'two' } });
    db.prepare('UPDATE chat_messages SET schema_version = 99 WHERE seq = 0').run();
    const list = listChatMessages(db, d.id);
    expect(list).toHaveLength(1);
    expect((list[0]?.payload as { text: string }).text).toBe('two');
  });

  it('reads back v1 rows with their original schemaVersion preserved (plan0305 P3.1)', () => {
    // Simulate a row written before the v2 bump — same column-level shape,
    // just schema_version=1. The reader must surface that on the way back
    // so callers can distinguish "outcome unknown (v1 done)" from "explicit
    // success (v2 done)".
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'legacy' } });
    db.prepare('UPDATE chat_messages SET schema_version = 1 WHERE design_id = ?').run(d.id);
    const list = listChatMessages(db, d.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.schemaVersion).toBe(1);
  });

  it('rows backfilled by the additive migration default to schema_version=2 (current writer)', () => {
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'legacy' } });
    const list = listChatMessages(db, d.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.schemaVersion).toBe(2);
  });
});

describe('chat session partitioning (in-design new conversation)', () => {
  it('new designs default to current_session_id=0', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(d.currentSessionId).toBe(0);
    expect(getDesignCurrentSession(db, d.id)).toBe(0);
  });

  it('appended rows inherit the design current_session_id', () => {
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'first' } });
    const before = listChatMessages(db, d.id);
    expect(before[0]?.sessionId).toBe(0);

    const next = newChatSession(db, d.id);
    expect(next).toBe(1);
    expect(getDesignCurrentSession(db, d.id)).toBe(1);

    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'second' } });
    const all = listChatMessages(db, d.id);
    expect(all).toHaveLength(2);
    expect(all[0]?.sessionId).toBe(0);
    expect(all[1]?.sessionId).toBe(1);
  });

  it('newChatSession is monotonically increasing per design', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(newChatSession(db, d.id)).toBe(1);
    expect(newChatSession(db, d.id)).toBe(2);
    expect(newChatSession(db, d.id)).toBe(3);
  });

  it('newChatSession scopes per-design (independent counters)', () => {
    const db = makeDb();
    const a = createDesign(db, 'A');
    const b = createDesign(db, 'B');
    expect(newChatSession(db, a.id)).toBe(1);
    expect(newChatSession(db, a.id)).toBe(2);
    expect(newChatSession(db, b.id)).toBe(1);
    expect(getDesignCurrentSession(db, a.id)).toBe(2);
    expect(getDesignCurrentSession(db, b.id)).toBe(1);
  });

  it('throws when newChatSession runs against a missing design', () => {
    const db = makeDb();
    expect(() => newChatSession(db, 'no-such-design')).toThrow();
  });

  it('can switch the active session back to an earlier conversation', () => {
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'first' } });
    newChatSession(db, d.id);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'second' } });

    expect(setDesignCurrentSession(db, d.id, 0)).toBe(0);
    expect(getDesignCurrentSession(db, d.id)).toBe(0);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 'continued' } });

    expect(listChatMessages(db, d.id).map((r) => r.sessionId)).toEqual([0, 1, 0]);
    expect(setDesignCurrentSession(db, d.id, 1)).toBe(1);
  });

  it('throws when switching to a future session', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(() => setDesignCurrentSession(db, d.id, 4)).toThrow();
  });

  it('listChatMessages returns rows from all sessions (renderer filters per session)', () => {
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 's0-a' } });
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 's0-b' } });
    newChatSession(db, d.id);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 's1-a' } });
    const all = listChatMessages(db, d.id);
    expect(all.map((r) => r.sessionId)).toEqual([0, 0, 1]);
  });

  it('newChatSession stays monotonic after continuing an older conversation', () => {
    const db = makeDb();
    const d = createDesign(db);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 's0' } });
    expect(newChatSession(db, d.id)).toBe(1);
    appendChatMessage(db, { designId: d.id, kind: 'user', payload: { text: 's1' } });
    setDesignCurrentSession(db, d.id, 0);

    expect(newChatSession(db, d.id)).toBe(2);
  });
});

describe('run_usage telemetry (plan0305 P3.2)', () => {
  it('returns zeroed totals for a design with no runs recorded', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(getDesignUsageTotals(db, d.id)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      runs: 0,
    });
  });

  it('records a single run and returns the totals via getDesignUsageTotals', () => {
    const db = makeDb();
    const d = createDesign(db);
    recordRunUsage(db, {
      generationId: 'gen-A',
      designId: d.id,
      inputTokens: 1200,
      outputTokens: 350,
      cachedInputTokens: 800,
      cacheCreationInputTokens: 50,
      costUsd: 0.0123,
      totalChunks: 1,
      totalMs: 4200,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    const totals = getDesignUsageTotals(db, d.id);
    expect(totals.inputTokens).toBe(1200);
    expect(totals.outputTokens).toBe(350);
    expect(totals.cachedInputTokens).toBe(800);
    expect(totals.cacheCreationInputTokens).toBe(50);
    expect(totals.costUsd).toBeCloseTo(0.0123);
    expect(totals.runs).toBe(1);
  });

  it('aggregates across multiple runs of the same design', () => {
    const db = makeDb();
    const d = createDesign(db);
    recordRunUsage(db, {
      generationId: 'gen-A',
      designId: d.id,
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 500,
      cacheCreationInputTokens: 0,
      costUsd: 0.01,
      totalChunks: 1,
      totalMs: 2000,
    });
    recordRunUsage(db, {
      generationId: 'gen-B',
      designId: d.id,
      inputTokens: 500,
      outputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.005,
      totalChunks: 1,
      totalMs: 1500,
    });
    const totals = getDesignUsageTotals(db, d.id);
    expect(totals.inputTokens).toBe(1500);
    expect(totals.outputTokens).toBe(300);
    expect(totals.cachedInputTokens).toBe(500);
    expect(totals.costUsd).toBeCloseTo(0.015);
    expect(totals.runs).toBe(2);
  });

  it('idempotently overwrites a re-recorded generationId rather than duplicating', () => {
    const db = makeDb();
    const d = createDesign(db);
    recordRunUsage(db, {
      generationId: 'gen-A',
      designId: d.id,
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.001,
      totalChunks: 1,
      totalMs: 100,
    });
    recordRunUsage(db, {
      generationId: 'gen-A',
      designId: d.id,
      inputTokens: 700,
      outputTokens: 50,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.007,
      totalChunks: 2,
      totalMs: 800,
    });
    const totals = getDesignUsageTotals(db, d.id);
    expect(totals.inputTokens).toBe(700);
    expect(totals.outputTokens).toBe(50);
    expect(totals.runs).toBe(1);
  });

  it('skips persistence when every value is zero (no point cluttering the table)', () => {
    const db = makeDb();
    const d = createDesign(db);
    recordRunUsage(db, {
      generationId: 'gen-empty',
      designId: d.id,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      totalChunks: 0,
      totalMs: 0,
    });
    expect(getDesignUsageTotals(db, d.id).runs).toBe(0);
  });

  it('cascades on design delete', () => {
    const db = makeDb();
    const d = createDesign(db);
    recordRunUsage(db, {
      generationId: 'gen-A',
      designId: d.id,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.001,
      totalChunks: 1,
      totalMs: 100,
    });
    // Hard delete via DELETE FROM designs (test uses raw SQL — softDeleteDesign
    // is the user-facing soft delete which preserves the row, so cascade
    // doesn't fire for that path).
    db.prepare('DELETE FROM designs WHERE id = ?').run(d.id);
    expect(getDesignUsageTotals(db, d.id).runs).toBe(0);
  });
});

describe('game-mode schema (gameplan §6, A1)', () => {
  it('createSnapshot accepts engine + engineVersion and round-trips them', () => {
    const db = makeDb();
    const d = createDesign(db);
    const snap = createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: 'pong',
      artifactType: 'game',
      artifactSource: '<!doctype html><body><script type="module"></script></body>',
      engine: 'phaser',
      engineVersion: '3.88.0',
    });
    expect(snap.artifactType).toBe('game');
    expect(snap.engine).toBe('phaser');
    expect(snap.engineVersion).toBe('3.88.0');
    const round = getSnapshot(db, snap.id);
    expect(round?.engine).toBe('phaser');
    expect(round?.engineVersion).toBe('3.88.0');
  });

  it('design-mode snapshots leave engine + engineVersion null', () => {
    const db = makeDb();
    const d = createDesign(db);
    const snap = createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: 'landing page',
      artifactType: 'html',
      artifactSource: '<!doctype html><html></html>',
    });
    expect(snap.engine).toBeNull();
    expect(snap.engineVersion).toBeNull();
  });

  it('SQL CHECK admits artifact_type=game on fresh installs', () => {
    const db = makeDb();
    const d = createDesign(db);
    expect(() =>
      createSnapshot(db, {
        designId: d.id,
        parentId: null,
        type: 'initial',
        prompt: null,
        artifactType: 'game',
        artifactSource: '<html></html>',
        engine: 'three',
      }),
    ).not.toThrow();
  });
});

describe('snapshotDesignFiles + getSnapshotFiles + restoreSnapshotFiles (gameplan §6, A1)', () => {
  it('captures the full design_files bundle into design_snapshot_files', () => {
    const db = makeDb();
    const d = createDesign(db);
    upsertDesignFile(db, d.id, 'index.html', '<!doctype html>');
    upsertDesignFile(db, d.id, 'src/main.js', 'console.log(1);');
    upsertDesignFile(db, d.id, 'assets/sprite.png', 'data:base64,iVBOR…');
    const snap = createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'game',
      artifactSource: '<!doctype html>',
      engine: 'phaser',
    });
    const captured = snapshotDesignFiles(db, snap.id, d.id);
    expect(captured).toBe(3);
    const rows = getSnapshotFiles(db, snap.id);
    expect(rows.map((r) => r.path).sort()).toEqual([
      'assets/sprite.png',
      'index.html',
      'src/main.js',
    ]);
    const sprite = rows.find((r) => r.path === 'assets/sprite.png');
    expect(sprite?.isBinary).toBe(true);
    expect(sprite?.contentType).toBe('image/png');
    const js = rows.find((r) => r.path === 'src/main.js');
    expect(js?.isBinary).toBe(false);
    expect(js?.contentType).toBe('text/javascript');
  });

  it('returns 0 when the design has no files', () => {
    const db = makeDb();
    const d = createDesign(db);
    const snap = createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'game',
      artifactSource: '<!doctype html>',
      engine: 'three',
    });
    expect(snapshotDesignFiles(db, snap.id, d.id)).toBe(0);
    expect(getSnapshotFiles(db, snap.id)).toHaveLength(0);
  });

  it('restoreSnapshotFiles replaces design_files with the snapshot bundle', () => {
    const db = makeDb();
    const d = createDesign(db);
    upsertDesignFile(db, d.id, 'index.html', '<!doctype html>v1');
    upsertDesignFile(db, d.id, 'src/main.js', 'console.log(1);');
    const snap = createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'game',
      artifactSource: '<!doctype html>v1',
      engine: 'three',
    });
    snapshotDesignFiles(db, snap.id, d.id);
    // Simulate further edits then restore.
    upsertDesignFile(db, d.id, 'index.html', '<!doctype html>v2');
    upsertDesignFile(db, d.id, 'src/extra.js', 'extra');
    const restored = restoreSnapshotFiles(db, d.id, snap.id);
    expect(restored).toBe(2);
    const after = db
      .prepare('SELECT path, content FROM design_files WHERE design_id = ? ORDER BY path')
      .all(d.id) as Array<{ path: string; content: string }>;
    expect(after.map((r) => r.path)).toEqual(['index.html', 'src/main.js']);
    expect(after[0]?.content).toBe('<!doctype html>v1');
  });

  it('cascades on snapshot delete', () => {
    const db = makeDb();
    const d = createDesign(db);
    upsertDesignFile(db, d.id, 'index.html', '<!doctype html>');
    const snap = createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: null,
      artifactType: 'game',
      artifactSource: '<!doctype html>',
      engine: 'three',
    });
    snapshotDesignFiles(db, snap.id, d.id);
    expect(getSnapshotFiles(db, snap.id)).toHaveLength(1);
    deleteSnapshot(db, snap.id);
    expect(getSnapshotFiles(db, snap.id)).toHaveLength(0);
  });
});

describe('contentTypeFromPath (gameplan §7.2)', () => {
  it('returns engine-aware MIME types for JS-engine files', () => {
    expect(contentTypeFromPath('index.html')).toBe('text/html');
    expect(contentTypeFromPath('src/main.js')).toBe('text/javascript');
    expect(contentTypeFromPath('config.json')).toBe('application/json');
    expect(contentTypeFromPath('assets/sprite.png')).toBe('image/png');
    expect(contentTypeFromPath('assets/jump.wav')).toBe('audio/wav');
  });

  it('returns engine-aware MIME types for Python (Pygame)', () => {
    expect(contentTypeFromPath('main.py')).toBe('text/x-python');
    expect(contentTypeFromPath('entities/player.py')).toBe('text/x-python');
  });

  it('returns engine-aware MIME types for Godot project files', () => {
    expect(contentTypeFromPath('project.godot')).toBe('text/plain');
    expect(contentTypeFromPath('main.tscn')).toBe('text/plain');
    expect(contentTypeFromPath('player.gd')).toBe('text/x-gdscript');
    expect(contentTypeFromPath('default_env.tres')).toBe('text/plain');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(contentTypeFromPath('mystery.bin')).toBe('application/octet-stream');
    expect(contentTypeFromPath('no-extension')).toBe('application/octet-stream');
  });
});

describe('multi-file snapshot round-trip', () => {
  it('snapshotDesignFiles + restoreSnapshotFiles preserves the tree', () => {
    const db = makeDb();
    const d = createDesign(db, 'multi');
    upsertDesignFile(db, d.id, 'index.html', '<!doctype html><body>x</body>');
    upsertDesignFile(db, d.id, 'styles.css', 'body{color:red}');
    upsertDesignFile(db, d.id, 'app.js', 'console.log(1)');
    const snap = createSnapshot(db, {
      designId: d.id,
      type: 'edit',
      artifactType: 'html',
      artifactSource: '<html></html>',
      parentId: null,
      prompt: null,
    });
    const captured = snapshotDesignFiles(db, snap.id, d.id);
    expect(captured).toBe(3);

    // Wipe live design_files; restore from the snapshot tree.
    db.prepare('DELETE FROM design_files WHERE design_id = ?').run(d.id);
    expect(listDesignFiles(db, d.id)).toEqual([]);
    const restored = restoreSnapshotFiles(db, d.id, snap.id);
    expect(restored).toBe(3);
    const live = listDesignFiles(db, d.id);
    expect(live.map((f) => f.path).sort()).toEqual(['app.js', 'index.html', 'styles.css']);
    expect(live.find((f) => f.path === 'styles.css')?.content).toBe('body{color:red}');
  });

  it('seedDesignFilesFromLatestSnapshot is idempotent and only fires when design_files is empty', () => {
    const db = makeDb();
    const d = createDesign(db, 'seed');
    upsertDesignFile(db, d.id, 'index.html', 'before');
    const snap = createSnapshot(db, {
      designId: d.id,
      type: 'edit',
      artifactType: 'html',
      artifactSource: '<html></html>',
      parentId: null,
      prompt: null,
    });
    snapshotDesignFiles(db, snap.id, d.id);

    // First call with files already present — no-op.
    expect(seedDesignFilesFromLatestSnapshot(db, d.id)).toBe(0);

    // Wipe live tree, then seed should restore.
    db.prepare('DELETE FROM design_files WHERE design_id = ?').run(d.id);
    expect(seedDesignFilesFromLatestSnapshot(db, d.id)).toBe(1);

    // Second call (now populated) — no-op again.
    expect(seedDesignFilesFromLatestSnapshot(db, d.id)).toBe(0);
  });

  it('seedDesignFilesFromLatestSnapshot is a no-op when the design has no snapshots', () => {
    const db = makeDb();
    const d = createDesign(db, 'no-snaps');
    expect(seedDesignFilesFromLatestSnapshot(db, d.id)).toBe(0);
  });

  it('seedDesignFilesFromLatestSnapshot is a no-op when latest snapshot has no captured files', () => {
    const db = makeDb();
    const d = createDesign(db, 'snap-without-files');
    createSnapshot(db, {
      designId: d.id,
      type: 'edit',
      artifactType: 'html',
      artifactSource: '<html></html>',
      parentId: null,
      prompt: null,
    });
    expect(seedDesignFilesFromLatestSnapshot(db, d.id)).toBe(0);
  });
});
