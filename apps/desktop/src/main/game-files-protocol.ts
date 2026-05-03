/**
 * gameplan §7.2 — `game-files://` privileged scheme.
 *
 * Serves the multi-file project bundle attached to a game-mode design into
 * the preview iframe. URL shape:
 *
 *   game-files://designs/{designId}/{path}
 *   game-files://designs/{designId}/_build/{path}   (Phase D — Godot web export)
 *
 * The scheme MUST be registered as privileged via
 * `protocol.registerSchemesAsPrivileged([gameFilesScheme])` BEFORE
 * `app.whenReady()` resolves; the handler then attaches via
 * `registerGameFilesProtocol(db)` post-ready.
 *
 * Privileges (gameplan §7.2):
 *   - secure: true             — JS scripts can run with module imports
 *   - supportFetchAPI: true    — `fetch('game-files://…')` from inside the iframe works
 *   - corsEnabled: true        — module imports across paths inside the bundle resolve
 *   - stream: true             — large binary assets stream rather than buffer
 *   - bypassCSP: false         — game source is still CSP-checked
 *   - standard: true           — `<base href>` resolution + relative paths
 *
 * Sandbox attributes on the iframe (set in PreviewPane, gameplan §7.4) layer
 * on top of these privileges per engine.
 */

import type Database from 'better-sqlite3';
import { contentTypeFromPath } from './snapshots-db';

export const GAME_FILES_SCHEME = 'game-files';

export interface GameFilesPrivilegedScheme {
  scheme: string;
  privileges: {
    secure: boolean;
    supportFetchAPI: boolean;
    corsEnabled: boolean;
    stream: boolean;
    bypassCSP: boolean;
    standard: boolean;
  };
}

export const GAME_FILES_PRIVILEGED_SCHEME: GameFilesPrivilegedScheme = {
  scheme: GAME_FILES_SCHEME,
  privileges: {
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    bypassCSP: false,
    standard: true,
  },
};

export interface ParsedGameFilesUrl {
  designId: string;
  /** POSIX-style relative path inside the design's file bundle, with no leading slash. */
  path: string;
  /** True when the URL targets the ephemeral `_build/` namespace (Phase D). */
  isBuild: boolean;
}

/** Parse a `game-files://designs/{id}/{path}` URL. Returns null on any
 *  shape mismatch — caller turns that into a 404. */
export function parseGameFilesUrl(rawUrl: string): ParsedGameFilesUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${GAME_FILES_SCHEME}:`) return null;
  // URL.host carries the authority segment (`designs` in our shape). Path
  // captures everything after that — e.g. `/{id}/{path}`. Strip the leading
  // slash + the designId segment to recover the in-bundle path.
  if (url.host !== 'designs') return null;
  const trimmed = url.pathname.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  if (slash < 0) return null;
  const designId = trimmed.slice(0, slash);
  let rest = trimmed.slice(slash + 1);
  if (designId.length === 0 || rest.length === 0) return null;
  // Reject path traversal at the parser layer — defence in depth even
  // though the SQL lookup is keyed by exact match.
  if (rest.includes('..')) return null;
  let isBuild = false;
  if (rest.startsWith('_build/')) {
    isBuild = true;
    rest = rest.slice('_build/'.length);
    if (rest.length === 0) return null;
  }
  return { designId, path: rest, isBuild };
}

export interface GameFilesResolved {
  status: number;
  contentType: string;
  body: Uint8Array;
  /** Set when the resolver wants the protocol response to include
   *  Cross-Origin headers (Phase D Godot web export needs COOP/COEP for
   *  SharedArrayBuffer). The base path leaves these unset. */
  crossOriginIsolated: boolean;
}

const SENTINEL_BASE64 = 'data:base64,';
const NOT_FOUND: GameFilesResolved = {
  status: 404,
  contentType: 'text/plain',
  body: new TextEncoder().encode('Not found'),
  crossOriginIsolated: false,
};

/** Pure resolver — Vitest-testable. The protocol handler shim wraps this
 *  with electron's `Response` constructor. */
export function resolveGameFilesRequest(input: {
  rawUrl: string;
  db: Database.Database;
}): GameFilesResolved {
  const parsed = parseGameFilesUrl(input.rawUrl);
  if (parsed === null) return NOT_FOUND;

  // _build paths (Phase D) are reserved for ephemeral Godot web exports
  // produced by the godot --headless shell-out. Phase A doesn't write
  // anything under that prefix, so respond 404 until Phase D wires it.
  if (parsed.isBuild) {
    return {
      ...NOT_FOUND,
      crossOriginIsolated: true,
    };
  }

  const row = input.db
    .prepare('SELECT content FROM design_files WHERE design_id = ? AND path = ?')
    .get(parsed.designId, parsed.path) as { content: string } | undefined;
  if (row === undefined) return NOT_FOUND;

  const contentType = contentTypeFromPath(parsed.path);
  if (row.content.startsWith(SENTINEL_BASE64)) {
    const b64 = row.content.slice(SENTINEL_BASE64.length);
    let body: Uint8Array;
    try {
      body = Uint8Array.from(Buffer.from(b64, 'base64'));
    } catch {
      return NOT_FOUND;
    }
    return { status: 200, contentType, body, crossOriginIsolated: false };
  }
  return {
    status: 200,
    contentType,
    body: new TextEncoder().encode(row.content),
    crossOriginIsolated: false,
  };
}

/** Build the headers a Response should carry given a resolved entry.
 *  Always sets Cache-Control: no-store so live edits show up. */
export function gameFilesResponseHeaders(resolved: GameFilesResolved): Record<string, string> {
  const base: Record<string, string> = {
    'content-type': resolved.contentType,
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'cross-origin',
  };
  if (resolved.crossOriginIsolated) {
    base['cross-origin-opener-policy'] = 'same-origin';
    base['cross-origin-embedder-policy'] = 'require-corp';
  }
  return base;
}
