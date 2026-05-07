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
/**
 * Design-mode sibling scheme — same on-disk lookup (design_files), same
 * URL shape (`design-files://designs/{id}/{path}`), but no synthesizer
 * and no `_build/*` namespace. Registered alongside `game-files://` so
 * the design-mode preview iframe can load multi-file artifacts via
 * native FS semantics (relative URLs, ES modules, dynamic fetch).
 */
export const DESIGN_FILES_SCHEME = 'design-files';

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

export const DESIGN_FILES_PRIVILEGED_SCHEME: GameFilesPrivilegedScheme = {
  scheme: DESIGN_FILES_SCHEME,
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

/** Parse a `<scheme>://designs/{id}/{path}` URL. Returns null on any
 *  shape mismatch — caller turns that into a 404. The scheme is a parameter
 *  so the same parser handles both `game-files://` and `design-files://`. */
function parseFilesUrl(rawUrl: string, scheme: string): ParsedGameFilesUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:`) return null;
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

/** Parse a `game-files://designs/{id}/{path}` URL. Returns null on any
 *  shape mismatch — caller turns that into a 404. */
export function parseGameFilesUrl(rawUrl: string): ParsedGameFilesUrl | null {
  return parseFilesUrl(rawUrl, GAME_FILES_SCHEME);
}

/** Parse a `design-files://designs/{id}/{path}` URL. Same shape as
 *  game-files but no `_build/*` semantics — design-mode never needs
 *  the Godot web export namespace. */
export function parseDesignFilesUrl(rawUrl: string): ParsedGameFilesUrl | null {
  const parsed = parseFilesUrl(rawUrl, DESIGN_FILES_SCHEME);
  if (parsed === null) return null;
  // Design-mode never serves the `_build/*` namespace — that's
  // game-mode-only. Reject up front so callers get a clean 404
  // instead of going through the build resolver.
  if (parsed.isBuild) return null;
  return parsed;
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

/** Synthesizer for paths the design didn't author but that the engine
 *  needs to boot. Returns null when there's nothing to synthesize.
 *  Production wiring: pygame designs get an index.html via
 *  `pygameAdapter.bootstrap()` + a manifest.json listing every .py /
 *  asset file in design_files. The agent never authors these, so
 *  the protocol fills them in transparently.
 *
 *  game-artifacts §3 — sprite/animation `__preview/*` synthesis hooks
 *  receive the URL search params so they can read `artifactId` /
 *  `spriteId` without re-parsing. Earlier callers passed only path; the
 *  third arg is optional and defaults to an empty record for back-compat. */
export type GameFilesSynthesize = (
  designId: string,
  path: string,
  searchParams?: URLSearchParams,
) => { contentType: string; body: Uint8Array } | null;

/** Pure resolver — Vitest-testable. The protocol handler shim wraps this
 *  with electron's `Response` constructor. */
export function resolveGameFilesRequest(input: {
  rawUrl: string;
  db: Database.Database;
  synthesize?: GameFilesSynthesize;
}): GameFilesResolved {
  const parsed = parseGameFilesUrl(input.rawUrl);
  if (parsed === null) return NOT_FOUND;

  // _build paths flow through the async resolver — call
  // `resolveGameFilesBuildRequest` from the protocol handler. Reaching
  // this branch via the sync entry means the caller didn't dispatch on
  // isBuild; respond 404 with COOP/COEP set so the browser still treats
  // the response as part of the cross-origin-isolated context.
  if (parsed.isBuild) {
    return {
      ...NOT_FOUND,
      crossOriginIsolated: true,
    };
  }

  const row = input.db
    .prepare('SELECT content FROM design_files WHERE design_id = ? AND path = ?')
    .get(parsed.designId, parsed.path) as { content: string } | undefined;
  if (row === undefined) {
    // Fall through to the synthesizer — pygame's index.html / manifest.json
    // and the game-artifacts `__preview/*` previews have no design_files
    // row but are needed at preview time.
    if (input.synthesize) {
      let searchParams: URLSearchParams | undefined;
      try {
        searchParams = new URL(input.rawUrl).searchParams;
      } catch {
        searchParams = undefined;
      }
      const synth = input.synthesize(parsed.designId, parsed.path, searchParams);
      if (synth !== null) {
        return {
          status: 200,
          contentType: synth.contentType,
          body: synth.body,
          crossOriginIsolated: false,
        };
      }
    }
    return NOT_FOUND;
  }

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

/** Pure resolver for `design-files://` URLs. Same on-disk lookup as
 *  the game-mode resolver, minus the `_build/*` namespace and the
 *  pygame synthesizer — design mode doesn't need either. */
export function resolveDesignFilesRequest(input: {
  rawUrl: string;
  db: Database.Database;
}): GameFilesResolved {
  const parsed = parseDesignFilesUrl(input.rawUrl);
  if (parsed === null) return NOT_FOUND;
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

/** Async resolver for `_build/*` paths. Looks the build dir up via the
 *  injected lookup (`getGodotWebBuildDir(designId)` in production), then
 *  reads the file from disk through the injected reader (`readGodotBuildFile`).
 *
 *  Returns 404 when:
 *   - the URL doesn't shape-check
 *   - the URL targets a non-`_build` path (caller dispatched wrong)
 *   - no build is registered for the designId
 *   - the file is missing under the build dir, or path traversal escapes it
 *
 *  Always emits COOP/COEP because Godot's web export needs cross-origin
 *  isolation to use SharedArrayBuffer (without it, the WASM thread pool
 *  refuses to start). */
export async function resolveGameFilesBuildRequest(input: {
  rawUrl: string;
  getBuildDir: (designId: string) => string | null;
  readBuildFile: (buildDir: string, relPath: string) => Promise<{ body: Buffer } | null>;
}): Promise<GameFilesResolved> {
  const parsed = parseGameFilesUrl(input.rawUrl);
  if (parsed === null || !parsed.isBuild) {
    return { ...NOT_FOUND, crossOriginIsolated: true };
  }
  const buildDir = input.getBuildDir(parsed.designId);
  if (buildDir === null) {
    return { ...NOT_FOUND, crossOriginIsolated: true };
  }
  const file = await input.readBuildFile(buildDir, parsed.path);
  if (file === null) {
    return { ...NOT_FOUND, crossOriginIsolated: true };
  }
  return {
    status: 200,
    contentType: contentTypeFromPath(parsed.path),
    body: Uint8Array.from(file.body),
    crossOriginIsolated: true,
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
