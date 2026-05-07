/**
 * SQLite helpers for the game-artifacts registry (sprites + animations,
 * many-to-many bindings, and per-snapshot copies). The schema is created in
 * `snapshots-db.ts:applySchema` under the `game_artifacts_v1` marker.
 *
 * Design constraints:
 *  - Slugs and prompt aliases are unique per design. Renames change `name`,
 *    not `slug`/`prompt_alias`, so the agent + prompt context can rely on a
 *    stable identity across runs.
 *  - Metadata is stored as JSON TEXT and parsed back through the Zod
 *    discriminated union on read so consumers always see typed metadata.
 *  - Snapshot/restore round-trips capture `game_artifacts` + `game_artifact_files`
 *    + `game_animation_bindings` against a `design_snapshot.id` so reopening
 *    an old snapshot reconstructs the artifact registry as it was.
 */

import {
  type GameAnimationBinding,
  type GameAnimationBindingStatus,
  type GameArtifact,
  type GameArtifactCreateInput,
  type GameArtifactFile,
  type GameArtifactFileRefInput,
  type GameArtifactFileRole,
  type GameArtifactKind,
  GameArtifactMetadata as GameArtifactMetadataSchema,
  type GameArtifactProvenance,
  type GameArtifactStatus,
  type GameArtifactUpdateInput,
  aliasForArtifact,
  slugifyArtifactName,
} from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';

type Database = BetterSqlite3.Database;

interface GameArtifactRow {
  id: string;
  schema_version: number;
  design_id: string;
  kind: string;
  name: string;
  slug: string;
  prompt_alias: string;
  status: string;
  engine: string | null;
  primary_file_path: string | null;
  preview_file_path: string | null;
  thumbnail_path: string | null;
  metadata_json: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

interface GameArtifactFileRow {
  id: string;
  artifact_id: string;
  design_id: string;
  path: string;
  role: string;
  created_at: string;
}

interface GameAnimationBindingRow {
  id: string;
  design_id: string;
  animation_id: string;
  sprite_id: string;
  binding_status: string;
  retarget_json: string;
  created_at: string;
  updated_at: string;
}

interface GameArtifactSnapshotRow {
  id: string;
  schema_version: number;
  snapshot_id: string;
  artifact_id: string;
  design_id: string;
  kind: string;
  name: string;
  slug: string;
  prompt_alias: string;
  status: string;
  engine: string | null;
  primary_file_path: string | null;
  preview_file_path: string | null;
  thumbnail_path: string | null;
  metadata_json: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

interface GameArtifactFileSnapshotRow {
  id: string;
  artifact_snapshot_id: string;
  path: string;
  role: string;
}

interface GameAnimationBindingSnapshotRow {
  id: string;
  snapshot_id: string;
  animation_id: string;
  sprite_id: string;
  binding_status: string;
  retarget_json: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PROVENANCE: GameArtifactProvenance = { source: 'agent' };

function safeParseJson(value: string, fallback: unknown): unknown {
  if (value === undefined || value === null || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToArtifact(row: GameArtifactRow, files: GameArtifactFile[]): GameArtifact {
  const metadata = GameArtifactMetadataSchema.parse(safeParseJson(row.metadata_json, {}));
  const provenance = safeParseJson(
    row.provenance_json,
    DEFAULT_PROVENANCE,
  ) as GameArtifactProvenance;
  return {
    schemaVersion: 1,
    id: row.id,
    designId: row.design_id,
    kind: row.kind as GameArtifactKind,
    name: row.name,
    slug: row.slug,
    promptAlias: row.prompt_alias,
    status: row.status as GameArtifactStatus,
    engine: (row.engine as GameArtifact['engine']) ?? null,
    primaryFilePath: row.primary_file_path,
    previewFilePath: row.preview_file_path,
    thumbnailPath: row.thumbnail_path,
    metadata,
    provenance,
    files,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFile(row: GameArtifactFileRow): GameArtifactFile {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    designId: row.design_id,
    path: row.path,
    role: row.role as GameArtifactFileRole,
    createdAt: row.created_at,
  };
}

function rowToBinding(row: GameAnimationBindingRow): GameAnimationBinding {
  return {
    id: row.id,
    designId: row.design_id,
    animationId: row.animation_id,
    spriteId: row.sprite_id,
    bindingStatus: row.binding_status as GameAnimationBindingStatus,
    retarget: safeParseJson(row.retarget_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listArtifactFiles(db: Database, artifactId: string): GameArtifactFile[] {
  const rows = db
    .prepare('SELECT * FROM game_artifact_files WHERE artifact_id = ? ORDER BY path ASC')
    .all(artifactId) as GameArtifactFileRow[];
  return rows.map(rowToFile);
}

/**
 * Find a unique slug + prompt alias for `(designId, kind)`. If `desiredSlug`
 * collides with an existing row, append a numeric suffix until free. Used by
 * import + create flows so two distinct artifacts don't fight over the same
 * alias and so renames never invalidate downstream prompt references.
 */
function reserveSlug(
  db: Database,
  designId: string,
  kind: GameArtifactKind,
  desiredSlug: string,
): { slug: string; alias: string } {
  let candidate = desiredSlug;
  let suffix = 2;
  while (true) {
    const collision = db
      .prepare(
        'SELECT 1 FROM game_artifacts WHERE design_id = ? AND (slug = ? OR prompt_alias = ?)',
      )
      .get(designId, candidate, aliasForArtifact(kind, candidate));
    if (collision === undefined) {
      return { slug: candidate, alias: aliasForArtifact(kind, candidate) };
    }
    candidate = `${desiredSlug}-${suffix}`;
    suffix += 1;
  }
}

export function createGameArtifact(db: Database, input: GameArtifactCreateInput): GameArtifact {
  // Validate metadata shape up front so a malformed payload doesn't poison
  // the row. Throws ZodError; callers (IPC handler) surface as IPC_BAD_INPUT.
  const metadata = GameArtifactMetadataSchema.parse(input.metadata);
  if (metadata.kind !== input.kind) {
    throw new Error(
      `metadata.kind (${metadata.kind}) does not match artifact kind (${input.kind})`,
    );
  }
  const baseSlug =
    typeof input.slug === 'string' && input.slug.length > 0
      ? slugifyArtifactName(input.slug)
      : slugifyArtifactName(input.name);
  const reserved = reserveSlug(db, input.designId, input.kind, baseSlug);
  // If the caller passed an explicit alias, prefer it iff non-colliding;
  // otherwise fall back to the reserved alias.
  const desiredAlias = input.promptAlias?.trim();
  let promptAlias = reserved.alias;
  if (typeof desiredAlias === 'string' && desiredAlias.length > 0) {
    const collision = db
      .prepare('SELECT 1 FROM game_artifacts WHERE design_id = ? AND prompt_alias = ?')
      .get(input.designId, desiredAlias);
    if (collision === undefined) promptAlias = desiredAlias;
  }
  const id = `ga_${input.kind === 'sprite' ? 'sprite' : 'anim'}_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const provenance = input.provenance ?? DEFAULT_PROVENANCE;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO game_artifacts (
         id, schema_version, design_id, kind, name, slug, prompt_alias, status, engine,
         primary_file_path, preview_file_path, thumbnail_path,
         metadata_json, provenance_json, created_at, updated_at
       )
       VALUES (?, 1, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.designId,
      input.kind,
      input.name,
      reserved.slug,
      promptAlias,
      input.engine ?? null,
      input.primaryFilePath ?? null,
      input.previewFilePath ?? null,
      input.thumbnailPath ?? null,
      JSON.stringify(metadata),
      JSON.stringify(provenance),
      now,
      now,
    );
    const insertFile = db.prepare(
      `INSERT INTO game_artifact_files (id, artifact_id, design_id, path, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id, path) DO UPDATE SET role = excluded.role`,
    );
    for (const ref of input.fileRefs ?? []) {
      insertFile.run(crypto.randomUUID(), id, input.designId, ref.path, ref.role, now);
    }
  });
  tx();
  return getGameArtifact(db, input.designId, id) as GameArtifact;
}

export function updateGameArtifact(db: Database, input: GameArtifactUpdateInput): GameArtifact {
  const existing = getGameArtifact(db, input.designId, input.artifactId);
  if (existing === null) {
    throw new Error(`game_artifact ${input.artifactId} not found in design ${input.designId}`);
  }
  const now = new Date().toISOString();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof input.name === 'string' && input.name.length > 0) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.metadataPatch !== undefined) {
    const merged = GameArtifactMetadataSchema.parse({
      ...existing.metadata,
      ...input.metadataPatch,
      kind: existing.kind,
    });
    sets.push('metadata_json = ?');
    values.push(JSON.stringify(merged));
  }
  if (input.primaryFilePath !== undefined) {
    sets.push('primary_file_path = ?');
    values.push(input.primaryFilePath);
  }
  if (input.previewFilePath !== undefined) {
    sets.push('preview_file_path = ?');
    values.push(input.previewFilePath);
  }
  if (input.thumbnailPath !== undefined) {
    sets.push('thumbnail_path = ?');
    values.push(input.thumbnailPath);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    values.push(input.status);
  }
  sets.push('updated_at = ?');
  values.push(now);
  values.push(input.artifactId);
  const tx = db.transaction(() => {
    if (sets.length > 1) {
      // sets always includes updated_at; only run UPDATE if the caller
      // supplied at least one real field beyond the timestamp.
      db.prepare(`UPDATE game_artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    if (input.fileRefsRemove !== undefined && input.fileRefsRemove.length > 0) {
      const stmt = db.prepare('DELETE FROM game_artifact_files WHERE artifact_id = ? AND path = ?');
      for (const path of input.fileRefsRemove) {
        stmt.run(input.artifactId, path);
      }
    }
    if (input.fileRefsAdd !== undefined && input.fileRefsAdd.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO game_artifact_files (id, artifact_id, design_id, path, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id, path) DO UPDATE SET role = excluded.role`,
      );
      for (const ref of input.fileRefsAdd) {
        stmt.run(crypto.randomUUID(), input.artifactId, input.designId, ref.path, ref.role, now);
      }
    }
  });
  tx();
  return getGameArtifact(db, input.designId, input.artifactId) as GameArtifact;
}

export function archiveGameArtifact(
  db: Database,
  designId: string,
  artifactId: string,
): GameArtifact | null {
  const existing = getGameArtifact(db, designId, artifactId);
  if (existing === null) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE game_artifacts SET status = 'archived', updated_at = ? WHERE id = ? AND design_id = ?`,
  ).run(now, artifactId, designId);
  return getGameArtifact(db, designId, artifactId);
}

export function getGameArtifact(
  db: Database,
  designId: string,
  artifactId: string,
): GameArtifact | null {
  const row = db
    .prepare('SELECT * FROM game_artifacts WHERE design_id = ? AND id = ?')
    .get(designId, artifactId) as GameArtifactRow | undefined;
  if (row === undefined) return null;
  const files = listArtifactFiles(db, artifactId);
  return rowToArtifact(row, files);
}

export function listGameArtifacts(
  db: Database,
  designId: string,
  filter?: { kind?: GameArtifactKind; includeArchived?: boolean },
): GameArtifact[] {
  const where: string[] = ['design_id = ?'];
  const params: unknown[] = [designId];
  if (filter?.kind !== undefined) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter?.includeArchived !== true) {
    where.push("status != 'archived'");
  }
  const rows = db
    .prepare(
      `SELECT * FROM game_artifacts
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(...params) as GameArtifactRow[];
  if (rows.length === 0) return [];
  // Bulk-fetch the files for these artifacts in one query so the listing
  // path doesn't fan out to N+1 queries on large registries.
  const placeholders = rows.map(() => '?').join(',');
  const fileRows = db
    .prepare(
      `SELECT * FROM game_artifact_files WHERE artifact_id IN (${placeholders}) ORDER BY path ASC`,
    )
    .all(...rows.map((r) => r.id)) as GameArtifactFileRow[];
  const filesByArtifact = new Map<string, GameArtifactFile[]>();
  for (const f of fileRows) {
    const list = filesByArtifact.get(f.artifact_id) ?? [];
    list.push(rowToFile(f));
    filesByArtifact.set(f.artifact_id, list);
  }
  return rows.map((r) => rowToArtifact(r, filesByArtifact.get(r.id) ?? []));
}

export function findGameArtifactBySlug(
  db: Database,
  designId: string,
  kind: GameArtifactKind,
  slug: string,
): GameArtifact | null {
  const row = db
    .prepare('SELECT * FROM game_artifacts WHERE design_id = ? AND kind = ? AND slug = ?')
    .get(designId, kind, slug) as GameArtifactRow | undefined;
  if (row === undefined) return null;
  return rowToArtifact(row, listArtifactFiles(db, row.id));
}

export function findGameArtifactByAlias(
  db: Database,
  designId: string,
  alias: string,
): GameArtifact | null {
  const row = db
    .prepare('SELECT * FROM game_artifacts WHERE design_id = ? AND prompt_alias = ?')
    .get(designId, alias) as GameArtifactRow | undefined;
  if (row === undefined) return null;
  return rowToArtifact(row, listArtifactFiles(db, row.id));
}

export function findGameArtifactsByFilePath(
  db: Database,
  designId: string,
  path: string,
): GameArtifact[] {
  const rows = db
    .prepare(
      `SELECT a.*
         FROM game_artifacts a
         JOIN game_artifact_files f ON f.artifact_id = a.id
        WHERE a.design_id = ? AND f.path = ?`,
    )
    .all(designId, path) as GameArtifactRow[];
  return rows.map((r) => rowToArtifact(r, listArtifactFiles(db, r.id)));
}

export function addGameArtifactFile(
  db: Database,
  designId: string,
  artifactId: string,
  ref: GameArtifactFileRefInput,
): GameArtifactFile {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO game_artifact_files (id, artifact_id, design_id, path, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id, path) DO UPDATE SET role = excluded.role`,
  ).run(id, artifactId, designId, ref.path, ref.role, now);
  // Bump artifact updated_at so the listing order reflects the change.
  db.prepare('UPDATE game_artifacts SET updated_at = ? WHERE id = ?').run(now, artifactId);
  const row = db
    .prepare('SELECT * FROM game_artifact_files WHERE artifact_id = ? AND path = ?')
    .get(artifactId, ref.path) as GameArtifactFileRow;
  return rowToFile(row);
}

export function removeGameArtifactFile(db: Database, artifactId: string, path: string): boolean {
  const result = db
    .prepare('DELETE FROM game_artifact_files WHERE artifact_id = ? AND path = ?')
    .run(artifactId, path);
  if (result.changes > 0) {
    db.prepare('UPDATE game_artifacts SET updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      artifactId,
    );
  }
  return result.changes > 0;
}

export interface CreateAnimationBindingInput {
  designId: string;
  animationId: string;
  spriteId: string;
  bindingStatus?: GameAnimationBindingStatus;
  retarget?: unknown;
}

export function createAnimationBinding(
  db: Database,
  input: CreateAnimationBindingInput,
): GameAnimationBinding {
  const animation = getGameArtifact(db, input.designId, input.animationId);
  const sprite = getGameArtifact(db, input.designId, input.spriteId);
  if (animation === null || animation.kind !== 'animation') {
    throw new Error(`animation ${input.animationId} not found or wrong kind`);
  }
  if (sprite === null || sprite.kind !== 'sprite') {
    throw new Error(`sprite ${input.spriteId} not found or wrong kind`);
  }
  const id = `gab_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const status = input.bindingStatus ?? 'compatible';
  db.prepare(
    `INSERT INTO game_animation_bindings
       (id, design_id, animation_id, sprite_id, binding_status, retarget_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(animation_id, sprite_id) DO UPDATE SET
       binding_status = excluded.binding_status,
       retarget_json  = excluded.retarget_json,
       updated_at     = excluded.updated_at`,
  ).run(
    id,
    input.designId,
    input.animationId,
    input.spriteId,
    status,
    JSON.stringify(input.retarget ?? {}),
    now,
    now,
  );
  const row = db
    .prepare('SELECT * FROM game_animation_bindings WHERE animation_id = ? AND sprite_id = ?')
    .get(input.animationId, input.spriteId) as GameAnimationBindingRow;
  return rowToBinding(row);
}

export function deleteAnimationBinding(
  db: Database,
  animationId: string,
  spriteId: string,
): boolean {
  const result = db
    .prepare('DELETE FROM game_animation_bindings WHERE animation_id = ? AND sprite_id = ?')
    .run(animationId, spriteId);
  return result.changes > 0;
}

export function listAnimationBindings(
  db: Database,
  designId: string,
  filter?: { spriteId?: string; animationId?: string },
): GameAnimationBinding[] {
  const where: string[] = ['design_id = ?'];
  const params: unknown[] = [designId];
  if (filter?.spriteId !== undefined) {
    where.push('sprite_id = ?');
    params.push(filter.spriteId);
  }
  if (filter?.animationId !== undefined) {
    where.push('animation_id = ?');
    params.push(filter.animationId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM game_animation_bindings WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
    )
    .all(...params) as GameAnimationBindingRow[];
  return rows.map(rowToBinding);
}

/**
 * Snapshot the live game-artifact registry against `snapshotId`. Idempotent —
 * if a re-snapshot for the same id is requested, the previous rows are
 * cleared first so the snapshot reflects the current state. Called from the
 * same logical flow as `snapshotDesignFiles`.
 */
export function snapshotGameArtifactsForSnapshot(
  db: Database,
  snapshotId: string,
  designId: string,
): { artifacts: number; files: number; bindings: number } {
  const artifactRows = db
    .prepare('SELECT * FROM game_artifacts WHERE design_id = ?')
    .all(designId) as GameArtifactRow[];
  const fileRows = db
    .prepare(
      `SELECT f.* FROM game_artifact_files f
         JOIN game_artifacts a ON a.id = f.artifact_id
        WHERE a.design_id = ?`,
    )
    .all(designId) as GameArtifactFileRow[];
  const bindingRows = db
    .prepare('SELECT * FROM game_animation_bindings WHERE design_id = ?')
    .all(designId) as GameAnimationBindingRow[];

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM game_artifact_file_snapshots
         WHERE artifact_snapshot_id IN (
           SELECT id FROM game_artifact_snapshots WHERE snapshot_id = ?
         )`,
    ).run(snapshotId);
    db.prepare('DELETE FROM game_artifact_snapshots WHERE snapshot_id = ?').run(snapshotId);
    db.prepare('DELETE FROM game_animation_binding_snapshots WHERE snapshot_id = ?').run(
      snapshotId,
    );
    if (artifactRows.length === 0 && bindingRows.length === 0) return;
    const insertArtifact = db.prepare(
      `INSERT INTO game_artifact_snapshots (
         id, schema_version, snapshot_id, artifact_id, design_id, kind, name, slug,
         prompt_alias, status, engine, primary_file_path, preview_file_path,
         thumbnail_path, metadata_json, provenance_json, created_at, updated_at
       )
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const idMap = new Map<string, string>();
    for (const a of artifactRows) {
      const snapId = `gas_${crypto.randomUUID()}`;
      idMap.set(a.id, snapId);
      insertArtifact.run(
        snapId,
        snapshotId,
        a.id,
        a.design_id,
        a.kind,
        a.name,
        a.slug,
        a.prompt_alias,
        a.status,
        a.engine,
        a.primary_file_path,
        a.preview_file_path,
        a.thumbnail_path,
        a.metadata_json,
        a.provenance_json,
        a.created_at,
        a.updated_at,
      );
    }
    const insertFile = db.prepare(
      `INSERT INTO game_artifact_file_snapshots (id, artifact_snapshot_id, path, role)
       VALUES (?, ?, ?, ?)`,
    );
    for (const f of fileRows) {
      const artifactSnapshotId = idMap.get(f.artifact_id);
      if (artifactSnapshotId === undefined) continue;
      insertFile.run(crypto.randomUUID(), artifactSnapshotId, f.path, f.role);
    }
    const insertBinding = db.prepare(
      `INSERT INTO game_animation_binding_snapshots
         (id, snapshot_id, animation_id, sprite_id, binding_status, retarget_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bindingRows) {
      insertBinding.run(
        crypto.randomUUID(),
        snapshotId,
        b.animation_id,
        b.sprite_id,
        b.binding_status,
        b.retarget_json,
        b.created_at,
        b.updated_at,
      );
    }
  });
  tx();
  return {
    artifacts: artifactRows.length,
    files: fileRows.length,
    bindings: bindingRows.length,
  };
}

/**
 * Replace the live registry for `designId` with the snapshot copy keyed to
 * `snapshotId`. The corresponding `restoreSnapshotFiles` covers `design_files`
 * — this helper layers the artifact/binding rows on top so restoring a
 * pre-artifact snapshot resets the registry cleanly (including to empty).
 */
export function restoreGameArtifactsFromSnapshot(
  db: Database,
  designId: string,
  snapshotId: string,
): { artifacts: number; files: number; bindings: number } {
  const artifactRows = db
    .prepare('SELECT * FROM game_artifact_snapshots WHERE snapshot_id = ?')
    .all(snapshotId) as GameArtifactSnapshotRow[];
  const fileRows = db
    .prepare(
      `SELECT f.* FROM game_artifact_file_snapshots f
         JOIN game_artifact_snapshots a ON a.id = f.artifact_snapshot_id
        WHERE a.snapshot_id = ?`,
    )
    .all(snapshotId) as GameArtifactFileSnapshotRow[];
  const bindingRows = db
    .prepare('SELECT * FROM game_animation_binding_snapshots WHERE snapshot_id = ?')
    .all(snapshotId) as GameAnimationBindingSnapshotRow[];

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM game_animation_bindings WHERE design_id = ?').run(designId);
    db.prepare('DELETE FROM game_artifacts WHERE design_id = ?').run(designId);
    if (artifactRows.length === 0 && bindingRows.length === 0) return;
    const insertArtifact = db.prepare(
      `INSERT INTO game_artifacts (
         id, schema_version, design_id, kind, name, slug, prompt_alias, status, engine,
         primary_file_path, preview_file_path, thumbnail_path,
         metadata_json, provenance_json, created_at, updated_at
       )
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of artifactRows) {
      insertArtifact.run(
        a.artifact_id,
        a.design_id,
        a.kind,
        a.name,
        a.slug,
        a.prompt_alias,
        a.status,
        a.engine,
        a.primary_file_path,
        a.preview_file_path,
        a.thumbnail_path,
        a.metadata_json,
        a.provenance_json,
        a.created_at,
        a.updated_at,
      );
    }
    const insertFile = db.prepare(
      `INSERT INTO game_artifact_files (id, artifact_id, design_id, path, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const artifactByFileSnapId = new Map<string, GameArtifactSnapshotRow>();
    for (const a of artifactRows) artifactByFileSnapId.set(a.id, a);
    for (const f of fileRows) {
      const owner = artifactByFileSnapId.get(f.artifact_snapshot_id);
      if (owner === undefined) continue;
      insertFile.run(
        crypto.randomUUID(),
        owner.artifact_id,
        owner.design_id,
        f.path,
        f.role,
        owner.created_at,
      );
    }
    const insertBinding = db.prepare(
      `INSERT INTO game_animation_bindings
         (id, design_id, animation_id, sprite_id, binding_status, retarget_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bindingRows) {
      insertBinding.run(
        `gab_${crypto.randomUUID()}`,
        designId,
        b.animation_id,
        b.sprite_id,
        b.binding_status,
        b.retarget_json,
        b.created_at,
        b.updated_at,
      );
    }
  });
  tx();
  return {
    artifacts: artifactRows.length,
    files: fileRows.length,
    bindings: bindingRows.length,
  };
}

/**
 * Boot-time / first-open seeding for the artifact registry. Called
 * alongside `seedDesignFilesFromLatestSnapshot` when a design is reopened
 * cold so the registry hydrates from the most recent snapshot. Idempotent:
 * skips when the design already has live artifact rows.
 */
export function seedGameArtifactsFromLatestSnapshot(
  db: Database,
  designId: string,
): { artifacts: number; files: number; bindings: number } {
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM game_artifacts WHERE design_id = ?')
    .get(designId) as { n: number };
  if (existing.n > 0) return { artifacts: 0, files: 0, bindings: 0 };
  const latest = db
    .prepare('SELECT id FROM design_snapshots WHERE design_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(designId) as { id: string } | undefined;
  if (latest === undefined) return { artifacts: 0, files: 0, bindings: 0 };
  return restoreGameArtifactsFromSnapshot(db, designId, latest.id);
}

/**
 * Copy every artifact + file ref + binding belonging to `sourceDesignId` into
 * `targetDesignId`. Used by `duplicateDesign` to keep the registry intact
 * across copies. New ids are minted so the duplicate is independent; slugs +
 * aliases are preserved (the target design has none yet, so no collisions).
 */
export function copyGameArtifactsBetweenDesigns(
  db: Database,
  sourceDesignId: string,
  targetDesignId: string,
): { artifacts: number; bindings: number } {
  const artifactRows = db
    .prepare('SELECT * FROM game_artifacts WHERE design_id = ?')
    .all(sourceDesignId) as GameArtifactRow[];
  const fileRows = db
    .prepare(
      `SELECT f.* FROM game_artifact_files f
         JOIN game_artifacts a ON a.id = f.artifact_id
        WHERE a.design_id = ?`,
    )
    .all(sourceDesignId) as GameArtifactFileRow[];
  const bindingRows = db
    .prepare('SELECT * FROM game_animation_bindings WHERE design_id = ?')
    .all(sourceDesignId) as GameAnimationBindingRow[];

  const idMap = new Map<string, string>();
  const tx = db.transaction(() => {
    const insertArtifact = db.prepare(
      `INSERT INTO game_artifacts (
         id, schema_version, design_id, kind, name, slug, prompt_alias, status, engine,
         primary_file_path, preview_file_path, thumbnail_path,
         metadata_json, provenance_json, created_at, updated_at
       )
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of artifactRows) {
      const newId = `ga_${a.kind === 'sprite' ? 'sprite' : 'anim'}_${crypto.randomUUID()}`;
      idMap.set(a.id, newId);
      insertArtifact.run(
        newId,
        targetDesignId,
        a.kind,
        a.name,
        a.slug,
        a.prompt_alias,
        a.status,
        a.engine,
        a.primary_file_path,
        a.preview_file_path,
        a.thumbnail_path,
        a.metadata_json,
        a.provenance_json,
        a.created_at,
        a.updated_at,
      );
    }
    const insertFile = db.prepare(
      `INSERT INTO game_artifact_files (id, artifact_id, design_id, path, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const f of fileRows) {
      const newArtifactId = idMap.get(f.artifact_id);
      if (newArtifactId === undefined) continue;
      insertFile.run(
        crypto.randomUUID(),
        newArtifactId,
        targetDesignId,
        f.path,
        f.role,
        f.created_at,
      );
    }
    const insertBinding = db.prepare(
      `INSERT INTO game_animation_bindings
         (id, design_id, animation_id, sprite_id, binding_status, retarget_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bindingRows) {
      const newAnim = idMap.get(b.animation_id);
      const newSprite = idMap.get(b.sprite_id);
      if (newAnim === undefined || newSprite === undefined) continue;
      insertBinding.run(
        `gab_${crypto.randomUUID()}`,
        targetDesignId,
        newAnim,
        newSprite,
        b.binding_status,
        b.retarget_json,
        b.created_at,
        b.updated_at,
      );
    }
  });
  tx();
  return { artifacts: artifactRows.length, bindings: bindingRows.length };
}
