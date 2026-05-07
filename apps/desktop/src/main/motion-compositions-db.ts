/**
 * motion-graphics-plan §1 — SQLite registry for Remotion compositions.
 *
 * Mirrors the game-artifacts pattern: per-design rows + a snapshot table
 * captured alongside design_snapshots. Schema is appended in
 * snapshots-db.ts under the `motion_compositions_v1` db_meta marker.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MotionCompositionRow } from './motion-mode-runtime';

const SCHEMA_VERSION = 1;

interface RawRow {
  id: string;
  design_id: string;
  composition_id: string;
  name: string;
  duration_in_frames: number;
  fps: number;
  width: number;
  height: number;
  entry_file: string;
  schema_version: number;
  created_at: number;
  updated_at: number;
}

function rowToRecord(row: RawRow): MotionCompositionRow {
  return {
    id: row.id,
    designId: row.design_id,
    compositionId: row.composition_id,
    name: row.name,
    durationInFrames: row.duration_in_frames,
    fps: row.fps,
    width: row.width,
    height: row.height,
    entryFile: row.entry_file,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMotionCompositions(
  db: Database.Database,
  designId: string,
): MotionCompositionRow[] {
  const rows = db
    .prepare('SELECT * FROM motion_compositions WHERE design_id = ? ORDER BY created_at ASC')
    .all(designId) as RawRow[];
  return rows.map(rowToRecord);
}

export function insertMotionComposition(
  db: Database.Database,
  input: {
    designId: string;
    compositionId: string;
    name: string;
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
    entryFile: string;
  },
): MotionCompositionRow {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO motion_compositions (
       id, schema_version, design_id, composition_id, name,
       duration_in_frames, fps, width, height, entry_file,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    SCHEMA_VERSION,
    input.designId,
    input.compositionId,
    input.name,
    input.durationInFrames,
    input.fps,
    input.width,
    input.height,
    input.entryFile,
    now,
    now,
  );
  return {
    id,
    designId: input.designId,
    compositionId: input.compositionId,
    name: input.name,
    durationInFrames: input.durationInFrames,
    fps: input.fps,
    width: input.width,
    height: input.height,
    entryFile: input.entryFile,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertMotionComposition(
  db: Database.Database,
  input: {
    designId: string;
    compositionId: string;
    name: string;
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
    entryFile: string;
  },
): MotionCompositionRow {
  const existing = db
    .prepare('SELECT * FROM motion_compositions WHERE design_id = ? AND composition_id = ?')
    .get(input.designId, input.compositionId) as RawRow | undefined;
  const now = Date.now();
  if (existing === undefined) {
    return insertMotionComposition(db, input);
  }
  db.prepare(
    `UPDATE motion_compositions
       SET name = ?, duration_in_frames = ?, fps = ?, width = ?, height = ?, entry_file = ?, updated_at = ?
       WHERE id = ?`,
  ).run(
    input.name,
    input.durationInFrames,
    input.fps,
    input.width,
    input.height,
    input.entryFile,
    now,
    existing.id,
  );
  return {
    id: existing.id,
    designId: existing.design_id,
    compositionId: existing.composition_id,
    name: input.name,
    durationInFrames: input.durationInFrames,
    fps: input.fps,
    width: input.width,
    height: input.height,
    entryFile: input.entryFile,
    createdAt: existing.created_at,
    updatedAt: now,
  };
}

export function deleteMotionCompositionsForDesign(db: Database.Database, designId: string): void {
  db.prepare('DELETE FROM motion_compositions WHERE design_id = ?').run(designId);
}
