/**
 * Manifest builder for the sprite/animation preview adapters. The
 * `__preview/manifest.json` synthesizer fetches one of these shapes; the
 * preview shell consumes them via `fetch()` and renders the inspect scene
 * with stable file URLs that resolve through the existing `game-files://`
 * protocol.
 *
 * The DB is the source of truth — this module only translates artifact
 * rows into the renderer-facing manifest shape (no caching, no inference
 * beyond what `getGameArtifact` already returns).
 */

import type { GameArtifactPreviewManifest } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { getGameArtifact, listAnimationBindings } from './game-artifacts-db';

type Database = BetterSqlite3.Database;

function getEnginePin(db: Database, designId: string): GameArtifactPreviewManifest['engine'] {
  const row = db
    .prepare(
      `SELECT engine FROM design_snapshots
        WHERE design_id = ? AND engine IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(designId) as { engine: string | null } | undefined;
  const engine = row?.engine;
  if (engine === 'three' || engine === 'phaser' || engine === 'pygame' || engine === 'godot') {
    return engine;
  }
  // Default to three for the preview adapter — the inspect scene works for
  // any engine because it doesn't run the game itself.
  return 'three';
}

export function buildSpritePreviewManifest(
  db: Database,
  designId: string,
  spriteId: string,
): GameArtifactPreviewManifest | null {
  const sprite = getGameArtifact(db, designId, spriteId);
  if (sprite === null || sprite.kind !== 'sprite') return null;
  return {
    schemaVersion: 1,
    designId,
    engine: getEnginePin(db, designId),
    mode: 'sprite',
    sprite: {
      id: sprite.id,
      name: sprite.name,
      metadata: sprite.metadata.kind === 'sprite' ? sprite.metadata : (sprite.metadata as never),
      files: sprite.files.map((f) => ({
        path: f.path,
        role: f.role,
        url: `game-files://designs/${designId}/${f.path}`,
      })),
    },
  };
}

export function buildAnimationPreviewManifest(
  db: Database,
  designId: string,
  animationId: string,
  spriteId: string,
): GameArtifactPreviewManifest | null {
  const animation = getGameArtifact(db, designId, animationId);
  const sprite = getGameArtifact(db, designId, spriteId);
  if (animation === null || animation.kind !== 'animation') return null;
  if (sprite === null || sprite.kind !== 'sprite') return null;
  const bindings = listAnimationBindings(db, designId, { animationId, spriteId });
  const binding = bindings[0] ?? null;
  return {
    schemaVersion: 1,
    designId,
    engine: getEnginePin(db, designId),
    mode: 'animation',
    sprite: {
      id: sprite.id,
      name: sprite.name,
      metadata: sprite.metadata.kind === 'sprite' ? sprite.metadata : (sprite.metadata as never),
      files: sprite.files.map((f) => ({
        path: f.path,
        role: f.role,
        url: `game-files://designs/${designId}/${f.path}`,
      })),
    },
    animation: {
      id: animation.id,
      name: animation.name,
      metadata:
        animation.metadata.kind === 'animation'
          ? animation.metadata
          : (animation.metadata as never),
      files: animation.files.map((f) => ({
        path: f.path,
        role: f.role,
        url: `game-files://designs/${designId}/${f.path}`,
      })),
      binding: {
        spriteId,
        bindingStatus: binding?.bindingStatus ?? 'broken',
        retarget: binding?.retarget ?? {},
      },
    },
  };
}
