/**
 * motion-graphics-plan §4 / §6 — `motion-files://` privileged scheme.
 *
 * Mirrors `game-files://` byte-for-byte (security posture, parser, COOP
 * headers) but resolves against the on-disk `<design>/.bundle/` dir
 * produced by the motion bundler. Source files (`src/Root.tsx` etc.)
 * are written by the agent's text_editor into the same on-disk dir; the
 * bundler watches that dir and emits `<design>/.bundle/index.js` +
 * `<design>/.bundle/index.html`.
 *
 * URL shape:
 *   motion-files://designs/{designId}/{path}
 *
 * Common consumers:
 *   - The renderer's <iframe> targets
 *     motion-files://designs/{id}/.bundle/index.html?compositionId=...
 *   - The shell template fetches motion-files://designs/{id}/.bundle/index.js
 */

import { readFile } from 'node:fs/promises';
import { join, normalize, relative, sep } from 'node:path';
import { contentTypeFromPath } from './snapshots-db';

export const MOTION_FILES_SCHEME = 'motion-files';

export interface MotionFilesPrivilegedScheme {
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

export const MOTION_FILES_PRIVILEGED_SCHEME: MotionFilesPrivilegedScheme = {
  scheme: MOTION_FILES_SCHEME,
  privileges: {
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    bypassCSP: false,
    standard: true,
  },
};

export interface ParsedMotionFilesUrl {
  designId: string;
  /** POSIX-relative path inside the design's on-disk dir, no leading slash. */
  path: string;
}

export function parseMotionFilesUrl(rawUrl: string): ParsedMotionFilesUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${MOTION_FILES_SCHEME}:`) return null;
  if (url.host !== 'designs') return null;
  const trimmed = url.pathname.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  if (slash < 0) return null;
  const designId = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  if (designId.length === 0 || rest.length === 0) return null;
  if (rest.includes('..')) return null;
  return { designId, path: rest };
}

export interface MotionFilesResolved {
  status: number;
  contentType: string;
  body: Uint8Array;
}

const NOT_FOUND: MotionFilesResolved = {
  status: 404,
  contentType: 'text/plain',
  body: new TextEncoder().encode('Not found'),
};

/** Resolve a parsed URL to a file body via an injected `getDesignDir`
 *  function (so tests can drive without Electron). */
export async function resolveMotionFilesRequest(input: {
  rawUrl: string;
  getDesignDir: (designId: string) => string | null;
  read?: (absPath: string) => Promise<Buffer | null>;
}): Promise<MotionFilesResolved> {
  const parsed = parseMotionFilesUrl(input.rawUrl);
  if (parsed === null) return NOT_FOUND;
  const dir = input.getDesignDir(parsed.designId);
  if (dir === null) return NOT_FOUND;
  const absPath = normalize(join(dir, parsed.path));
  const rel = relative(dir, absPath);
  // Reject any path that escapes the design dir.
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || rel === '..') return NOT_FOUND;
  const reader =
    input.read ??
    (async (p: string) => {
      try {
        return await readFile(p);
      } catch {
        return null;
      }
    });
  const body = await reader(absPath);
  if (body === null) return NOT_FOUND;
  return {
    status: 200,
    contentType: contentTypeFromPath(parsed.path),
    body: Uint8Array.from(body),
  };
}

export function motionFilesResponseHeaders(resolved: MotionFilesResolved): Record<string, string> {
  return {
    'content-type': resolved.contentType,
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'cross-origin',
  };
}
