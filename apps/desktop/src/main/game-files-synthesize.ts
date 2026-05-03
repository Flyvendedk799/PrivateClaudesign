/**
 * gameplan A6.x — synthesise game-files responses for files the agent
 * doesn't author but the engine needs at preview time.
 *
 * Pygame is the main consumer: the agent only writes main.py + helper
 * modules, but Pyodide needs an `index.html` to bootstrap and a
 * `manifest.json` so the bootstrap can mount every project file into
 * MEMFS without a directory-listing API.
 *
 * Three.js / Phaser don't synthesize today — the agent authors index.html
 * directly. Godot doesn't either — the build pipeline produces the web
 * runtime via _build/.
 */

import { getEngineAdapter } from '@open-codesign/runtime';
import type Database from 'better-sqlite3';
import type { GameFilesSynthesize } from './game-files-protocol';
import { listDesignFiles } from './snapshots-db';

interface SnapshotEngineRow {
  engine: string | null;
  engine_version: string | null;
}

/** Look up the engine pin for a design via its newest snapshot. Returns
 *  null when no snapshot exists yet (fresh design) or when the snapshot
 *  doesn't carry an engine (design-mode). */
function getDesignEngine(
  db: Database.Database,
  designId: string,
): { engine: string; version: string | null } | null {
  const row = db
    .prepare(
      'SELECT engine, engine_version FROM design_snapshots WHERE design_id = ? AND engine IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(designId) as SnapshotEngineRow | undefined;
  if (row === undefined || row.engine === null) return null;
  return { engine: row.engine, version: row.engine_version };
}

/** Build the manifest.json the pygame bootstrap fetches to populate
 *  Pyodide's MEMFS. Lists every authored project file; bootstrap then
 *  fetches each via game-files:// and writes it into /home/pyodide. */
function buildPygameManifest(db: Database.Database, designId: string): string {
  const files = listDesignFiles(db, designId);
  const paths = files.map((f) => f.path).filter((p) => !p.startsWith('_build/'));
  return JSON.stringify(paths);
}

export function makeGameFilesSynthesizer(db: Database.Database): GameFilesSynthesize {
  return (designId, path) => {
    const engine = getDesignEngine(db, designId);
    if (engine === null) return null;
    if (engine.engine !== 'pygame') return null;

    if (path === 'index.html') {
      const adapter = getEngineAdapter('pygame');
      if (adapter === null) return null;
      const html = adapter.bootstrap({
        designId,
        gameBaseUrl: `game-files://designs/${designId}/`,
        ...(engine.version !== null ? { pinnedVersion: engine.version } : {}),
      });
      return {
        contentType: 'text/html',
        body: new TextEncoder().encode(html),
      };
    }
    if (path === 'manifest.json') {
      return {
        contentType: 'application/json',
        body: new TextEncoder().encode(buildPygameManifest(db, designId)),
      };
    }
    return null;
  };
}
