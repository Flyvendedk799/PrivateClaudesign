/**
 * Snapshot IPC handlers (main process).
 *
 * All channels are namespaced snapshots:v1:* so they can be versioned
 * independently of other codesign:* channels.
 *
 * The `db` argument is injected so tests can pass an in-memory instance
 * without module-level state. Production callers pass the singleton from
 * initSnapshotsDb().
 */

import type {
  Design,
  DesignSnapshot,
  PromptAssistMetadata,
  SnapshotCreateInput,
} from '@open-codesign/shared';
import { CodesignError, PromptAssistMetadataV1 } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { bindWorkspace, checkWorkspaceFolderExists, openWorkspaceFolder } from './design-workspace';
import { dialog, ipcMain } from './electron-runtime';
import {
  restoreGameArtifactsFromSnapshot,
  snapshotGameArtifactsForSnapshot,
} from './game-artifacts-db';
import { indexGameArtifactsFromFiles, regenerateArtifactsRegistry } from './game-artifacts-import';
// may9 Phase 4 — pull the latest GameSpec the agent recorded for this
// design (via declare_game_spec / amend_game_spec) so spec_json
// round-trips through every snapshot. Lives in its own sidecar module
// so this file does not transitively import the Electron-bound
// side-effects in `./index.ts` (which break vitest module-load).
import { getLastSeenGameSpec } from './game-spec-cache';
import { getLogger } from './logger';
import {
  createDesign,
  createSnapshot,
  deleteSnapshot,
  duplicateDesign,
  getDesign,
  getSnapshot,
  listDesignFiles,
  listDesigns,
  listSnapshots,
  renameDesign,
  restoreSnapshotFiles,
  setDesignDecomposeHash,
  setDesignPromptAssistMetadata,
  setDesignThumbnail,
  snapshotDesignFiles,
  softDeleteDesign,
} from './snapshots-db';

type Database = BetterSqlite3.Database;

const logger = getLogger('snapshots-ipc');

/**
 * Translate a raw better-sqlite3 SqliteError into a typed CodesignError so the
 * renderer never sees provider-specific error strings. Constraint subcodes are
 * matched individually because the bare `SQLITE_CONSTRAINT` parent code covers
 * unrelated failures (UNIQUE, NOT NULL, CHECK, FK), and surfacing all of them
 * as a single message would mislead the UI. The FK message is keyed by call-site
 * context because the same SQLITE_CONSTRAINT_FOREIGNKEY code fires for both a
 * missing `design_id` and a missing `parent_id` in design_snapshots — naming
 * only the parent led contributors to chase the wrong cause. Unrecognised
 * errors fall through as IPC_DB_ERROR with the original cause attached for
 * server-side logs.
 */
const FK_MESSAGES: Record<string, string> = {
  create: 'Referenced design or parent snapshot does not exist',
  'create.lookup-parent': 'Referenced design or parent snapshot does not exist',
};

type Translation = {
  code: 'IPC_BAD_INPUT' | 'IPC_CONFLICT' | 'IPC_DB_BUSY' | 'IPC_DB_FULL';
  message: string;
};

function staticTranslation(sqliteCode: string): Translation | null {
  switch (sqliteCode) {
    case 'SQLITE_CONSTRAINT_UNIQUE':
    case 'SQLITE_CONSTRAINT_PRIMARYKEY':
      return { code: 'IPC_CONFLICT', message: 'Snapshot already exists' };
    case 'SQLITE_CONSTRAINT_NOTNULL':
    case 'SQLITE_CONSTRAINT_CHECK':
      return { code: 'IPC_BAD_INPUT', message: 'Snapshot input violates database constraints' };
    case 'SQLITE_BUSY':
    case 'SQLITE_LOCKED':
      return { code: 'IPC_DB_BUSY', message: 'Database is locked, retry shortly' };
    case 'SQLITE_FULL':
      return { code: 'IPC_DB_FULL', message: 'Disk is full' };
    default:
      return null;
  }
}

function translateSqliteError(err: unknown, context: string): CodesignError {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') {
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      const message = FK_MESSAGES[context] ?? 'Referenced item does not exist';
      return new CodesignError(message, 'IPC_BAD_INPUT', { cause: err });
    }
    const t = staticTranslation(code);
    if (t !== null) {
      return new CodesignError(t.message, t.code, { cause: err });
    }
  }
  logger.error('snapshot.db_error', {
    context,
    code: typeof code === 'string' ? code : 'unknown',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return new CodesignError(`Snapshot database error (${context})`, 'IPC_DB_ERROR', { cause: err });
}

function runDb<T>(context: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CodesignError) throw err;
    throw translateSqliteError(err, context);
  }
}

/**
 * Every snapshots:v1:* object payload carries `schemaVersion: 1` so that future
 * handler revisions can reject older callers up-front rather than silently
 * mis-parsing fields. Bare scalar payloads (none currently) would not carry one.
 */
function requireSchemaV1(r: Record<string, unknown>, channel: string): void {
  if (r['schemaVersion'] !== 1) {
    throw new CodesignError(`${channel} requires schemaVersion: 1`, 'IPC_BAD_INPUT');
  }
}

function parseSnapshotCreateInput(raw: unknown): SnapshotCreateInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('snapshots:v1:create expects an object payload', 'IPC_BAD_INPUT');
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'snapshots:v1:create');

  if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
    throw new CodesignError('designId must be a non-empty string', 'IPC_BAD_INPUT');
  }
  if (r['parentId'] !== null && typeof r['parentId'] !== 'string') {
    throw new CodesignError('parentId must be a string or null', 'IPC_BAD_INPUT');
  }
  const validTypes = ['initial', 'edit', 'fork'] as const;
  if (!validTypes.includes(r['type'] as (typeof validTypes)[number])) {
    throw new CodesignError(`type must be one of: ${validTypes.join(', ')}`, 'IPC_BAD_INPUT');
  }
  if (r['prompt'] !== null && typeof r['prompt'] !== 'string') {
    throw new CodesignError('prompt must be a string or null', 'IPC_BAD_INPUT');
  }
  const validArtifactTypes = ['html', 'react', 'svg', 'game'] as const;
  if (!validArtifactTypes.includes(r['artifactType'] as (typeof validArtifactTypes)[number])) {
    throw new CodesignError(
      `artifactType must be one of: ${validArtifactTypes.join(', ')}`,
      'IPC_BAD_INPUT',
    );
  }
  if (typeof r['artifactSource'] !== 'string') {
    throw new CodesignError('artifactSource must be a string', 'IPC_BAD_INPUT');
  }
  if (r['message'] !== undefined && typeof r['message'] !== 'string') {
    throw new CodesignError('message must be a string if provided', 'IPC_BAD_INPUT');
  }

  const validEngines = ['three', 'phaser', 'pygame', 'godot'] as const;
  let engine: 'three' | 'phaser' | 'pygame' | 'godot' | null = null;
  if (r['engine'] !== undefined && r['engine'] !== null) {
    if (
      typeof r['engine'] !== 'string' ||
      !validEngines.includes(r['engine'] as (typeof validEngines)[number])
    ) {
      throw new CodesignError(
        `engine must be one of: ${validEngines.join(', ')} (or null)`,
        'IPC_BAD_INPUT',
      );
    }
    engine = r['engine'] as (typeof validEngines)[number];
  }
  const engineVersion =
    typeof r['engineVersion'] === 'string' ? (r['engineVersion'] as string) : null;

  const base: SnapshotCreateInput = {
    designId: r['designId'] as string,
    parentId: r['parentId'] as string | null,
    type: r['type'] as SnapshotCreateInput['type'],
    prompt: r['prompt'] as string | null,
    artifactType: r['artifactType'] as SnapshotCreateInput['artifactType'],
    artifactSource: r['artifactSource'] as string,
    engine,
    engineVersion,
  };
  if (typeof r['message'] === 'string') {
    return { ...base, message: r['message'] };
  }
  return base;
}

export function registerSnapshotsIpc(db: Database): void {
  ipcMain.handle('snapshots:v1:list-designs', (_e: unknown, raw: unknown): Design[] => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError(
        'snapshots:v1:list-designs expects an object payload',
        'IPC_BAD_INPUT',
      );
    }
    requireSchemaV1(raw as Record<string, unknown>, 'snapshots:v1:list-designs');
    return runDb('list-designs', () => listDesigns(db));
  });

  ipcMain.handle('snapshots:v1:list', (_e: unknown, raw: unknown): DesignSnapshot[] => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError('snapshots:v1:list expects an object with designId', 'IPC_BAD_INPUT');
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:list');
    if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
      throw new CodesignError('designId must be a non-empty string', 'IPC_BAD_INPUT');
    }
    return runDb('list', () => listSnapshots(db, r['designId'] as string));
  });

  // Multi-file design support — returns the live `design_files` rows
  // for the given design, dropped to the (path, sizeBytes, updatedAt)
  // shape the renderer's Files tab + preview-source helper actually
  // need. Body is omitted to keep the IPC payload small even when the
  // tree is large.
  ipcMain.handle(
    'snapshots:v1:list-files',
    (_e: unknown, raw: unknown): Array<{ path: string; sizeBytes: number; updatedAt: string }> => {
      if (typeof raw !== 'object' || raw === null) {
        throw new CodesignError(
          'snapshots:v1:list-files expects an object with designId',
          'IPC_BAD_INPUT',
        );
      }
      const r = raw as Record<string, unknown>;
      requireSchemaV1(r, 'snapshots:v1:list-files');
      if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
        throw new CodesignError('designId must be a non-empty string', 'IPC_BAD_INPUT');
      }
      const files = runDb('list-files', () => listDesignFiles(db, r['designId'] as string));
      return files.map((f) => ({
        path: f.path,
        sizeBytes: f.content.length,
        updatedAt: f.updatedAt,
      }));
    },
  );

  ipcMain.handle('snapshots:v1:get', (_e: unknown, raw: unknown): DesignSnapshot | null => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError('snapshots:v1:get expects an object with id', 'IPC_BAD_INPUT');
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:get');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
    }
    return runDb('get', () => getSnapshot(db, r['id'] as string));
  });

  ipcMain.handle('snapshots:v1:create', (_e: unknown, raw: unknown): DesignSnapshot => {
    const input = parseSnapshotCreateInput(raw);
    if (input.parentId !== null) {
      const parent = runDb('create.lookup-parent', () => getSnapshot(db, input.parentId as string));
      if (parent === null) {
        throw new CodesignError(
          'parentId references a snapshot that does not exist',
          'IPC_BAD_INPUT',
        );
      }
      if (parent.designId !== input.designId) {
        throw new CodesignError(
          'parentId must reference a snapshot in the same design',
          'IPC_BAD_INPUT',
        );
      }
    }
    // game-artifacts §4 — for game-mode snapshots, opportunistically
    // promote any `assets/sprites/*` / `assets/animations/*` directories
    // the agent just authored into artifact rows BEFORE we capture the
    // snapshot, then regenerate the registry file. Idempotent and cheap
    // for design-mode (no assets dirs → no-op).
    let indexed = { spritesAdded: 0, animationsAdded: 0, levelsAdded: 0, worldAdded: 0 };
    if (input.artifactType === 'game') {
      try {
        indexed = runDb('create.index-artifacts', () =>
          indexGameArtifactsFromFiles(db, input.designId),
        );
        runDb('create.regenerate-registry', () => regenerateArtifactsRegistry(db, input.designId));
      } catch (err) {
        logger.warn('snapshot.index_artifacts.fail', {
          designId: input.designId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // may9 Phase 4 — splice in the latest GameSpec for this design
    // so spec_json persists across edits. Falls back to the input's
    // existing specJson when the renderer or a test passes one
    // explicitly; otherwise consults the in-memory cache populated
    // by the agent's declare_game_spec / amend_game_spec calls.
    const inputWithSpec: typeof input =
      input.specJson === undefined
        ? (() => {
            if (input.artifactType !== 'game') return input;
            const spec = getLastSeenGameSpec(input.designId);
            return spec === null ? input : { ...input, specJson: JSON.stringify(spec) };
          })()
        : input;
    const snapshot = runDb('create', () => createSnapshot(db, inputWithSpec));
    // Multi-file artifacts — copy the design's live `design_files`
    // tree into `design_snapshot_files` so a future restore can rewind
    // every sidecar (`.css` / `.js` / `.png` / etc.), not just the
    // single `artifact_source` blob. Skips silently when the design
    // has no files (game-mode bundles always have files; design-mode
    // single-file artifacts skip and stay backward-compatible).
    const filesCount = runDb('create.snapshot-files', () =>
      snapshotDesignFiles(db, snapshot.id, input.designId),
    );
    // game-artifacts §10 — capture the registry rows + bindings against
    // the new snapshot so restoring this snapshot later resurrects the
    // sprite/animation tabs as they were. Cheap (no rows for design-mode
    // designs) and idempotent.
    const artifactCount = runDb('create.snapshot-artifacts', () =>
      snapshotGameArtifactsForSnapshot(db, snapshot.id, input.designId),
    );
    logger.info('snapshot.created', {
      id: snapshot.id,
      type: input.type,
      designId: input.designId,
      filesSnapshot: filesCount,
      artifactsIndexedSprites: indexed.spritesAdded,
      artifactsIndexedAnimations: indexed.animationsAdded,
      artifactsSnapshot: artifactCount.artifacts,
      bindingsSnapshot: artifactCount.bindings,
    });
    return snapshot;
  });

  // Manually flip an existing design into game mode by writing a fresh
  // snapshot with `artifact_type='game'`. Used by the renderer's
  // "Promote to Game Mode" button so a project that started as plain
  // HTML (and is actually a three.js / canvas game) gets the game-mode
  // chrome — Sprites + Animations tabs — without having to recreate
  // the design. Idempotent at the data layer (just appends a snapshot);
  // safe to call repeatedly.
  ipcMain.handle('snapshots:v1:promote-to-game', (_e: unknown, raw: unknown): DesignSnapshot => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError(
        'snapshots:v1:promote-to-game expects an object with designId',
        'IPC_BAD_INPUT',
      );
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:promote-to-game');
    if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
      throw new CodesignError('designId must be a non-empty string', 'IPC_BAD_INPUT');
    }
    const designId = (r['designId'] as string).trim();
    const validEngines = ['three', 'phaser', 'pygame', 'godot'] as const;
    let engine: (typeof validEngines)[number] | null = null;
    if (r['engine'] !== undefined && r['engine'] !== null) {
      if (
        typeof r['engine'] !== 'string' ||
        !validEngines.includes(r['engine'] as (typeof validEngines)[number])
      ) {
        throw new CodesignError(
          `engine must be one of: ${validEngines.join(', ')} (or null/omitted)`,
          'IPC_BAD_INPUT',
        );
      }
      engine = r['engine'] as (typeof validEngines)[number];
    }

    const existing = runDb('promote.list', () => listSnapshots(db, designId));
    if (existing.length === 0) {
      throw new CodesignError(
        'designId references a design with no snapshots — generate something first',
        'IPC_NOT_FOUND',
      );
    }
    const parent = existing[0];
    if (parent === undefined) {
      throw new CodesignError('design has no snapshots to use as parent', 'IPC_NOT_FOUND');
    }
    if (parent.artifactType === 'game') {
      // Already game-mode; surface the latest snapshot as a no-op so the
      // renderer's optimistic UI doesn't have to special-case it.
      logger.info('snapshot.promote_to_game.noop', { designId, snapshotId: parent.id });
      return parent;
    }
    const indexRow = runDb('promote.read-index-html', () =>
      db
        .prepare('SELECT content FROM design_files WHERE design_id = ? AND path = ?')
        .get(designId, 'index.html'),
    ) as { content?: unknown } | undefined;
    const rawContent = indexRow?.content;
    const indexHtml =
      typeof rawContent === 'string'
        ? rawContent
        : Buffer.isBuffer(rawContent)
          ? rawContent.toString('utf8')
          : '';
    if (indexHtml.length === 0) {
      throw new CodesignError(
        'design has no index.html content to capture — generate something first',
        'IPC_NOT_FOUND',
      );
    }

    const input: SnapshotCreateInput = {
      designId,
      parentId: parent.id,
      type: 'edit',
      prompt: null,
      artifactType: 'game',
      artifactSource: indexHtml,
      engine,
      engineVersion: null,
      message: 'Promoted to game mode',
    };

    let indexed = { spritesAdded: 0, animationsAdded: 0, levelsAdded: 0, worldAdded: 0 };
    try {
      indexed = runDb('promote.index-artifacts', () => indexGameArtifactsFromFiles(db, designId));
      runDb('promote.regenerate-registry', () => regenerateArtifactsRegistry(db, designId));
    } catch (err) {
      logger.warn('snapshot.promote_to_game.index_artifacts.fail', {
        designId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const snapshot = runDb('promote.create', () => createSnapshot(db, input));
    const filesCount = runDb('promote.snapshot-files', () =>
      snapshotDesignFiles(db, snapshot.id, designId),
    );
    const artifactCount = runDb('promote.snapshot-artifacts', () =>
      snapshotGameArtifactsForSnapshot(db, snapshot.id, designId),
    );
    logger.info('snapshot.promote_to_game.ok', {
      designId,
      snapshotId: snapshot.id,
      parentId: parent.id,
      filesSnapshot: filesCount,
      artifactsIndexedSprites: indexed.spritesAdded,
      artifactsIndexedAnimations: indexed.animationsAdded,
      artifactsIndexedLevels: indexed.levelsAdded,
      artifactsIndexedWorld: indexed.worldAdded,
      artifactsSnapshot: artifactCount.artifacts,
      bindingsSnapshot: artifactCount.bindings,
      engine,
    });
    return snapshot;
  });

  ipcMain.handle('snapshots:v1:delete', (_e: unknown, raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError('snapshots:v1:delete expects an object with id', 'IPC_BAD_INPUT');
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:delete');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
    }
    runDb('delete', () => deleteSnapshot(db, r['id'] as string));
    logger.info('snapshot.deleted', { id: r['id'] });
  });

  ipcMain.handle('snapshots:v1:create-design', (_e: unknown, raw: unknown): Design => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError(
        'snapshots:v1:create-design expects an object with name',
        'IPC_BAD_INPUT',
      );
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:create-design');
    if (typeof r['name'] !== 'string' || r['name'].trim().length === 0) {
      throw new CodesignError('name must be a non-empty string', 'IPC_BAD_INPUT');
    }
    return runDb('create-design', () => createDesign(db, (r['name'] as string).trim()));
  });

  ipcMain.handle('snapshots:v1:get-design', (_e: unknown, raw: unknown): Design | null => {
    const id = parseIdPayload(raw, 'get-design');
    return runDb('get-design', () => getDesign(db, id));
  });

  ipcMain.handle('snapshots:v1:rename-design', (_e: unknown, raw: unknown): Design => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError('snapshots:v1:rename-design expects { id, name }', 'IPC_BAD_INPUT');
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:rename-design');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
    }
    if (typeof r['name'] !== 'string' || r['name'].trim().length === 0) {
      throw new CodesignError('name must be a non-empty string', 'IPC_BAD_INPUT');
    }
    const updated = runDb('rename-design', () =>
      renameDesign(db, r['id'] as string, r['name'] as string),
    );
    if (updated === null) {
      throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
    }
    logger.info('design.renamed', { id: updated.id, name: updated.name });
    return updated;
  });

  ipcMain.handle('snapshots:v1:set-thumbnail', (_e: unknown, raw: unknown): Design => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError(
        'snapshots:v1:set-thumbnail expects { id, thumbnailText }',
        'IPC_BAD_INPUT',
      );
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:set-thumbnail');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
    }
    const value = r['thumbnailText'];
    if (value !== null && typeof value !== 'string') {
      throw new CodesignError('thumbnailText must be a string or null', 'IPC_BAD_INPUT');
    }
    const updated = runDb('set-thumbnail', () =>
      setDesignThumbnail(db, r['id'] as string, value as string | null),
    );
    if (updated === null) {
      throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
    }
    return updated;
  });

  ipcMain.handle('snapshots:v1:set-prompt-assist', (_e: unknown, raw: unknown): Design => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError(
        'snapshots:v1:set-prompt-assist expects { id, metadata }',
        'IPC_BAD_INPUT',
      );
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:set-prompt-assist');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
    }
    let metadata: PromptAssistMetadata | null;
    if (r['metadata'] === null) {
      metadata = null;
    } else {
      try {
        metadata = PromptAssistMetadataV1.parse(r['metadata']);
      } catch (err) {
        throw new CodesignError(
          `metadata failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
          'IPC_BAD_INPUT',
          { cause: err },
        );
      }
    }
    const updated = runDb('set-prompt-assist', () =>
      setDesignPromptAssistMetadata(db, r['id'] as string, metadata),
    );
    if (updated === null) {
      throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
    }
    return updated;
  });

  ipcMain.handle('snapshots:v1:set-decompose-hash', (_e: unknown, raw: unknown): Design => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError(
        'snapshots:v1:set-decompose-hash expects { id, hash }',
        'IPC_BAD_INPUT',
      );
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:set-decompose-hash');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
    }
    const value = r['hash'];
    if (value !== null && typeof value !== 'string') {
      throw new CodesignError('hash must be a string or null', 'IPC_BAD_INPUT');
    }
    if (typeof value === 'string' && (value.length === 0 || !/^[0-9a-f]+$/.test(value))) {
      // Lowercase hex only — keeps the column shape contractually predictable
      // for any future migration that wants to detect hashes by length.
      throw new CodesignError('hash must be a non-empty lowercase hex string', 'IPC_BAD_INPUT');
    }
    const updated = runDb('set-decompose-hash', () =>
      setDesignDecomposeHash(db, r['id'] as string, value as string | null),
    );
    if (updated === null) {
      throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
    }
    return updated;
  });

  ipcMain.handle('snapshots:v1:soft-delete-design', (_e: unknown, raw: unknown): Design => {
    const id = parseIdPayload(raw, 'soft-delete-design');
    const updated = runDb('soft-delete-design', () => softDeleteDesign(db, id));
    if (updated === null) {
      throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
    }
    logger.info('design.soft_deleted', { id });
    return updated;
  });

  ipcMain.handle('snapshots:v1:duplicate-design', (_e: unknown, raw: unknown): Design => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError(
        'snapshots:v1:duplicate-design expects { id, name }',
        'IPC_BAD_INPUT',
      );
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'snapshots:v1:duplicate-design');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
    }
    if (typeof r['name'] !== 'string' || r['name'].trim().length === 0) {
      throw new CodesignError('name must be a non-empty string', 'IPC_BAD_INPUT');
    }
    const cloned = runDb('duplicate-design', () =>
      duplicateDesign(db, r['id'] as string, r['name'] as string),
    );
    if (cloned === null) {
      throw new CodesignError('Source design not found', 'IPC_NOT_FOUND');
    }
    logger.info('design.duplicated', { sourceId: r['id'], newId: cloned.id });
    return cloned;
  });
}

export function registerWorkspaceIpc(db: Database, getWin: () => BrowserWindow | null): void {
  ipcMain.handle(
    'snapshots:v1:workspace:pick',
    async (_e: unknown, raw: unknown): Promise<string | null> => {
      if (typeof raw !== 'object' || raw === null) {
        throw new CodesignError(
          'snapshots:v1:workspace:pick expects an object payload',
          'IPC_BAD_INPUT',
        );
      }
      requireSchemaV1(raw as Record<string, unknown>, 'snapshots:v1:workspace:pick');
      const win = getWin();
      if (!win) {
        throw new CodesignError('Window not available', 'IPC_DB_ERROR');
      }
      let result: Awaited<ReturnType<typeof dialog.showOpenDialog>>;
      try {
        result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      } catch (cause) {
        throw new CodesignError('Failed to open folder picker dialog', 'IPC_DB_ERROR', { cause });
      }
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle(
    'snapshots:v1:workspace:update',
    async (_e: unknown, raw: unknown): Promise<Design> => {
      if (typeof raw !== 'object' || raw === null) {
        throw new CodesignError(
          'snapshots:v1:workspace:update expects an object payload',
          'IPC_BAD_INPUT',
        );
      }
      const r = raw as Record<string, unknown>;
      requireSchemaV1(r, 'snapshots:v1:workspace:update');

      if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
        throw new CodesignError('designId must be a non-empty string', 'IPC_BAD_INPUT');
      }
      const workspacePath = r['workspacePath'];
      if (workspacePath !== null && typeof workspacePath !== 'string') {
        throw new CodesignError('workspacePath must be a string or null', 'IPC_BAD_INPUT');
      }
      if (typeof r['migrateFiles'] !== 'boolean') {
        throw new CodesignError('migrateFiles must be a boolean', 'IPC_BAD_INPUT');
      }

      try {
        const design = await bindWorkspace(
          db,
          r['designId'] as string,
          workspacePath as string | null,
          r['migrateFiles'] as boolean,
        );
        if (design === null) {
          throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
        }
        logger.info('design.workspace_updated', {
          id: design.id,
          workspacePath: design.workspacePath,
        });
        return design;
      } catch (err) {
        if (err instanceof CodesignError) throw err;
        if (err instanceof Error && err.message.includes('already bound')) {
          throw new CodesignError(err.message, 'IPC_CONFLICT', { cause: err });
        }
        if (
          err instanceof Error &&
          (err.message.includes('Workspace migration collision') ||
            err.message.includes('Tracked workspace file missing'))
        ) {
          throw new CodesignError(err.message, 'IPC_BAD_INPUT', { cause: err });
        }
        throw new CodesignError('Workspace update failed', 'IPC_DB_ERROR', { cause: err });
      }
    },
  );

  ipcMain.handle(
    'snapshots:v1:workspace:open',
    async (_e: unknown, raw: unknown): Promise<void> => {
      if (typeof raw !== 'object' || raw === null) {
        throw new CodesignError(
          'snapshots:v1:workspace:open expects an object payload',
          'IPC_BAD_INPUT',
        );
      }
      const r = raw as Record<string, unknown>;
      requireSchemaV1(r, 'snapshots:v1:workspace:open');

      if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
        throw new CodesignError('designId must be a non-empty string', 'IPC_BAD_INPUT');
      }

      const design = runDb('workspace:open', () => getDesign(db, r['designId'] as string));
      if (design === null) {
        throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
      }
      if (design.workspacePath === null) {
        throw new CodesignError('No workspace bound to this design', 'IPC_BAD_INPUT');
      }

      try {
        await openWorkspaceFolder(design.workspacePath);
      } catch (err) {
        throw new CodesignError(
          err instanceof Error ? err.message : 'Failed to open workspace folder',
          'IPC_BAD_INPUT',
          { cause: err instanceof Error ? err : undefined },
        );
      }
    },
  );

  ipcMain.handle(
    'snapshots:v1:workspace:check',
    async (_e: unknown, raw: unknown): Promise<{ exists: boolean }> => {
      if (typeof raw !== 'object' || raw === null) {
        throw new CodesignError(
          'snapshots:v1:workspace:check expects an object payload',
          'IPC_BAD_INPUT',
        );
      }
      const r = raw as Record<string, unknown>;
      requireSchemaV1(r, 'snapshots:v1:workspace:check');

      if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
        throw new CodesignError('designId must be a non-empty string', 'IPC_BAD_INPUT');
      }

      const design = runDb('workspace:check', () => getDesign(db, r['designId'] as string));
      if (design === null) {
        throw new CodesignError('Design not found', 'IPC_NOT_FOUND');
      }

      if (design.workspacePath === null) {
        throw new CodesignError('Design is not bound to a workspace', 'IPC_BAD_INPUT');
      }

      let exists: boolean;
      try {
        exists = await checkWorkspaceFolderExists(design.workspacePath);
      } catch (cause) {
        throw new CodesignError('Failed to check workspace folder existence', 'IPC_DB_ERROR', {
          cause,
        });
      }
      return { exists };
    },
  );
}

function parseIdPayload(raw: unknown, channel: string): string {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(`snapshots:v1:${channel} expects { id }`, 'IPC_BAD_INPUT');
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, `snapshots:v1:${channel}`);
  if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
    throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
  }
  return r['id'] as string;
}

/**
 * Stub channels installed when snapshots DB init fails at boot. Without these,
 * any renderer call to window.codesign.snapshots.* would surface as Electron's
 * generic "No handler registered for ..." rejection — opaque to the user and
 * to logs. We register handlers that throw a typed CodesignError so the
 * renderer can branch on `SNAPSHOTS_UNAVAILABLE` and surface a placeholder.
 *
 * Channels listed here MUST match the set registered in registerSnapshotsIpc.
 */
export const SNAPSHOTS_CHANNELS_V1 = [
  'snapshots:v1:list-designs',
  'snapshots:v1:create-design',
  'snapshots:v1:get-design',
  'snapshots:v1:rename-design',
  'snapshots:v1:set-thumbnail',
  'snapshots:v1:set-prompt-assist',
  'snapshots:v1:set-decompose-hash',
  'snapshots:v1:soft-delete-design',
  'snapshots:v1:duplicate-design',
  'snapshots:v1:list',
  'snapshots:v1:get',
  'snapshots:v1:create',
  'snapshots:v1:promote-to-game',
  'snapshots:v1:delete',
  'snapshots:v1:workspace:pick',
  'snapshots:v1:workspace:update',
  'snapshots:v1:workspace:open',
  'snapshots:v1:workspace:check',
  'snapshots:v1:list-files',
] as const;

export function registerSnapshotsUnavailableIpc(reason: string): void {
  const message = `Snapshots database failed to initialize. Check Settings → Storage for diagnostics. (${reason})`;
  const fail = (): never => {
    throw new CodesignError(message, 'SNAPSHOTS_UNAVAILABLE');
  };
  for (const channel of SNAPSHOTS_CHANNELS_V1) {
    ipcMain.handle(channel, fail);
  }
}
