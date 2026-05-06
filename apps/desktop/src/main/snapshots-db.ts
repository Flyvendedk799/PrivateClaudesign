/**
 * SQLite persistence layer for designs, snapshots, and chat messages.
 *
 * Uses better-sqlite3 (synchronous API — safe in the Electron main process,
 * which is the only caller). WAL mode for concurrent read performance.
 *
 * Call initSnapshotsDb(dbPath) once at app start.
 * Call initInMemoryDb() in tests to get an isolated in-memory instance.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  CHAT_MESSAGE_SCHEMA_VERSION,
  type ChatAppendInput,
  type ChatMessageKind,
  type ChatMessageRow,
  type CommentCreateInput,
  type CommentKind,
  type CommentRect,
  type CommentRow,
  type CommentScope,
  type CommentStatus,
  type CommentUpdateInput,
  type Design,
  type DesignFile,
  type DesignSnapshot,
  type DiagnosticEventInput,
  type DiagnosticEventRow,
  type DiagnosticLevel,
  type PromptAssistMetadata,
  PromptAssistMetadataV1,
  SchemaMismatchError,
  type SnapshotCreateInput,
  type UserSkill,
  type UserSkillCreateInput,
  type UserSkillUpdateInput,
} from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { getLogger } from './logger';

// better-sqlite3 is a native module — require() instead of import.
const require = createRequire(import.meta.url);

type Database = BetterSqlite3.Database;

let singleton: Database | null = null;

/**
 * Resolve the .node binary that matches the active runtime ABI.
 *
 * scripts/install-sqlite-bindings.cjs stages the host Node prebuild plus
 * per-arch Electron prebuilds side by side:
 *   build/Release/better_sqlite3.node-node.node          ← Node 22 (vitest)
 *   build/Release/better_sqlite3.node-electron-x64.node  ← Electron x64 app
 *   build/Release/better_sqlite3.node-electron-arm64.node← Electron arm64 app
 *   build/Release/better_sqlite3.node-electron.node      ← legacy host-arch alias
 * so that one `pnpm install` covers both runtimes without
 * an electron-rebuild step that toggles the single default binary.
 */
export function resolveNativeBindingPath(
  releaseDir: string,
  isElectron = typeof process.versions.electron === 'string',
  arch = process.arch,
): string {
  if (isElectron) {
    const archSpecific = path.join(releaseDir, `better_sqlite3.node-electron-${arch}.node`);
    if (fs.existsSync(archSpecific)) return archSpecific;
  }
  const runtimeSpecific = path.join(
    releaseDir,
    isElectron ? 'better_sqlite3.node-electron.node' : 'better_sqlite3.node-node.node',
  );
  if (fs.existsSync(runtimeSpecific)) return runtimeSpecific;
  if (isElectron) return path.join(releaseDir, 'better_sqlite3.node');
  return runtimeSpecific;
}

function resolveNativeBinding(): string {
  const pkgJson = require.resolve('better-sqlite3/package.json');
  return resolveNativeBindingPath(path.join(path.dirname(pkgJson), 'build', 'Release'));
}

function openDatabase(filename: string, options?: BetterSqlite3.Options): Database {
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  return new Database(filename, { ...options, nativeBinding: resolveNativeBinding() });
}

/** Idempotent schema initializer. Exported for migration tests that
 *  pre-seed a legacy table shape and then assert applySchema upgrades it.
 *  Production callers should prefer `initInMemoryDb` / `initSnapshotsDb`. */
export function applySchema(db: Database): void {
  // foreign_keys is a per-connection pragma and defaults to OFF; enabling it
  // here is what makes the ON DELETE CASCADE / SET NULL clauses below actually fire.
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS designs (
      id            TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      name          TEXT NOT NULL DEFAULT 'Untitled design',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS design_snapshots (
      id             TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      design_id      TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      parent_id      TEXT REFERENCES design_snapshots(id) ON DELETE SET NULL,
      type           TEXT NOT NULL CHECK(type IN ('initial','edit','fork')),
      prompt         TEXT,
      artifact_type  TEXT NOT NULL CHECK(artifact_type IN ('html','react','svg','game')),
      artifact_source TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      message        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_design_created
      ON design_snapshots(design_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS design_messages (
      design_id   TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      ordinal     INTEGER NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (design_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version  INTEGER NOT NULL DEFAULT 1,
      design_id       TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN (
                        'user',
                        'assistant_text',
                        'tool_call',
                        'artifact_delivered',
                        'error',
                        'checkpoint',
                        'reasoning_summary',
                        'continuation_pending'
                      )),
      payload         TEXT NOT NULL,
      snapshot_id     TEXT REFERENCES design_snapshots(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL,
      UNIQUE (design_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_design ON chat_messages(design_id, seq);

    CREATE TABLE IF NOT EXISTS comments (
      id                     TEXT PRIMARY KEY,
      schema_version         INTEGER NOT NULL DEFAULT 1,
      design_id              TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      snapshot_id            TEXT NOT NULL REFERENCES design_snapshots(id) ON DELETE CASCADE,
      kind                   TEXT NOT NULL CHECK (kind IN ('note','edit')),
      selector               TEXT NOT NULL,
      tag                    TEXT NOT NULL,
      outer_html             TEXT NOT NULL,
      rect                   TEXT NOT NULL,
      text                   TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
      created_at             TEXT NOT NULL,
      applied_in_snapshot_id TEXT REFERENCES design_snapshots(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_design_snapshot ON comments(design_id, snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_comments_design_status   ON comments(design_id, status);

    CREATE TABLE IF NOT EXISTS design_files (
      id          TEXT PRIMARY KEY,
      design_id   TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      path        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE (design_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_design_files_design ON design_files(design_id);

    CREATE TABLE IF NOT EXISTS diagnostic_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version  INTEGER NOT NULL DEFAULT 1,
      ts              INTEGER NOT NULL,
      level           TEXT    NOT NULL CHECK (level IN ('info','warn','error')),
      code            TEXT    NOT NULL,
      scope           TEXT    NOT NULL,
      run_id          TEXT,
      fingerprint     TEXT    NOT NULL,
      message         TEXT    NOT NULL,
      stack           TEXT,
      transient       INTEGER NOT NULL DEFAULT 0,
      count           INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_diag_events_ts          ON diagnostic_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_diag_events_fingerprint ON diagnostic_events(fingerprint);

    CREATE TABLE IF NOT EXISTS run_usage (
      generation_id              TEXT PRIMARY KEY,
      schema_version             INTEGER NOT NULL DEFAULT 1,
      design_id                  TEXT REFERENCES designs(id) ON DELETE CASCADE,
      input_tokens               INTEGER NOT NULL DEFAULT 0,
      output_tokens              INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd                   REAL NOT NULL DEFAULT 0,
      implied_cost_usd           REAL NOT NULL DEFAULT 0,
      total_chunks               INTEGER NOT NULL DEFAULT 0,
      total_ms                   INTEGER NOT NULL DEFAULT 0,
      provider                   TEXT,
      model_id                   TEXT,
      created_at                 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_usage_design ON run_usage(design_id, created_at);

    -- Phase 3 — per-tool latency telemetry. Drives the cost & speed
    -- analyses in the Phase 4 work (which tools dominate wall-clock,
    -- which round-trips to fuse). One row per tool_execution_end. The
    -- main-process logger already emits agent.tool_duration to console;
    -- this table promotes it to durable storage so post-hoc analysis
    -- survives an app restart.
    CREATE TABLE IF NOT EXISTS run_tool_durations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version  INTEGER NOT NULL DEFAULT 1,
      generation_id   TEXT NOT NULL,
      design_id       TEXT REFERENCES designs(id) ON DELETE CASCADE,
      tool_name       TEXT NOT NULL,
      tool_call_id    TEXT,
      command         TEXT,
      duration_ms     INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('done','error')),
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_tool_durations_gen
      ON run_tool_durations(generation_id);
    CREATE INDEX IF NOT EXISTS idx_run_tool_durations_tool
      ON run_tool_durations(tool_name);

    -- Backlog-3 §10 — per-design / global budget caps. id='global' for
    -- the catch-all entry; otherwise a designId. Either limit field
    -- may be NULL to mean "no cap". alert_at_pct fires the threshold
    -- toast when cumulative cost crosses the percentage. All
    -- enforcement is informational; we never block a run.
    CREATE TABLE IF NOT EXISTS budgets (
      id                  TEXT PRIMARY KEY,
      schema_version      INTEGER NOT NULL DEFAULT 1,
      daily_limit_usd     REAL,
      per_design_limit_usd REAL,
      alert_at_pct        INTEGER NOT NULL DEFAULT 80,
      updated_at          TEXT NOT NULL
    );

    -- Backlog-3 §10 — daily roll-up of run_usage so the cost
    -- dashboard can render a 7-day sparkline without scanning every
    -- run row. Date is YYYY-MM-DD in local time. Updated by
    -- recordRunUsage at run completion via UPSERT.
    CREATE TABLE IF NOT EXISTS daily_usage (
      date                TEXT PRIMARY KEY,
      schema_version      INTEGER NOT NULL DEFAULT 1,
      cost_usd            REAL NOT NULL DEFAULT 0,
      input_tokens        INTEGER NOT NULL DEFAULT 0,
      output_tokens       INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      run_count           INTEGER NOT NULL DEFAULT 0,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_skills (
      id                 TEXT PRIMARY KEY,
      schema_version     INTEGER NOT NULL DEFAULT 1,
      name               TEXT NOT NULL,
      when_to_use        TEXT NOT NULL,
      source             TEXT NOT NULL,
      source_design_id   TEXT REFERENCES designs(id) ON DELETE SET NULL,
      source_snapshot_id TEXT REFERENCES design_snapshots(id) ON DELETE SET NULL,
      source_rect        TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_skills_updated ON user_skills(updated_at DESC);
  `);

  applyAdditiveMigrations(db);
}

/**
 * Additive column migrations.
 *
 * Each block uses PRAGMA table_info to detect whether the column already
 * exists; SQLite has no IF NOT EXISTS for ADD COLUMN. Safe to run on every
 * boot.
 */
function applyAdditiveMigrations(db: Database): void {
  type ColumnInfo = { name: string };
  const designCols = (db.prepare('PRAGMA table_info(designs)').all() as ColumnInfo[]).map(
    (c) => c.name,
  );
  if (!designCols.includes('thumbnail_text')) {
    db.exec('ALTER TABLE designs ADD COLUMN thumbnail_text TEXT');
  }
  if (!designCols.includes('deleted_at')) {
    db.exec('ALTER TABLE designs ADD COLUMN deleted_at TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_designs_deleted_at ON designs(deleted_at)');
  }
  if (!designCols.includes('workspace_path')) {
    db.exec('ALTER TABLE designs ADD COLUMN workspace_path TEXT');
  }
  // Prompt-assist (backlog-1 #9): per-design constraints captured by the
  // short-prompt interstitial. Nullable; existing rows backfill to NULL
  // (the dialog re-prompts on the next short submission).
  if (!designCols.includes('prompt_assist_metadata')) {
    db.exec('ALTER TABLE designs ADD COLUMN prompt_assist_metadata TEXT');
  }

  // Comments v2 — add scope ('element'|'global') and parent_outer_html for
  // richer prompt enrichment. Both are additive; old rows backfill to
  // scope='element' / parent_outer_html=NULL.
  const commentCols = (db.prepare('PRAGMA table_info(comments)').all() as ColumnInfo[]).map(
    (c) => c.name,
  );
  if (!commentCols.includes('scope')) {
    db.exec("ALTER TABLE comments ADD COLUMN scope TEXT NOT NULL DEFAULT 'element'");
  }
  if (!commentCols.includes('parent_outer_html')) {
    db.exec('ALTER TABLE comments ADD COLUMN parent_outer_html TEXT');
  }

  // chat_messages v1 — schema_version column was added after the table was
  // first created. Backfill existing rows to 1 (the only writer version that
  // has ever produced rows on disk). Future bumps land migration logic in
  // `migrateChatMessageRow`; this column lets the read path catch a row
  // written by a newer install via SchemaMismatchError instead of silently
  // deserialising into the wrong shape.
  const chatCols = (db.prepare('PRAGMA table_info(chat_messages)').all() as ColumnInfo[]).map(
    (c) => c.name,
  );
  if (!chatCols.includes('schema_version')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
  }
  // session_id — partitions a design's chat history into independent
  // conversations. Bumped by `chat:v1:new-session` so the user can drop
  // out of a long thread (memory / token / cache cost) without losing
  // the design itself. Existing rows backfill to 0; new rows inherit
  // the design's `current_session_id`. The history-builder filters to
  // the current session before sending to the LLM, so prior sessions
  // are still visible in the UI but don't pay token cost.
  if (!chatCols.includes('session_id')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN session_id INTEGER NOT NULL DEFAULT 0');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_chat_design_session ON chat_messages(design_id, session_id, seq)',
    );
  }
  // designs.current_session_id — the active session pointer that
  // `appendChatMessage` stamps onto every new row. Bumped by
  // `newChatSession`. Existing designs default to 0 so legacy rows
  // (also session_id=0) remain visible.
  if (!designCols.includes('current_session_id')) {
    db.exec('ALTER TABLE designs ADD COLUMN current_session_id INTEGER NOT NULL DEFAULT 0');
  }

  // diagnostic_events v2 — add `context_json` (TEXT, nullable) so rows from
  // provider errors can persist the full NormalizedProviderError payload
  // (upstream_request_id, upstream_status, retry_count, redacted_body_head).
  // Nullable so existing rows keep working; renderer deserializes JSON when
  // rendering the Report dialog.
  const diagEventCols = (
    db.prepare('PRAGMA table_info(diagnostic_events)').all() as ColumnInfo[]
  ).map((c) => c.name);
  if (!diagEventCols.includes('context_json')) {
    db.exec('ALTER TABLE diagnostic_events ADD COLUMN context_json TEXT');
  }

  // Phase 3 — run_usage v2 schema additions. `implied_cost_usd` lets the
  // budget UI surface a meaningful number for subscription-provider runs
  // where `cost_usd` is $0. Existing rows backfill to 0 — they predate
  // the metric and we don't retroactively recompute (would require the
  // full token shape recall which we have, but historic re-pricing is
  // out of scope for this phase).
  const runUsageCols = (db.prepare('PRAGMA table_info(run_usage)').all() as ColumnInfo[]).map(
    (c) => c.name,
  );
  if (!runUsageCols.includes('implied_cost_usd')) {
    db.exec('ALTER TABLE run_usage ADD COLUMN implied_cost_usd REAL NOT NULL DEFAULT 0');
  }
  // Phase 3 — run_tool_durations table. Per-tool latency telemetry.
  // Idempotent CREATE; tests rely on this being safe to re-apply.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_tool_durations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version  INTEGER NOT NULL DEFAULT 1,
      generation_id   TEXT NOT NULL,
      design_id       TEXT REFERENCES designs(id) ON DELETE CASCADE,
      tool_name       TEXT NOT NULL,
      tool_call_id    TEXT,
      command         TEXT,
      duration_ms     INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('done','error')),
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_tool_durations_gen
      ON run_tool_durations(generation_id);
    CREATE INDEX IF NOT EXISTS idx_run_tool_durations_tool
      ON run_tool_durations(tool_name);
  `);

  // One-shot cleanup: chat_messages rows written before the designId race
  // fixes (commits 2a316b7 / f41d1f8) may carry the wrong design_id and
  // cross-contaminate the Sidebar history. Clear the table once; the next
  // open of any design will re-seed from snapshots with the correct id.
  // Gated by a meta row so it only runs once per install.
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  const flag = db
    .prepare('SELECT value FROM db_meta WHERE key = ?')
    .get('chat_messages_purged_2026_04_20') as { value?: string } | undefined;
  if (flag === undefined) {
    db.exec('DELETE FROM chat_messages');
    db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?)').run(
      'chat_messages_purged_2026_04_20',
      new Date().toISOString(),
    );
  }

  // Phase 2 / 4 — relax chat_messages.kind CHECK to admit the new persisted
  // kinds: 'checkpoint' (Backlog-3 §5; was already written by the renderer
  // but the original CHECK rejected it and the row never reached disk on
  // strict installs), 'reasoning_summary' (Phase 2 — model's adaptive-thinking
  // rollup) and 'continuation_pending' (Phase 4 — first-class continuation
  // signal). SQLite has no ALTER TABLE … MODIFY CONSTRAINT, so we rebuild
  // the table via temporary-swap. Mirrors the design_snapshots pattern
  // already established below. Idempotent — gated on a db_meta marker
  // and a sql-string sniff so a second pass is a no-op.
  const chatKindsV3 = db.prepare('SELECT value FROM db_meta WHERE key = ?').get('chat_kinds_v3') as
    | { value?: string }
    | undefined;
  if (chatKindsV3 === undefined) {
    const sqlRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'")
      .get() as { sql?: string } | undefined;
    const needsRebuild =
      !!sqlRow?.sql &&
      (!sqlRow.sql.includes("'reasoning_summary'") ||
        !sqlRow.sql.includes("'continuation_pending'") ||
        !sqlRow.sql.includes("'checkpoint'"));
    if (needsRebuild) {
      const rebuildChat = db.transaction(() => {
        db.exec(`
          CREATE TABLE chat_messages_new (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            schema_version  INTEGER NOT NULL DEFAULT 1,
            design_id       TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
            seq             INTEGER NOT NULL,
            kind            TEXT NOT NULL CHECK (kind IN (
                              'user',
                              'assistant_text',
                              'tool_call',
                              'artifact_delivered',
                              'error',
                              'checkpoint',
                              'reasoning_summary',
                              'continuation_pending'
                            )),
            payload         TEXT NOT NULL,
            snapshot_id     TEXT REFERENCES design_snapshots(id) ON DELETE SET NULL,
            created_at      TEXT NOT NULL,
            session_id      INTEGER NOT NULL DEFAULT 0,
            UNIQUE (design_id, seq)
          );
          INSERT INTO chat_messages_new
            (id, schema_version, design_id, seq, kind, payload, snapshot_id, created_at, session_id)
            SELECT id, schema_version, design_id, seq, kind, payload, snapshot_id, created_at,
                   COALESCE(session_id, 0)
              FROM chat_messages;
          DROP TABLE chat_messages;
          ALTER TABLE chat_messages_new RENAME TO chat_messages;
          CREATE INDEX IF NOT EXISTS idx_chat_design ON chat_messages(design_id, seq);
          CREATE INDEX IF NOT EXISTS idx_chat_design_session
            ON chat_messages(design_id, session_id, seq);
        `);
      });
      rebuildChat();
    }
    db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?)').run(
      'chat_kinds_v3',
      new Date().toISOString(),
    );
  }

  // One-shot normalization: pre-2026-04-20 builds wrote tool_call rows with
  // status='running' at start time but never updated them when the result
  // event arrived. Anything older than an hour is unreachable — flip it to
  // 'done' so the WorkingCard renderer stops showing a stuck spinner. Newer
  // rows are left alone so an in-flight generation isn't disturbed.
  const toolStatusFlag = db
    .prepare('SELECT value FROM db_meta WHERE key = ?')
    .get('tool_status_normalize_2026_04_20') as { value?: string } | undefined;
  if (toolStatusFlag === undefined) {
    db.exec(
      `UPDATE chat_messages
         SET payload = json_set(payload, '$.status', 'done')
       WHERE kind = 'tool_call'
         AND json_extract(payload, '$.status') = 'running'
         AND created_at < datetime('now','-1 hour')`,
    );
    db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?)').run(
      'tool_status_normalize_2026_04_20',
      new Date().toISOString(),
    );
  }

  // Comments v2 schema bump marker — record once after the new columns are
  // present so future migrations can branch on whether the v1→v2 backfill
  // already ran for this database file.
  const commentsV2 = db
    .prepare('SELECT value FROM db_meta WHERE key = ?')
    .get('comments_schema_v2') as { value?: string } | undefined;
  if (commentsV2 === undefined) {
    // Backfill: existing rows get scope='element' (safe default — same blast
    // radius as before v2) and a NULL parent_outer_html.
    db.exec("UPDATE comments SET scope = 'element' WHERE scope IS NULL OR scope = ''");
    db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?)').run(
      'comments_schema_v2',
      new Date().toISOString(),
    );
  }

  // Game-mode (gameplan §6, A1) — add engine + engine_version columns to
  // design_snapshots and create the design_snapshot_files bundle table.
  // Column adds are pure ALTER; the design_snapshot_files table is gated
  // by a db_meta marker so we only do the CREATE TABLE work once.
  const snapshotCols = (
    db.prepare('PRAGMA table_info(design_snapshots)').all() as ColumnInfo[]
  ).map((c) => c.name);
  if (!snapshotCols.includes('engine')) {
    db.exec('ALTER TABLE design_snapshots ADD COLUMN engine TEXT');
  }
  if (!snapshotCols.includes('engine_version')) {
    db.exec('ALTER TABLE design_snapshots ADD COLUMN engine_version TEXT');
  }

  // The CHECK constraint on artifact_type was 'html'/'react'/'svg' until we
  // added 'game'. SQLite has no ALTER TABLE … MODIFY CONSTRAINT, so an
  // existing DB on disk would reject INSERT WHERE artifact_type='game'.
  // Rebuild the table once via temporary-swap so existing rows survive but
  // the constraint admits the new value. New installs already have the
  // relaxed CHECK from the CREATE TABLE statement above and skip this.
  const snapshotsCheckRelaxed = db
    .prepare('SELECT value FROM db_meta WHERE key = ?')
    .get('snapshots_artifact_type_game_v1') as { value?: string } | undefined;
  if (snapshotsCheckRelaxed === undefined) {
    const sqlRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='design_snapshots'")
      .get() as { sql?: string } | undefined;
    const needsRebuild = !!sqlRow?.sql && !sqlRow.sql.includes("'game'");
    if (needsRebuild) {
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE design_snapshots_new (
            id              TEXT PRIMARY KEY,
            schema_version  INTEGER NOT NULL DEFAULT 1,
            design_id       TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
            parent_id       TEXT REFERENCES design_snapshots_new(id) ON DELETE SET NULL,
            type            TEXT NOT NULL CHECK(type IN ('initial','edit','fork')),
            prompt          TEXT,
            artifact_type   TEXT NOT NULL CHECK(artifact_type IN ('html','react','svg','game')),
            artifact_source TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            message         TEXT,
            engine          TEXT,
            engine_version  TEXT
          );
          INSERT INTO design_snapshots_new
            SELECT id, schema_version, design_id, parent_id, type, prompt,
                   artifact_type, artifact_source, created_at, message,
                   engine, engine_version
              FROM design_snapshots;
          DROP TABLE design_snapshots;
          ALTER TABLE design_snapshots_new RENAME TO design_snapshots;
          CREATE INDEX IF NOT EXISTS idx_snapshots_design_created
            ON design_snapshots(design_id, created_at DESC);
        `);
      });
      rebuild();
    }
    db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?)').run(
      'snapshots_artifact_type_game_v1',
      new Date().toISOString(),
    );
  }

  // design_snapshot_files: snapshot of the multi-file game project bundle so
  // restore can recover the whole tree, not just one HTML blob. Same shape
  // proposed by the prior opengameplan; reused for all four engines.
  const snapshotFilesV1 = db
    .prepare('SELECT value FROM db_meta WHERE key = ?')
    .get('snapshot_files_v1') as { value?: string } | undefined;
  if (snapshotFilesV1 === undefined) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS design_snapshot_files (
        snapshot_id  TEXT NOT NULL REFERENCES design_snapshots(id) ON DELETE CASCADE,
        path         TEXT NOT NULL,
        content      TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/plain',
        is_binary    INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_design_snapshot_files_snapshot
        ON design_snapshot_files(snapshot_id);
    `);
    db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?)').run(
      'snapshot_files_v1',
      new Date().toISOString(),
    );
  }
}

/** Initialize and return the singleton DB instance for production use. */
export function initSnapshotsDb(dbPath: string): Database {
  if (singleton) return singleton;
  const db = openDatabase(dbPath);
  try {
    applySchema(db);
  } catch (cause) {
    // Don't cache a half-open DB — let the next caller retry from scratch.
    try {
      db.close();
    } catch (closeErr) {
      const logger = getLogger('snapshots-db');
      logger.warn('db.init.close_failed', { cause: closeErr });
    }
    throw cause;
  }
  singleton = db;
  return singleton;
}

/**
 * Boot-time wrapper that never throws. Returns either the live DB or the
 * underlying error, so the caller can degrade gracefully without blocking
 * the BrowserWindow from opening when snapshot persistence is unavailable
 * (e.g. corrupt file, permission denied, native binding missing).
 */
export function safeInitSnapshotsDb(
  dbPath: string,
): { ok: true; db: Database } | { ok: false; error: Error } {
  try {
    return { ok: true, db: initSnapshotsDb(dbPath) };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return { ok: false, error };
  }
}

/** For use in Vitest tests only — returns a fresh isolated in-memory instance. */
export function initInMemoryDb(): Database {
  // ':memory:' as filename creates an in-memory database in better-sqlite3.
  const db = openDatabase(':memory:');
  applySchema(db);
  return db;
}

// ---------------------------------------------------------------------------
// Row types (snake_case columns from SQLite)
// ---------------------------------------------------------------------------

interface DesignRow {
  id: string;
  schema_version: number;
  name: string;
  created_at: string;
  updated_at: string;
  thumbnail_text: string | null;
  deleted_at: string | null;
  workspace_path: string | null;
  /** JSON-serialized PromptAssistMetadataV1, or null when the user
   *  skipped/never saw the assist dialog. May be undefined on rows
   *  written before the additive migration backfilled the column. */
  prompt_assist_metadata: string | null | undefined;
  /** In-design new-conversation pointer; absent on rows older than the
   *  session_id migration. Treated as 0 for those rows. */
  current_session_id: number | null | undefined;
}

interface SnapshotRow {
  id: string;
  schema_version: number;
  design_id: string;
  parent_id: string | null;
  type: string;
  prompt: string | null;
  artifact_type: string;
  artifact_source: string;
  created_at: string;
  message: string | null;
  /** gameplan §6 — engine pin (NULL on design-mode snapshots). */
  engine: string | null;
  engine_version: string | null;
}

interface MessageRow {
  design_id: string;
  ordinal: number;
  role: string;
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row → domain type mappers
// ---------------------------------------------------------------------------

function rowToDesign(row: DesignRow): Design {
  let promptAssistMetadata: Design['promptAssistMetadata'] = null;
  if (typeof row.prompt_assist_metadata === 'string' && row.prompt_assist_metadata.length > 0) {
    try {
      const parsed = PromptAssistMetadataV1.parse(JSON.parse(row.prompt_assist_metadata));
      promptAssistMetadata = parsed;
    } catch {
      // Forward-compat / malformed JSON: drop the metadata silently rather
      // than failing the whole design read. The UI re-prompts on the next
      // short-prompt submission if needed.
      promptAssistMetadata = null;
    }
  }
  return {
    schemaVersion: 1,
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    thumbnailText: row.thumbnail_text ?? null,
    deletedAt: row.deleted_at ?? null,
    workspacePath: row.workspace_path ?? null,
    promptAssistMetadata,
    currentSessionId:
      typeof row.current_session_id === 'number' && Number.isFinite(row.current_session_id)
        ? row.current_session_id
        : 0,
  };
}

function rowToSnapshot(row: SnapshotRow): DesignSnapshot {
  return {
    schemaVersion: 1,
    id: row.id,
    designId: row.design_id,
    parentId: row.parent_id,
    type: row.type as DesignSnapshot['type'],
    prompt: row.prompt,
    artifactType: row.artifact_type as DesignSnapshot['artifactType'],
    artifactSource: row.artifact_source,
    createdAt: row.created_at,
    ...(row.message !== null ? { message: row.message } : {}),
    engine: (row.engine as DesignSnapshot['engine']) ?? null,
    engineVersion: row.engine_version ?? null,
  };
}

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

export function createDesign(db: Database, name = 'Untitled design'): Design {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO designs (id, schema_version, name, created_at, updated_at, workspace_path) VALUES (?, 1, ?, ?, ?, NULL)',
  ).run(id, name, now, now);
  return rowToDesign(db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as DesignRow);
}

export function getDesign(db: Database, id: string): Design | null {
  const row = db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as DesignRow | undefined;
  return row ? rowToDesign(row) : null;
}

export function listDesigns(db: Database): Design[] {
  // Soft-deleted designs are hidden from the default list. updated_at bumps on
  // each new snapshot so recently-edited designs surface first; created_at is
  // the tiebreaker for designs that have never been edited.
  return (
    db
      .prepare(
        'SELECT * FROM designs WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC',
      )
      .all() as DesignRow[]
  ).map(rowToDesign);
}

export function renameDesign(db: Database, id: string, name: string): Design | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Design name must not be empty');
  }
  const now = new Date().toISOString();
  const result = db
    .prepare('UPDATE designs SET name = ?, updated_at = ? WHERE id = ?')
    .run(trimmed, now, id);
  if (result.changes === 0) return null;
  return getDesign(db, id);
}

export function setDesignThumbnail(
  db: Database,
  id: string,
  thumbnailText: string | null,
): Design | null {
  const result = db
    .prepare('UPDATE designs SET thumbnail_text = ? WHERE id = ?')
    .run(thumbnailText, id);
  if (result.changes === 0) return null;
  return getDesign(db, id);
}

export function softDeleteDesign(db: Database, id: string): Design | null {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE designs SET deleted_at = ? WHERE id = ?').run(now, id);
  if (result.changes === 0) return null;
  return getDesign(db, id);
}

export function updateDesignWorkspace(
  db: Database,
  id: string,
  workspacePath: string,
): Design | null {
  const now = new Date().toISOString();
  const result = db
    .prepare('UPDATE designs SET workspace_path = ?, updated_at = ? WHERE id = ?')
    .run(workspacePath, now, id);
  if (result.changes === 0) return null;
  return getDesign(db, id);
}

export function clearDesignWorkspace(db: Database, id: string): Design | null {
  const now = new Date().toISOString();
  const result = db
    .prepare('UPDATE designs SET workspace_path = NULL, updated_at = ? WHERE id = ?')
    .run(now, id);
  if (result.changes === 0) return null;
  return getDesign(db, id);
}

/** Persist (or clear) the prompt-assist constraints captured by the
 *  short-prompt interstitial. `null` clears the column so the dialog
 *  re-prompts on the next short submission. */
export function setDesignPromptAssistMetadata(
  db: Database,
  id: string,
  metadata: PromptAssistMetadata | null,
): Design | null {
  const now = new Date().toISOString();
  // Validate before serializing so a malformed payload from a buggy renderer
  // doesn't poison the row. Throws ZodError; the IPC layer surfaces it as
  // IPC_BAD_INPUT.
  const json = metadata === null ? null : JSON.stringify(PromptAssistMetadataV1.parse(metadata));
  const result = db
    .prepare('UPDATE designs SET prompt_assist_metadata = ?, updated_at = ? WHERE id = ?')
    .run(json, now, id);
  if (result.changes === 0) return null;
  return getDesign(db, id);
}

/**
 * Duplicate a design row + all its messages + all its snapshots. Snapshot
 * parent_id references are remapped to point at the freshly-cloned snapshots
 * so the lineage is preserved inside the new design.
 */
export function duplicateDesign(db: Database, sourceId: string, newName: string): Design | null {
  const source = getDesign(db, sourceId);
  if (source === null) return null;

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  const trimmed = newName.trim() || `${source.name} copy`;

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO designs (id, schema_version, name, created_at, updated_at, thumbnail_text, deleted_at, workspace_path) VALUES (?, 1, ?, ?, ?, ?, NULL, NULL)',
    ).run(newId, trimmed, now, now, source.thumbnailText);

    const messages = db
      .prepare('SELECT * FROM design_messages WHERE design_id = ? ORDER BY ordinal ASC')
      .all(sourceId) as MessageRow[];
    const insertMsg = db.prepare(
      'INSERT INTO design_messages (design_id, ordinal, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const m of messages) {
      insertMsg.run(newId, m.ordinal, m.role, m.content, m.created_at);
    }

    // Snapshots: clone in chronological order so parent_ids are remapped first.
    // Tie-break by rowid so we always process older inserts first when two
    // snapshots share a millisecond.
    const snaps = db
      .prepare(
        'SELECT * FROM design_snapshots WHERE design_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(sourceId) as SnapshotRow[];
    const idMap = new Map<string, string>();
    const insertSnap = db.prepare(
      `INSERT INTO design_snapshots
         (id, schema_version, design_id, parent_id, type, prompt, artifact_type, artifact_source, created_at, message, engine, engine_version)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of snaps) {
      const cloneId = crypto.randomUUID();
      idMap.set(s.id, cloneId);
      const newParent = s.parent_id !== null ? (idMap.get(s.parent_id) ?? null) : null;
      insertSnap.run(
        cloneId,
        newId,
        newParent,
        s.type,
        s.prompt,
        s.artifact_type,
        s.artifact_source,
        s.created_at,
        s.message,
        s.engine,
        s.engine_version,
      );
    }
  });
  tx();

  return getDesign(db, newId);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export function createSnapshot(db: Database, input: SnapshotCreateInput): DesignSnapshot {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO design_snapshots
       (id, schema_version, design_id, parent_id, type, prompt, artifact_type, artifact_source, created_at, message, engine, engine_version)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.designId,
    input.parentId,
    input.type,
    input.prompt,
    input.artifactType,
    input.artifactSource,
    now,
    input.message ?? null,
    input.engine ?? null,
    input.engineVersion ?? null,
  );
  // Bump the parent design's updated_at so clients can sort designs by activity.
  db.prepare('UPDATE designs SET updated_at = ? WHERE id = ?').run(now, input.designId);
  return rowToSnapshot(
    db.prepare('SELECT * FROM design_snapshots WHERE id = ?').get(id) as SnapshotRow,
  );
}

export function listSnapshots(db: Database, designId: string): DesignSnapshot[] {
  return (
    db
      .prepare('SELECT * FROM design_snapshots WHERE design_id = ? ORDER BY created_at DESC')
      .all(designId) as SnapshotRow[]
  ).map(rowToSnapshot);
}

export function getSnapshot(db: Database, id: string): DesignSnapshot | null {
  const row = db.prepare('SELECT * FROM design_snapshots WHERE id = ?').get(id) as
    | SnapshotRow
    | undefined;
  return row ? rowToSnapshot(row) : null;
}

export function deleteSnapshot(db: Database, id: string): void {
  db.prepare('DELETE FROM design_snapshots WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Snapshot files (gameplan §6, A1) — multi-file project bundle copy attached
// to a snapshot row. Lets restore() recover the full tree (Godot project,
// Pygame package, multi-scene Three/Phaser game) instead of just one HTML
// blob. The path-and-content shape mirrors design_files; we copy at snapshot
// time rather than schema-relating to design_files so historical snapshots
// stay intact even when the live design_files table is mutated.
// ---------------------------------------------------------------------------

export interface SnapshotFileRow {
  snapshotId: string;
  path: string;
  content: string;
  contentType: string;
  isBinary: boolean;
  createdAt: number;
}

interface SnapshotFileRowDb {
  snapshot_id: string;
  path: string;
  content: string;
  content_type: string;
  is_binary: number;
  created_at: number;
}

function rowToSnapshotFile(row: SnapshotFileRowDb): SnapshotFileRow {
  return {
    snapshotId: row.snapshot_id,
    path: row.path,
    content: row.content,
    contentType: row.content_type,
    isBinary: row.is_binary !== 0,
    createdAt: row.created_at,
  };
}

/** Copy every current `design_files` row for `designId` into
 *  `design_snapshot_files` keyed by `snapshotId`. Idempotent — caller is
 *  expected to invoke this once per `createSnapshot` call. Skips silently
 *  when the design has no files. */
export function snapshotDesignFiles(db: Database, snapshotId: string, designId: string): number {
  const files = db
    .prepare('SELECT path, content FROM design_files WHERE design_id = ?')
    .all(designId) as Array<{ path: string; content: string }>;
  if (files.length === 0) return 0;
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO design_snapshot_files
       (snapshot_id, path, content, content_type, is_binary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_id, path) DO UPDATE SET
       content      = excluded.content,
       content_type = excluded.content_type,
       is_binary    = excluded.is_binary`,
  );
  const tx = db.transaction(() => {
    for (const f of files) {
      const isBinary = f.content.startsWith('data:base64,') ? 1 : 0;
      const contentType = contentTypeFromPath(f.path);
      insert.run(snapshotId, f.path, f.content, contentType, isBinary, now);
    }
  });
  tx();
  return files.length;
}

export function getSnapshotFiles(db: Database, snapshotId: string): SnapshotFileRow[] {
  return (
    db
      .prepare('SELECT * FROM design_snapshot_files WHERE snapshot_id = ? ORDER BY path ASC')
      .all(snapshotId) as SnapshotFileRowDb[]
  ).map(rowToSnapshotFile);
}

/** Boot-time / first-open seeding for multi-file designs.
 *  Idempotent — only fires when the design has zero rows in
 *  `design_files`. Walks the most-recent snapshot of the design and
 *  replays its captured tree into `design_files` so the iframe (and
 *  the Files panel) sees the full multi-file artifact even after an
 *  app restart. Returns the number of files restored, or 0 if the
 *  design already has files / has no snapshots / has no captured
 *  files. Mirror of `seedChatFromSnapshots` for the file tree. */
export function seedDesignFilesFromLatestSnapshot(db: Database, designId: string): number {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM design_files WHERE design_id = ?')
    .get(designId) as { n: number };
  if (existing.n > 0) return 0;
  const latest = db
    .prepare('SELECT id FROM design_snapshots WHERE design_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(designId) as { id: string } | undefined;
  if (latest === undefined) return 0;
  const filesInSnapshot = db
    .prepare('SELECT COUNT(*) AS n FROM design_snapshot_files WHERE snapshot_id = ?')
    .get(latest.id) as { n: number };
  if (filesInSnapshot.n === 0) return 0;
  return restoreSnapshotFiles(db, designId, latest.id);
}

/** Replace the live `design_files` rows for `designId` with the bundle that
 *  was captured against `snapshotId`. Used by snapshot-restore to rewind
 *  the workspace to the state recorded against an earlier snapshot. */
export function restoreSnapshotFiles(db: Database, designId: string, snapshotId: string): number {
  const files = getSnapshotFiles(db, snapshotId);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM design_files WHERE design_id = ?').run(designId);
    if (files.length === 0) return;
    const insert = db.prepare(
      `INSERT INTO design_files (id, design_id, path, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const f of files) {
      insert.run(crypto.randomUUID(), designId, f.path, f.content, now, now);
    }
  });
  tx();
  return files.length;
}

/** Path → MIME mapping shared between snapshot capture and the
 *  game-files:// protocol handler (Phase A2). */
export function contentTypeFromPath(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  switch (ext) {
    case 'html':
    case 'htm':
      return 'text/html';
    case 'js':
    case 'mjs':
      return 'text/javascript';
    case 'jsx':
    case 'tsx':
      return 'text/javascript';
    case 'json':
      return 'application/json';
    case 'css':
      return 'text/css';
    case 'md':
      return 'text/markdown';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'py':
      return 'text/x-python';
    case 'gd':
      return 'text/x-gdscript';
    case 'tscn':
    case 'tres':
    case 'import':
    case 'godot':
    case 'cfg':
      return 'text/plain';
    case 'wasm':
      return 'application/wasm';
    case 'pck':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------
// Chat messages (Sidebar v2)
// ---------------------------------------------------------------------------

interface ChatMessageRowDb {
  id: number;
  design_id: string;
  seq: number;
  kind: string;
  payload: string;
  snapshot_id: string | null;
  created_at: string;
  /** May be undefined on rows written before the additive migration backfilled
   *  the column. Treated as schema 1 for those rows. */
  schema_version: number | null | undefined;
  /** May be undefined on rows written before the session_id additive
   *  migration. Treated as 0 for those rows. */
  session_id: number | null | undefined;
}

/** Forward-migrate a chat_messages row read from disk to the current writer
 *  shape. v1 → v2 is identity at the column level — v2 only changes the
 *  semantic of `payload.status` for tool_call rows: v1 wrote 'done' for
 *  every outcome, v2 writes 'error' when the runtime flagged a failure.
 *  Old v1 rows keep their 'done' status (interpreted as "outcome unknown").
 *
 *  Throws `SchemaMismatchError` when `fromVersion` is newer than the writer
 *  can understand (forward-incompatible).
 */
function migrateChatMessageRow(row: ChatMessageRowDb, fromVersion: number): ChatMessageRowDb {
  if (fromVersion === CHAT_MESSAGE_SCHEMA_VERSION) return row;
  if (fromVersion < CHAT_MESSAGE_SCHEMA_VERSION) {
    // v1 → v2 — semantic-only change to tool_call payloads' status field;
    // no column-level migration needed. The renderer treats 'done' on a v1
    // row the same as 'done' on a v2 row (both mean "the call settled").
    return row;
  }
  throw new SchemaMismatchError('chat_messages', fromVersion, CHAT_MESSAGE_SCHEMA_VERSION);
}

function rowToChatMessage(row: ChatMessageRowDb): ChatMessageRow {
  const persistedVersion =
    typeof row.schema_version === 'number' && Number.isFinite(row.schema_version)
      ? row.schema_version
      : 1;
  const migrated = migrateChatMessageRow(row, persistedVersion);
  let payload: unknown = null;
  try {
    payload = JSON.parse(migrated.payload);
  } catch {
    payload = { _raw: migrated.payload };
  }
  // Surface the on-disk version so callers can distinguish v1 rows
  // (status='done' for everything, outcome unknown) from v2 rows
  // (status='error' set on failed tool calls). Coerced to one of the
  // supported literals so downstream type-narrowing works.
  const reportedVersion: 1 | 2 = persistedVersion === 1 ? 1 : 2;
  const sessionId =
    typeof migrated.session_id === 'number' && Number.isFinite(migrated.session_id)
      ? migrated.session_id
      : 0;
  return {
    schemaVersion: reportedVersion,
    id: migrated.id,
    designId: migrated.design_id,
    seq: migrated.seq,
    kind: migrated.kind as ChatMessageKind,
    payload,
    snapshotId: migrated.snapshot_id,
    createdAt: migrated.created_at,
    sessionId,
  };
}

export function listChatMessages(db: Database, designId: string): ChatMessageRow[] {
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE design_id = ? ORDER BY seq ASC')
    .all(designId) as ChatMessageRowDb[];
  const out: ChatMessageRow[] = [];
  for (const r of rows) {
    try {
      out.push(rowToChatMessage(r));
    } catch (err) {
      if (err instanceof SchemaMismatchError) {
        // Forward-compat row written by a newer install. Skip rather than
        // breaking the whole list — diagnostics surface the mismatch separately.
        getLogger('snapshots-db').warn('chat_messages.skip_unknown_schema', {
          designId,
          rowId: r.id,
          got: err.got,
          expected: err.expected,
        });
        continue;
      }
      throw err;
    }
  }
  return out;
}

/**
 * Atomically append a chat_messages row with a monotonically increasing seq.
 * seq is computed inside the transaction from COALESCE(MAX(seq), -1) + 1 so
 * concurrent appenders can't collide on the UNIQUE (design_id, seq) index.
 *
 * The `session_id` is stamped from the design's `current_session_id`
 * (Improver1 follow-up: in-design "new conversation"). Callers don't pass
 * session_id explicitly — it's the active pointer at write time.
 */
export function appendChatMessage(db: Database, input: ChatAppendInput): ChatMessageRow {
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const snapshotId = input.snapshotId ?? null;

  const schemaVersion = input.schemaVersion ?? CHAT_MESSAGE_SCHEMA_VERSION;

  const tx = db.transaction((): ChatMessageRow => {
    const nextSeqRow = db
      .prepare(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS nextSeq FROM chat_messages WHERE design_id = ?',
      )
      .get(input.designId) as { nextSeq: number };
    const sessRow = db
      .prepare('SELECT current_session_id FROM designs WHERE id = ?')
      .get(input.designId) as { current_session_id: number | null } | undefined;
    const sessionId = sessRow?.current_session_id ?? 0;
    const info = db
      .prepare(
        `INSERT INTO chat_messages (design_id, seq, kind, payload, snapshot_id, created_at, schema_version, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.designId,
        nextSeqRow.nextSeq,
        input.kind,
        payloadJson,
        snapshotId,
        now,
        schemaVersion,
        sessionId,
      );
    const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(info.lastInsertRowid) as
      | ChatMessageRowDb
      | undefined;
    if (!row) throw new Error('Failed to read back appended chat message');
    return rowToChatMessage(row);
  });
  return tx();
}

/**
 * Bump the design's `current_session_id`. Subsequent `appendChatMessage`
 * calls inherit the new value, so the agent's history-builder filtering
 * by the design's current session sees an empty list — which is the
 * point: a fresh conversation that pays zero token cost for prior
 * tool-call transcripts. Existing rows keep their old session_id
 * intact and remain visible in the chat list (with a session divider
 * in the UI).
 *
 * Returns the new session id. Idempotency: each call increments by 1;
 * callers that want "ensure a fresh session" should call once per user
 * action, not on every render.
 */
export function newChatSession(db: Database, designId: string): number {
  return db.transaction((): number => {
    const row = db.prepare('SELECT current_session_id FROM designs WHERE id = ?').get(designId) as
      | { current_session_id: number | null }
      | undefined;
    if (row === undefined) {
      throw new Error(`newChatSession: design ${designId} not found`);
    }
    const chatRow = db
      .prepare('SELECT MAX(session_id) AS max_session_id FROM chat_messages WHERE design_id = ?')
      .get(designId) as { max_session_id: number | null } | undefined;
    const maxKnown = Math.max(row.current_session_id ?? 0, chatRow?.max_session_id ?? 0);
    const next = maxKnown + 1;
    db.prepare('UPDATE designs SET current_session_id = ?, updated_at = ? WHERE id = ?').run(
      next,
      new Date().toISOString(),
      designId,
    );
    return next;
  })();
}

/** Read the design's active session pointer. Renderer uses this to
 *  filter the chat list when building the LLM history payload. */
export function getDesignCurrentSession(db: Database, designId: string): number {
  const row = db.prepare('SELECT current_session_id FROM designs WHERE id = ?').get(designId) as
    | { current_session_id: number | null }
    | undefined;
  return row?.current_session_id ?? 0;
}

/** Move the design's active conversation pointer to an existing session. */
export function setDesignCurrentSession(db: Database, designId: string, sessionId: number): number {
  if (!Number.isInteger(sessionId) || sessionId < 0) {
    throw new Error(`setDesignCurrentSession: invalid session ${sessionId}`);
  }
  return db.transaction((): number => {
    const row = db.prepare('SELECT current_session_id FROM designs WHERE id = ?').get(designId) as
      | { current_session_id: number | null }
      | undefined;
    if (row === undefined) {
      throw new Error(`setDesignCurrentSession: design ${designId} not found`);
    }
    const chatRow = db
      .prepare('SELECT MAX(session_id) AS max_session_id FROM chat_messages WHERE design_id = ?')
      .get(designId) as { max_session_id: number | null } | undefined;
    const maxKnown = Math.max(row.current_session_id ?? 0, chatRow?.max_session_id ?? 0);
    if (sessionId > maxKnown) {
      throw new Error(`setDesignCurrentSession: session ${sessionId} does not exist`);
    }
    db.prepare('UPDATE designs SET current_session_id = ?, updated_at = ? WHERE id = ?').run(
      sessionId,
      new Date().toISOString(),
      designId,
    );
    return sessionId;
  })();
}

/**
 * Patch a tool_call row's status (and optional errorMessage) in place.
 *
 * Tool calls are persisted at start-time with status='running'; this is the
 * counterpart that flips them to 'done' / 'error' when the result event lands.
 * Silent no-op if the row doesn't exist or isn't a tool_call — the renderer
 * may briefly race ahead of the persisted append, and we'd rather drop the
 * update than throw on a not-yet-committed row.
 */
export function updateChatToolCallStatus(
  db: Database,
  designId: string,
  seq: number,
  status: 'done' | 'error',
  errorMessage?: string,
): void {
  if (errorMessage === undefined) {
    db.prepare(
      `UPDATE chat_messages
         SET payload = json_set(payload, '$.status', ?)
       WHERE design_id = ? AND seq = ? AND kind = 'tool_call'`,
    ).run(status, designId, seq);
    return;
  }
  db.prepare(
    `UPDATE chat_messages
       SET payload = json_set(payload, '$.status', ?, '$.errorMessage', ?)
     WHERE design_id = ? AND seq = ? AND kind = 'tool_call'`,
  ).run(status, errorMessage, designId, seq);
}

/**
 * Idempotent — only runs if chat_messages is empty for this design. Walks
 * snapshots in chronological order and emits a (user) + (artifact_delivered)
 * pair per snapshot so pre-existing designs light up with a chat history on
 * first Sidebar v2 open.
 */
export function seedChatFromSnapshots(db: Database, designId: string): number {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE design_id = ?')
    .get(designId) as { n: number };
  if (existing.n > 0) return 0;

  const snaps = db
    .prepare(
      'SELECT * FROM design_snapshots WHERE design_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(designId) as SnapshotRow[];
  if (snaps.length === 0) return 0;

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const s of snaps) {
      if (typeof s.prompt === 'string' && s.prompt.trim().length > 0) {
        appendChatMessage(db, {
          designId,
          kind: 'user',
          payload: { text: s.prompt },
        });
        inserted += 1;
      }
      appendChatMessage(db, {
        designId,
        kind: 'artifact_delivered',
        payload: { createdAt: s.created_at },
        snapshotId: s.id,
      });
      inserted += 1;
    }
  });
  tx();
  return inserted;
}

export function clearChatMessages(db: Database, designId: string): void {
  db.prepare('DELETE FROM chat_messages WHERE design_id = ?').run(designId);
}

// ---------------------------------------------------------------------------
// Comments (Workstream D — inline comment mode)
// ---------------------------------------------------------------------------

interface CommentRowDb {
  id: string;
  schema_version: number;
  design_id: string;
  snapshot_id: string;
  kind: string;
  selector: string;
  tag: string;
  outer_html: string;
  rect: string;
  text: string;
  status: string;
  created_at: string;
  applied_in_snapshot_id: string | null;
  scope: string | null;
  parent_outer_html: string | null;
}

function rowToComment(row: CommentRowDb): CommentRow {
  let rect: CommentRect = { top: 0, left: 0, width: 0, height: 0 };
  try {
    const parsed = JSON.parse(row.rect) as Partial<CommentRect>;
    rect = {
      top: typeof parsed.top === 'number' ? parsed.top : 0,
      left: typeof parsed.left === 'number' ? parsed.left : 0,
      width: typeof parsed.width === 'number' ? parsed.width : 0,
      height: typeof parsed.height === 'number' ? parsed.height : 0,
    };
  } catch {
    /* keep zero rect */
  }
  const scope: CommentScope = row.scope === 'global' ? 'global' : 'element';
  return {
    schemaVersion: 1,
    id: row.id,
    designId: row.design_id,
    snapshotId: row.snapshot_id,
    kind: row.kind as CommentKind,
    selector: row.selector,
    tag: row.tag,
    outerHTML: row.outer_html,
    rect,
    text: row.text,
    status: row.status as CommentStatus,
    createdAt: row.created_at,
    appliedInSnapshotId: row.applied_in_snapshot_id,
    scope,
    ...(row.parent_outer_html !== null && row.parent_outer_html !== undefined
      ? { parentOuterHTML: row.parent_outer_html }
      : {}),
  };
}

export function createComment(db: Database, input: CommentCreateInput): CommentRow {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const scope: CommentScope = input.scope === 'global' ? 'global' : 'element';
  const parentOuterHTML =
    typeof input.parentOuterHTML === 'string' && input.parentOuterHTML.length > 0
      ? input.parentOuterHTML.slice(0, 600)
      : null;
  db.prepare(
    `INSERT INTO comments
       (id, schema_version, design_id, snapshot_id, kind, selector, tag, outer_html, rect, text, status, created_at, applied_in_snapshot_id, scope, parent_outer_html)
     VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
  ).run(
    id,
    input.designId,
    input.snapshotId,
    input.kind,
    input.selector,
    input.tag,
    input.outerHTML,
    JSON.stringify(input.rect),
    input.text,
    now,
    scope,
    parentOuterHTML,
  );
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRowDb;
  return rowToComment(row);
}

export function listComments(db: Database, designId: string, snapshotId?: string): CommentRow[] {
  const rows = (
    snapshotId
      ? db
          .prepare(
            'SELECT * FROM comments WHERE design_id = ? AND snapshot_id = ? ORDER BY created_at ASC',
          )
          .all(designId, snapshotId)
      : db
          .prepare('SELECT * FROM comments WHERE design_id = ? ORDER BY created_at ASC')
          .all(designId)
  ) as CommentRowDb[];
  return rows.map(rowToComment);
}

export function listPendingEdits(db: Database, designId: string): CommentRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM comments WHERE design_id = ? AND kind = 'edit' AND status = 'pending' ORDER BY created_at ASC",
    )
    .all(designId) as CommentRowDb[];
  return rows.map(rowToComment);
}

export function updateComment(
  db: Database,
  id: string,
  patch: CommentUpdateInput,
): CommentRow | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.text !== undefined) {
    fields.push('text = ?');
    values.push(patch.text);
  }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (fields.length === 0) {
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as
      | CommentRowDb
      | undefined;
    return row ? rowToComment(row) : null;
  }
  values.push(id);
  const result = db.prepare(`UPDATE comments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  if (result.changes === 0) return null;
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRowDb;
  return rowToComment(row);
}

export function deleteComment(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  return result.changes > 0;
}

export function markCommentsApplied(db: Database, ids: string[], snapshotId: string): CommentRow[] {
  if (ids.length === 0) return [];
  const tx = db.transaction(() => {
    const stmt = db.prepare(
      "UPDATE comments SET status = 'applied', applied_in_snapshot_id = ? WHERE id = ?",
    );
    for (const id of ids) stmt.run(snapshotId, id);
  });
  tx();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM comments WHERE id IN (${placeholders})`)
    .all(...ids) as CommentRowDb[];
  return rows.map(rowToComment);
}

// ---------------------------------------------------------------------------
// Virtual FS — design_files (Workstream E Phase 2)
//
// Paths are stored verbatim. Callers MUST pass POSIX-relative paths that were
// already validated via normalizeDesignFilePath(); this helper throws for
// absolute paths and ".." traversal so tool implementations don't have to
// repeat the check.
// ---------------------------------------------------------------------------

interface DesignFileRowDb {
  id: string;
  design_id: string;
  path: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function rowToDesignFile(row: DesignFileRowDb): DesignFile {
  return {
    schemaVersion: 1,
    id: row.id,
    designId: row.design_id,
    path: row.path,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reject absolute paths, drive letters, "..", and empty segments. Returns
 * the cleaned POSIX path on success.
 */
export function normalizeDesignFilePath(raw: string): string {
  const s = raw.trim();
  if (s.length === 0) throw new Error('path must not be empty');
  if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s))
    throw new Error(`path must be relative: ${raw}`);
  const parts = s.replaceAll('\\', '/').split('/');
  for (const p of parts) {
    if (p === '..' || p === '') throw new Error(`invalid path segment in ${raw}`);
  }
  return parts.join('/');
}

export function viewDesignFile(db: Database, designId: string, path: string): DesignFile | null {
  const p = normalizeDesignFilePath(path);
  const row = db
    .prepare('SELECT * FROM design_files WHERE design_id = ? AND path = ?')
    .get(designId, p) as DesignFileRowDb | undefined;
  return row ? rowToDesignFile(row) : null;
}

export function listDesignFiles(db: Database, designId: string): DesignFile[] {
  return (
    db
      .prepare('SELECT * FROM design_files WHERE design_id = ? ORDER BY path ASC')
      .all(designId) as DesignFileRowDb[]
  ).map(rowToDesignFile);
}

/**
 * List files whose path matches `${dir}/*` (one segment deeper only). Used by
 * text_editor's `view` command when the caller points at a directory.
 */
export function listDesignFilesInDir(db: Database, designId: string, dir: string): string[] {
  const clean = dir === '' || dir === '.' ? '' : normalizeDesignFilePath(dir);
  const prefix = clean.length === 0 ? '' : `${clean}/`;
  const files = listDesignFiles(db, designId);
  const names = new Set<string>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    if (rest.length === 0) continue;
    const first = rest.split('/')[0] ?? rest;
    names.add(first);
  }
  return [...names].sort();
}

export function createDesignFile(
  db: Database,
  designId: string,
  path: string,
  content: string,
): DesignFile {
  const p = normalizeDesignFilePath(path);
  const existing = db
    .prepare('SELECT 1 FROM design_files WHERE design_id = ? AND path = ?')
    .get(designId, p);
  if (existing) throw new Error(`File already exists: ${p}`);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO design_files (id, design_id, path, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, designId, p, content, now, now);
  const row = db.prepare('SELECT * FROM design_files WHERE id = ?').get(id) as DesignFileRowDb;
  return rowToDesignFile(row);
}

export function upsertDesignFile(
  db: Database,
  designId: string,
  path: string,
  content: string,
): DesignFile {
  const p = normalizeDesignFilePath(path);
  const existing = db
    .prepare('SELECT * FROM design_files WHERE design_id = ? AND path = ?')
    .get(designId, p) as DesignFileRowDb | undefined;
  if (existing) {
    const now = new Date().toISOString();
    db.prepare('UPDATE design_files SET content = ?, updated_at = ? WHERE id = ?').run(
      content,
      now,
      existing.id,
    );
    return rowToDesignFile({ ...existing, content, updated_at: now });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO design_files (id, design_id, path, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, designId, p, content, now, now);
  return rowToDesignFile(
    db.prepare('SELECT * FROM design_files WHERE id = ?').get(id) as DesignFileRowDb,
  );
}

export function strReplaceInDesignFile(
  db: Database,
  designId: string,
  path: string,
  oldStr: string,
  newStr: string,
): DesignFile {
  const p = normalizeDesignFilePath(path);
  const row = db
    .prepare('SELECT * FROM design_files WHERE design_id = ? AND path = ?')
    .get(designId, p) as DesignFileRowDb | undefined;
  if (!row) throw new Error(`File not found: ${p}`);
  const occurrences = row.content.split(oldStr).length - 1;
  if (occurrences === 0) throw new Error(`old_str not found in ${p}`);
  if (occurrences > 1)
    throw new Error(`old_str matched ${occurrences} times in ${p}; must be unique`);
  const next = row.content.replace(oldStr, newStr);
  const now = new Date().toISOString();
  db.prepare('UPDATE design_files SET content = ?, updated_at = ? WHERE id = ?').run(
    next,
    now,
    row.id,
  );
  return rowToDesignFile({ ...row, content: next, updated_at: now });
}

export function insertInDesignFile(
  db: Database,
  designId: string,
  path: string,
  line: number,
  text: string,
): DesignFile {
  const p = normalizeDesignFilePath(path);
  const row = db
    .prepare('SELECT * FROM design_files WHERE design_id = ? AND path = ?')
    .get(designId, p) as DesignFileRowDb | undefined;
  if (!row) throw new Error(`File not found: ${p}`);
  const lines = row.content.split('\n');
  if (line < 0 || line > lines.length)
    throw new Error(`insert_line ${line} out of range (0..${lines.length}) for ${p}`);
  const insertion = text.endsWith('\n') ? text.slice(0, -1) : text;
  lines.splice(line, 0, insertion);
  const next = lines.join('\n');
  const now = new Date().toISOString();
  db.prepare('UPDATE design_files SET content = ?, updated_at = ? WHERE id = ?').run(
    next,
    now,
    row.id,
  );
  return rowToDesignFile({ ...row, content: next, updated_at: now });
}

// ---------------------------------------------------------------------------
// Diagnostic events (PR3 — main-process error/log capture store)
//
// 200ms dedup: if the most recent row with the same fingerprint was inserted
// within the window, bump its count + ts and OR-merge the transient flag
// instead of inserting a new row. Run_id is intentionally ignored for the
// match — dedup groups collapse regardless of which run produced the repeat.
// ---------------------------------------------------------------------------

const DIAGNOSTIC_DEDUP_WINDOW_MS = 200;

interface DiagnosticEventRowDb {
  id: number;
  schema_version: number;
  ts: number;
  level: string;
  code: string;
  scope: string;
  run_id: string | null;
  fingerprint: string;
  message: string;
  stack: string | null;
  transient: number;
  count: number;
  context_json: string | null;
}

function rowToDiagnosticEvent(row: DiagnosticEventRowDb): DiagnosticEventRow {
  let context: Record<string, unknown> | undefined;
  if (row.context_json !== null && row.context_json.length > 0) {
    try {
      const parsed: unknown = JSON.parse(row.context_json);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        context = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON — ignore rather than crash the list view.
    }
  }
  return {
    id: row.id,
    schemaVersion: 1,
    ts: row.ts,
    level: row.level as DiagnosticLevel,
    code: row.code,
    scope: row.scope,
    runId: row.run_id ?? undefined,
    fingerprint: row.fingerprint,
    message: row.message,
    stack: row.stack ?? undefined,
    transient: row.transient === 1,
    count: row.count,
    context,
  };
}

export function recordDiagnosticEvent(
  db: Database,
  input: DiagnosticEventInput,
  now: () => number = Date.now,
): number {
  const ts = now();
  const recent = db
    .prepare(
      'SELECT id, count, transient FROM diagnostic_events WHERE fingerprint = ? AND ts > ? ORDER BY ts DESC LIMIT 1',
    )
    .get(input.fingerprint, ts - DIAGNOSTIC_DEDUP_WINDOW_MS) as
    | { id: number; count: number; transient: number }
    | undefined;

  if (recent !== undefined) {
    const mergedTransient = recent.transient === 1 || input.transient ? 1 : 0;
    db.prepare(
      'UPDATE diagnostic_events SET count = count + 1, ts = ?, transient = ? WHERE id = ?',
    ).run(ts, mergedTransient, recent.id);
    return recent.id;
  }

  const result = db
    .prepare(
      `INSERT INTO diagnostic_events
       (schema_version, ts, level, code, scope, run_id, fingerprint, message, stack, transient, count, context_json)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      ts,
      input.level,
      input.code,
      input.scope,
      input.runId ?? null,
      input.fingerprint,
      input.message,
      input.stack ?? null,
      input.transient ? 1 : 0,
      input.context !== undefined ? JSON.stringify(input.context) : null,
    );
  return Number(result.lastInsertRowid);
}

export function getDiagnosticEventById(db: Database, id: number): DiagnosticEventRow | undefined {
  const row = db.prepare('SELECT * FROM diagnostic_events WHERE id = ?').get(id) as
    | DiagnosticEventRowDb
    | undefined;
  return row === undefined ? undefined : rowToDiagnosticEvent(row);
}

export function listDiagnosticEvents(
  db: Database,
  opts?: { limit?: number; includeTransient?: boolean },
): DiagnosticEventRow[] {
  const limit = opts?.limit ?? 100;
  const includeTransient = opts?.includeTransient ?? false;
  const sql = includeTransient
    ? 'SELECT * FROM diagnostic_events ORDER BY ts DESC, id DESC LIMIT ?'
    : 'SELECT * FROM diagnostic_events WHERE transient = 0 ORDER BY ts DESC, id DESC LIMIT ?';
  const rows = db.prepare(sql).all(limit) as DiagnosticEventRowDb[];
  return rows.map(rowToDiagnosticEvent);
}

/** Phase 5 — error-pill aggregator. Counts diagnostic_events in a date
 *  range, grouped by level. Drives the chrome's "3 provider errors today
 *  — view" pill. Pure DB query, no IO. */
export interface DiagnosticEventCounts {
  info: number;
  warn: number;
  error: number;
  total: number;
}
export function countDiagnosticEvents(
  db: Database,
  range: { sinceMs: number; untilMs?: number; includeTransient?: boolean } = {
    sinceMs: 0,
  },
): DiagnosticEventCounts {
  const includeTransient = range.includeTransient ?? false;
  const untilMs = range.untilMs ?? Number.MAX_SAFE_INTEGER;
  const params: Array<number> = [range.sinceMs, untilMs];
  const transientClause = includeTransient ? '' : 'AND transient = 0';
  const rows = db
    .prepare(
      `SELECT level, COUNT(*) AS n
         FROM diagnostic_events
         WHERE ts >= ? AND ts <= ? ${transientClause}
         GROUP BY level`,
    )
    .all(...params) as Array<{ level: string; n: number }>;
  const out: DiagnosticEventCounts = { info: 0, warn: 0, error: 0, total: 0 };
  for (const r of rows) {
    if (r.level === 'info' || r.level === 'warn' || r.level === 'error') {
      out[r.level] = r.n;
      out.total += r.n;
    }
  }
  return out;
}

export function pruneDiagnosticEvents(db: Database, maxRows: number): number {
  const result = db
    .prepare(
      `DELETE FROM diagnostic_events
       WHERE id NOT IN (
         SELECT id FROM diagnostic_events ORDER BY ts DESC, id DESC LIMIT ?
       )`,
    )
    .run(maxRows);
  return result.changes;
}

// ---------------------------------------------------------------------------
// User-authored skills (backlog-2 #7)
// ---------------------------------------------------------------------------

interface UserSkillRow {
  id: string;
  schema_version: number;
  name: string;
  when_to_use: string;
  source: string;
  source_design_id: string | null;
  source_snapshot_id: string | null;
  source_rect: string | null;
  created_at: string;
  updated_at: string;
}

function rowToUserSkill(row: UserSkillRow): UserSkill {
  let rect = null;
  if (typeof row.source_rect === 'string' && row.source_rect.length > 0) {
    try {
      rect = JSON.parse(row.source_rect);
    } catch {
      rect = null;
    }
  }
  return {
    schemaVersion: 1,
    id: row.id,
    name: row.name,
    whenToUse: row.when_to_use,
    source: row.source,
    sourceDesignId: row.source_design_id,
    sourceSnapshotId: row.source_snapshot_id,
    sourceRect: rect as UserSkill['sourceRect'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listUserSkills(db: Database): UserSkill[] {
  const rows = db
    .prepare('SELECT * FROM user_skills ORDER BY updated_at DESC')
    .all() as UserSkillRow[];
  return rows.map(rowToUserSkill);
}

export function getUserSkill(db: Database, id: string): UserSkill | null {
  const row = db.prepare('SELECT * FROM user_skills WHERE id = ?').get(id) as
    | UserSkillRow
    | undefined;
  return row ? rowToUserSkill(row) : null;
}

export function createUserSkill(db: Database, input: UserSkillCreateInput): UserSkill {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rect = input.sourceRect ? JSON.stringify(input.sourceRect) : null;
  db.prepare(
    `INSERT INTO user_skills
       (id, schema_version, name, when_to_use, source, source_design_id, source_snapshot_id, source_rect, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.whenToUse,
    input.source,
    input.sourceDesignId ?? null,
    input.sourceSnapshotId ?? null,
    rect,
    now,
    now,
  );
  const row = db.prepare('SELECT * FROM user_skills WHERE id = ?').get(id) as UserSkillRow;
  return rowToUserSkill(row);
}

export function updateUserSkill(
  db: Database,
  id: string,
  patch: UserSkillUpdateInput,
): UserSkill | null {
  const now = new Date().toISOString();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.whenToUse !== undefined) {
    sets.push('when_to_use = ?');
    values.push(patch.whenToUse);
  }
  if (patch.source !== undefined) {
    sets.push('source = ?');
    values.push(patch.source);
  }
  if (sets.length === 0) return getUserSkill(db, id);
  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);
  const result = db
    .prepare(`UPDATE user_skills SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
  if (result.changes === 0) return null;
  return getUserSkill(db, id);
}

export function deleteUserSkill(db: Database, id: string): void {
  db.prepare('DELETE FROM user_skills WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Run usage (plan0305 P3.2 — per-run token + cost telemetry)
//
// One row per generation, keyed by the renderer-supplied generationId. Lets
// the BYOK user see "this design cost $X.XX" by aggregating across runs for
// a given designId, and lets us reason about cost trends without inferring
// from byte counts (which under-count cache writes).
// ---------------------------------------------------------------------------

/** Phase 3 — bumped from 1 → 2 with the addition of `implied_cost_usd`.
 *  Forward-migration of v1 rows is identity (the column is added with a
 *  default of 0; the read path treats absent values as 0). */
export const RUN_USAGE_SCHEMA_VERSION = 2;

export interface RunUsageInput {
  generationId: string;
  designId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  /** Real provider-billed cost. For `claude-code-imported` and other
   *  subscription providers this is `0` (no cash cost). */
  costUsd: number;
  /** Phase 3 — what an API user would have paid at standard Anthropic
   *  pricing for the same token shape. Computed via `computeImpliedCost`
   *  in the renderer / write path. Optional in the input shape only so
   *  legacy callers (test fixtures + future callers that don't care) can
   *  omit it; the writer treats absent / undefined as 0 (the row's column
   *  default). Drives the budget-alert threshold for subscription-provider
   *  users. */
  impliedCostUsd?: number;
  totalChunks: number;
  totalMs: number;
  provider?: string | undefined;
  modelId?: string | undefined;
}

export interface RunUsageRow extends RunUsageInput {
  schemaVersion: number;
  createdAt: string;
}

export interface DesignUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  runs: number;
}

/** Idempotent insert keyed by generationId — a retry of the same run
 *  overwrites rather than duplicating. Emits nothing if the input is
 *  zero across the board (no point cluttering the table with empty rows
 *  e.g. when an aborted run never got far enough to consume tokens). */
export function recordRunUsage(db: Database, input: RunUsageInput): void {
  const allZero =
    input.inputTokens === 0 &&
    input.outputTokens === 0 &&
    input.cachedInputTokens === 0 &&
    input.cacheCreationInputTokens === 0 &&
    input.costUsd === 0;
  if (allZero) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO run_usage (
       generation_id, schema_version, design_id,
       input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens,
       cost_usd, implied_cost_usd, total_chunks, total_ms, provider, model_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(generation_id) DO UPDATE SET
       input_tokens                = excluded.input_tokens,
       output_tokens               = excluded.output_tokens,
       cached_input_tokens         = excluded.cached_input_tokens,
       cache_creation_input_tokens = excluded.cache_creation_input_tokens,
       cost_usd                    = excluded.cost_usd,
       implied_cost_usd            = excluded.implied_cost_usd,
       total_chunks                = excluded.total_chunks,
       total_ms                    = excluded.total_ms,
       provider                    = excluded.provider,
       model_id                    = excluded.model_id`,
  ).run(
    input.generationId,
    RUN_USAGE_SCHEMA_VERSION,
    input.designId,
    input.inputTokens,
    input.outputTokens,
    input.cachedInputTokens,
    input.cacheCreationInputTokens,
    input.costUsd,
    input.impliedCostUsd ?? 0,
    input.totalChunks,
    input.totalMs,
    input.provider ?? null,
    input.modelId ?? null,
    now,
  );
  // Backlog-3 §10 — roll up the daily_usage row for today (local
  // tz). UPSERT so the same date accumulates across runs. ISO date
  // YYYY-MM-DD in local time; the dashboard's 7-day sparkline reads
  // this directly without scanning run_usage.
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const dateKey = `${yyyy}-${mm}-${dd}`;
  db.prepare(
    `INSERT INTO daily_usage (
       date, schema_version, cost_usd, input_tokens, output_tokens,
       cached_input_tokens, run_count, updated_at
     ) VALUES (?, 1, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date) DO UPDATE SET
       cost_usd            = cost_usd + excluded.cost_usd,
       input_tokens        = input_tokens + excluded.input_tokens,
       output_tokens       = output_tokens + excluded.output_tokens,
       cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
       run_count           = run_count + 1,
       updated_at          = excluded.updated_at`,
  ).run(
    dateKey,
    input.costUsd,
    input.inputTokens,
    input.outputTokens,
    input.cachedInputTokens,
    now,
  );
}

/** Phase 3 — per-tool latency telemetry insert. Idempotency: not enforced
 *  (a tool can legitimately be called multiple times per run). The caller
 *  is responsible for one row per tool_execution_end event. Failures are
 *  swallowed (the caller is the main process IPC handler — telemetry must
 *  never break a run). */
export interface ToolDurationInput {
  generationId: string;
  designId: string | null;
  toolName: string;
  toolCallId?: string | null;
  command?: string | null;
  durationMs: number;
  status: 'done' | 'error';
}
export function recordToolDuration(db: Database, input: ToolDurationInput): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO run_tool_durations (
       schema_version, generation_id, design_id, tool_name, tool_call_id,
       command, duration_ms, status, created_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.generationId,
    input.designId,
    input.toolName,
    input.toolCallId ?? null,
    input.command ?? null,
    Math.max(0, Math.round(input.durationMs)),
    input.status,
    now,
  );
}

/** Phase 3 — read aggregated per-tool latency for a generation or
 *  globally. Used by the cost & speed analysis dashboard and by the
 *  Phase 4 fused-tool acceptance fixtures. */
export interface ToolDurationStats {
  toolName: string;
  count: number;
  avgMs: number;
  maxMs: number;
  errorCount: number;
}
export function listToolDurationStats(
  db: Database,
  filter: { generationId?: string } = {},
): ToolDurationStats[] {
  const where = filter.generationId !== undefined ? 'WHERE generation_id = ?' : '';
  const params = filter.generationId !== undefined ? [filter.generationId] : [];
  const rows = db
    .prepare(
      `SELECT tool_name AS toolName,
              COUNT(*)  AS count,
              AVG(duration_ms) AS avgMs,
              MAX(duration_ms) AS maxMs,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorCount
         FROM run_tool_durations
         ${where}
         GROUP BY tool_name
         ORDER BY count DESC`,
    )
    .all(...params) as Array<{
    toolName: string;
    count: number;
    avgMs: number;
    maxMs: number;
    errorCount: number;
  }>;
  return rows;
}

/** Backlog-3 §10 — budget settings (id='global' or a designId). */
export interface BudgetRecord {
  id: string;
  dailyLimitUsd: number | null;
  perDesignLimitUsd: number | null;
  alertAtPct: number;
}

/** Read a budget by id (`'global'` or a design id). Returns null when no
 *  row exists — caller treats that as "no cap". */
export function getBudget(db: Database, id: string): BudgetRecord | null {
  const row = db
    .prepare(
      'SELECT id, daily_limit_usd, per_design_limit_usd, alert_at_pct FROM budgets WHERE id = ?',
    )
    .get(id) as
    | {
        id: string;
        daily_limit_usd: number | null;
        per_design_limit_usd: number | null;
        alert_at_pct: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    dailyLimitUsd: row.daily_limit_usd,
    perDesignLimitUsd: row.per_design_limit_usd,
    alertAtPct: row.alert_at_pct,
  };
}

/** Upsert a budget. Pass null to clear a limit; the row stays with the
 *  remaining fields populated. */
export function upsertBudget(db: Database, input: BudgetRecord): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO budgets (id, schema_version, daily_limit_usd, per_design_limit_usd, alert_at_pct, updated_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       daily_limit_usd      = excluded.daily_limit_usd,
       per_design_limit_usd = excluded.per_design_limit_usd,
       alert_at_pct         = excluded.alert_at_pct,
       updated_at           = excluded.updated_at`,
  ).run(input.id, input.dailyLimitUsd, input.perDesignLimitUsd, input.alertAtPct, now);
}

export interface DailyUsageRecord {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  runCount: number;
}

/** Read the last `daysBack` daily_usage rows including today, ordered
 *  oldest → newest. Missing days are NOT padded — the caller fills
 *  zeros if needed (the dashboard does this for the sparkline). */
export function listDailyUsage(db: Database, daysBack: number): DailyUsageRecord[] {
  const rows = db
    .prepare(
      `SELECT date, cost_usd, input_tokens, output_tokens, cached_input_tokens, run_count
       FROM daily_usage
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(365, daysBack))) as Array<{
    date: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    run_count: number;
  }>;
  return rows
    .map((r) => ({
      date: r.date,
      costUsd: r.cost_usd,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cachedInputTokens: r.cached_input_tokens,
      runCount: r.run_count,
    }))
    .reverse();
}

/** Sum of all run_usage rows belonging to one design. Returns zeroes when
 *  no usage has been recorded yet for the design. */
export function getDesignUsageTotals(db: Database, designId: string): DesignUsageTotals {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0)               AS inputTokens,
         COALESCE(SUM(output_tokens), 0)              AS outputTokens,
         COALESCE(SUM(cached_input_tokens), 0)        AS cachedInputTokens,
         COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
         COALESCE(SUM(cost_usd), 0)                   AS costUsd,
         COUNT(*)                                     AS runs
       FROM run_usage
       WHERE design_id = ?`,
    )
    .get(designId) as DesignUsageTotals | undefined;
  return (
    row ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      runs: 0,
    }
  );
}
