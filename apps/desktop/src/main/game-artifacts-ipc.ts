/**
 * IPC handlers for the game-artifacts registry. Exposed through
 * `window.codesign.gameArtifacts.*` in the preload bridge.
 *
 * All channels are namespaced `game-artifacts:v1:*` so they can be versioned
 * independently of snapshots:v1:* and chat:v1:*. The handlers translate the
 * minimal IPC payloads into the typed CRUD helpers in
 * `./game-artifacts-db.ts` and surface DB / Zod errors as
 * `IPC_BAD_INPUT` / `IPC_DB_ERROR` so the renderer never sees a raw
 * better-sqlite3 string.
 */

import type {
  GameAnimationBinding,
  GameArtifact,
  GameArtifactCreateInput,
  GameArtifactFileRefInput,
  GameArtifactKind,
  GameArtifactListResult,
  GameArtifactUpdateInput,
} from '@open-codesign/shared';
import {
  CodesignError,
  ERROR_CODES,
  GameArtifactCreateInput as GameArtifactCreateInputSchema,
  GameArtifactKind as GameArtifactKindSchema,
  GameArtifactUpdateInput as GameArtifactUpdateInputSchema,
} from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { ipcMain } from './electron-runtime';
import {
  archiveGameArtifact,
  createAnimationBinding,
  createGameArtifact,
  deleteAnimationBinding,
  findGameArtifactByAlias,
  findGameArtifactBySlug,
  getGameArtifact,
  listAnimationBindings,
  listGameArtifacts,
  restoreGameArtifactsFromSnapshot,
  snapshotGameArtifactsForSnapshot,
  updateGameArtifact,
} from './game-artifacts-db';
import { getLogger } from './logger';

type Database = BetterSqlite3.Database;

const logger = getLogger('game-artifacts-ipc');

function requireSchemaV1(r: Record<string, unknown>, channel: string): void {
  if (r['schemaVersion'] !== 1) {
    throw new CodesignError(`${channel} requires schemaVersion: 1`, ERROR_CODES.IPC_BAD_INPUT);
  }
}

function requireString(r: Record<string, unknown>, key: string, channel: string): string {
  const v = r[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new CodesignError(`${channel} requires "${key}" string`, ERROR_CODES.IPC_BAD_INPUT);
  }
  return v;
}

function asRecord(raw: unknown, channel: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(`${channel} expects an object payload`, ERROR_CODES.IPC_BAD_INPUT);
  }
  return raw as Record<string, unknown>;
}

function safeKindOpt(value: unknown): GameArtifactKind | undefined {
  if (value === undefined || value === null) return undefined;
  return GameArtifactKindSchema.parse(value);
}

/**
 * Build the snapshot of a design's artifact registry the renderer cares
 * about: every non-archived artifact + every binding. Used by the `list`
 * call and after every write so the renderer can re-fetch a coherent view
 * without round-tripping for each entity.
 */
function buildListResult(
  db: Database,
  designId: string,
  filter?: { kind?: GameArtifactKind; includeArchived?: boolean },
): GameArtifactListResult {
  const opts: { kind?: GameArtifactKind; includeArchived?: boolean } = {};
  if (filter?.kind !== undefined) opts.kind = filter.kind;
  if (filter?.includeArchived !== undefined) opts.includeArchived = filter.includeArchived;
  const artifacts = listGameArtifacts(db, designId, opts);
  const bindings = listAnimationBindings(db, designId);
  return { designId, artifacts, bindings };
}

export function registerGameArtifactsIpc(db: Database): void {
  ipcMain.handle('game-artifacts:v1:list', (_e: unknown, raw: unknown): GameArtifactListResult => {
    const r = asRecord(raw, 'game-artifacts:v1:list');
    requireSchemaV1(r, 'game-artifacts:v1:list');
    const designId = requireString(r, 'designId', 'game-artifacts:v1:list');
    const kind = safeKindOpt(r['kind']);
    const includeArchived = r['includeArchived'] === true;
    const filter: { kind?: GameArtifactKind; includeArchived?: boolean } = {
      includeArchived,
    };
    if (kind !== undefined) filter.kind = kind;
    return buildListResult(db, designId, filter);
  });

  ipcMain.handle('game-artifacts:v1:get', (_e: unknown, raw: unknown): GameArtifact | null => {
    const r = asRecord(raw, 'game-artifacts:v1:get');
    requireSchemaV1(r, 'game-artifacts:v1:get');
    const designId = requireString(r, 'designId', 'game-artifacts:v1:get');
    const artifactId = requireString(r, 'artifactId', 'game-artifacts:v1:get');
    return getGameArtifact(db, designId, artifactId);
  });

  ipcMain.handle(
    'game-artifacts:v1:create',
    (_e: unknown, raw: unknown): GameArtifactListResult => {
      const r = asRecord(raw, 'game-artifacts:v1:create');
      requireSchemaV1(r, 'game-artifacts:v1:create');
      let parsed: GameArtifactCreateInput;
      try {
        parsed = GameArtifactCreateInputSchema.parse(r['input']);
      } catch (err) {
        throw new CodesignError(
          'game-artifacts:v1:create has invalid input',
          ERROR_CODES.IPC_BAD_INPUT,
          { cause: err },
        );
      }
      try {
        const created = createGameArtifact(db, parsed);
        regenerateArtifactsRegistry(db, parsed.designId);
        logger.info('artifact.created', {
          designId: parsed.designId,
          id: created.id,
          kind: created.kind,
          slug: created.slug,
        });
        return buildListResult(db, parsed.designId);
      } catch (err) {
        throw new CodesignError('Failed to create game artifact', ERROR_CODES.IPC_DB_ERROR, {
          cause: err,
        });
      }
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:update',
    (_e: unknown, raw: unknown): GameArtifactListResult => {
      const r = asRecord(raw, 'game-artifacts:v1:update');
      requireSchemaV1(r, 'game-artifacts:v1:update');
      let parsed: GameArtifactUpdateInput;
      try {
        parsed = GameArtifactUpdateInputSchema.parse(r['input']);
      } catch (err) {
        throw new CodesignError(
          'game-artifacts:v1:update has invalid input',
          ERROR_CODES.IPC_BAD_INPUT,
          { cause: err },
        );
      }
      try {
        const updated = updateGameArtifact(db, parsed);
        regenerateArtifactsRegistry(db, parsed.designId);
        logger.info('artifact.updated', { designId: parsed.designId, id: updated.id });
        return buildListResult(db, parsed.designId);
      } catch (err) {
        throw new CodesignError('Failed to update game artifact', ERROR_CODES.IPC_DB_ERROR, {
          cause: err,
        });
      }
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:archive',
    (_e: unknown, raw: unknown): GameArtifactListResult => {
      const r = asRecord(raw, 'game-artifacts:v1:archive');
      requireSchemaV1(r, 'game-artifacts:v1:archive');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:archive');
      const artifactId = requireString(r, 'artifactId', 'game-artifacts:v1:archive');
      archiveGameArtifact(db, designId, artifactId);
      regenerateArtifactsRegistry(db, designId);
      logger.info('artifact.archived', { designId, id: artifactId });
      return buildListResult(db, designId, { includeArchived: true });
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:list-bindings',
    (_e: unknown, raw: unknown): GameAnimationBinding[] => {
      const r = asRecord(raw, 'game-artifacts:v1:list-bindings');
      requireSchemaV1(r, 'game-artifacts:v1:list-bindings');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:list-bindings');
      const filter: { spriteId?: string; animationId?: string } = {};
      if (typeof r['spriteId'] === 'string' && r['spriteId'].length > 0) {
        filter.spriteId = r['spriteId'];
      }
      if (typeof r['animationId'] === 'string' && r['animationId'].length > 0) {
        filter.animationId = r['animationId'];
      }
      return listAnimationBindings(db, designId, filter);
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:bind-animation',
    (_e: unknown, raw: unknown): GameArtifactListResult => {
      const r = asRecord(raw, 'game-artifacts:v1:bind-animation');
      requireSchemaV1(r, 'game-artifacts:v1:bind-animation');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:bind-animation');
      const animationId = requireString(r, 'animationId', 'game-artifacts:v1:bind-animation');
      const spriteId = requireString(r, 'spriteId', 'game-artifacts:v1:bind-animation');
      try {
        createAnimationBinding(db, {
          designId,
          animationId,
          spriteId,
          ...(typeof r['bindingStatus'] === 'string'
            ? { bindingStatus: r['bindingStatus'] as 'compatible' | 'needs_retarget' | 'broken' }
            : {}),
          ...(r['retarget'] !== undefined ? { retarget: r['retarget'] } : {}),
        });
        regenerateArtifactsRegistry(db, designId);
        logger.info('binding.created', { designId, animationId, spriteId });
        return buildListResult(db, designId);
      } catch (err) {
        throw new CodesignError('Failed to bind animation to sprite', ERROR_CODES.IPC_DB_ERROR, {
          cause: err,
        });
      }
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:unbind-animation',
    (_e: unknown, raw: unknown): GameArtifactListResult => {
      const r = asRecord(raw, 'game-artifacts:v1:unbind-animation');
      requireSchemaV1(r, 'game-artifacts:v1:unbind-animation');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:unbind-animation');
      const animationId = requireString(r, 'animationId', 'game-artifacts:v1:unbind-animation');
      const spriteId = requireString(r, 'spriteId', 'game-artifacts:v1:unbind-animation');
      deleteAnimationBinding(db, animationId, spriteId);
      regenerateArtifactsRegistry(db, designId);
      logger.info('binding.removed', { designId, animationId, spriteId });
      return buildListResult(db, designId);
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:resolve-prompt-ref',
    (
      _e: unknown,
      raw: unknown,
    ): {
      kind?: GameArtifactKind;
      slug?: string;
      artifact: GameArtifact | null;
    } => {
      const r = asRecord(raw, 'game-artifacts:v1:resolve-prompt-ref');
      requireSchemaV1(r, 'game-artifacts:v1:resolve-prompt-ref');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:resolve-prompt-ref');
      const refText = requireString(r, 'refText', 'game-artifacts:v1:resolve-prompt-ref');
      const trimmed = refText.trim();
      const aliasMatch = trimmed.match(/^@(sprite|animation):([a-z0-9][a-z0-9-]*)$/);
      if (aliasMatch !== null) {
        const kind = (aliasMatch[1] === 'animation' ? 'animation' : 'sprite') as GameArtifactKind;
        const slug = aliasMatch[2] as string;
        const artifact = findGameArtifactBySlug(db, designId, kind, slug);
        return { kind, slug, artifact };
      }
      const direct = findGameArtifactByAlias(db, designId, trimmed);
      return { artifact: direct };
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:snapshot',
    (_e: unknown, raw: unknown): { artifacts: number; files: number; bindings: number } => {
      const r = asRecord(raw, 'game-artifacts:v1:snapshot');
      requireSchemaV1(r, 'game-artifacts:v1:snapshot');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:snapshot');
      const snapshotId = requireString(r, 'snapshotId', 'game-artifacts:v1:snapshot');
      return snapshotGameArtifactsForSnapshot(db, snapshotId, designId);
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:restore',
    (_e: unknown, raw: unknown): { artifacts: number; files: number; bindings: number } => {
      const r = asRecord(raw, 'game-artifacts:v1:restore');
      requireSchemaV1(r, 'game-artifacts:v1:restore');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:restore');
      const snapshotId = requireString(r, 'snapshotId', 'game-artifacts:v1:restore');
      const result = restoreGameArtifactsFromSnapshot(db, designId, snapshotId);
      logger.info('artifact.restore', { designId, snapshotId, ...result });
      return result;
    },
  );

  ipcMain.handle(
    'game-artifacts:v1:import-files',
    (_e: unknown, raw: unknown): GameArtifactListResult => {
      const r = asRecord(raw, 'game-artifacts:v1:import-files');
      requireSchemaV1(r, 'game-artifacts:v1:import-files');
      const designId = requireString(r, 'designId', 'game-artifacts:v1:import-files');
      const kind = safeKindOpt(r['kind']);
      if (kind === undefined) {
        throw new CodesignError(
          'game-artifacts:v1:import-files requires "kind"',
          ERROR_CODES.IPC_BAD_INPUT,
        );
      }
      const filesRaw = r['files'];
      if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
        throw new CodesignError(
          'game-artifacts:v1:import-files requires non-empty files[]',
          ERROR_CODES.IPC_BAD_INPUT,
        );
      }
      const targetSpriteId =
        typeof r['targetSpriteId'] === 'string' && r['targetSpriteId'].length > 0
          ? r['targetSpriteId']
          : undefined;
      const name = typeof r['name'] === 'string' && r['name'].length > 0 ? r['name'] : undefined;
      try {
        importGameArtifactFiles({
          db,
          designId,
          kind,
          files: filesRaw as Array<{ relativePath: string; content: string; role?: string }>,
          ...(targetSpriteId !== undefined ? { targetSpriteId } : {}),
          ...(name !== undefined ? { name } : {}),
        });
        regenerateArtifactsRegistry(db, designId);
        return buildListResult(db, designId);
      } catch (err) {
        throw new CodesignError('Failed to import artifact files', ERROR_CODES.IPC_DB_ERROR, {
          cause: err,
        });
      }
    },
  );
}

/**
 * Sprite/animation file import. Takes a flat list of `(relativePath, content)`
 * tuples (preferably already base64-sentinel-encoded for binaries), copies
 * them into `design_files` under `assets/<kind>s/<slug>/...`, infers
 * minimal metadata, creates the artifact row + file refs, and (for
 * animations) opens a binding to the target sprite.
 *
 * The implementation is in `./game-artifacts-import.ts`; the IPC handler
 * imports lazily so that vitest runs that exercise the IPC layer don't
 * pull in the renderer-only inference helpers.
 */
import { importGameArtifactFiles, regenerateArtifactsRegistry } from './game-artifacts-import';
export type { ImportArtifactFilesResult } from './game-artifacts-import';
