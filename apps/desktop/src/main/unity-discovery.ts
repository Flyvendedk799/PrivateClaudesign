/**
 * UNITY_PIPELINE.md §U1 — locate Unity Hub-managed Editor installs.
 *
 * Unity Hub installs each Editor version under a versioned subdirectory:
 *   - macOS: `~/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity`
 *   - Windows: `%PROGRAMFILES%\\Unity\\Hub\\Editor\\<version>\\Editor\\Unity.exe`
 *   - Linux: `~/Unity/Hub/Editor/<version>/Editor/Unity`
 *
 * U1 only enumerates — it does not invoke the binary. U3's `build-unity`
 * tool will pick a discovered editor and run it in `-batchmode`.
 *
 * Pure-ish factory: file system probing is injected so tests run without
 * a real Unity install. Production wiring is at the bottom of the file.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UnityEditor {
  /** Version string as Unity Hub names the directory, e.g. '6000.0.23f1'. */
  version: string;
  /** Absolute path to the Unity executable. */
  path: string;
}

export interface UnityDiscoveryResult {
  hubInstalled: boolean;
  editors: UnityEditor[];
}

export interface UnityDiscoveryDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists(p: string): boolean;
  listDir(p: string): string[];
  isDirectory(p: string): boolean;
}

export function defaultUnityDiscoveryDeps(): UnityDiscoveryDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: (p) => existsSync(p),
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

/** Candidate Hub-Editor root directories per platform. We try each in
 *  order; multiple may resolve (e.g. user installed Hub then moved an
 *  Editor manually) and we merge the results. */
function hubEditorRoots(deps: UnityDiscoveryDeps): string[] {
  const roots: string[] = [];
  if (deps.platform === 'darwin') {
    roots.push(join(deps.home, 'Applications', 'Unity', 'Hub', 'Editor'));
    roots.push('/Applications/Unity/Hub/Editor');
  } else if (deps.platform === 'win32') {
    const pf = deps.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    roots.push(join(pf, 'Unity', 'Hub', 'Editor'));
    const localAppData = deps.env['LOCALAPPDATA'];
    if (localAppData !== undefined) {
      roots.push(join(localAppData, 'Programs', 'Unity', 'Hub', 'Editor'));
    }
  } else {
    // linux + others
    roots.push(join(deps.home, 'Unity', 'Hub', 'Editor'));
  }
  return roots;
}

/** Build the relative-to-version-dir path the Editor binary lives at. */
function editorRelative(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return join('Unity.app', 'Contents', 'MacOS', 'Unity');
  if (platform === 'win32') return join('Editor', 'Unity.exe');
  return join('Editor', 'Unity');
}

export function discoverUnityEditors(
  deps: UnityDiscoveryDeps = defaultUnityDiscoveryDeps(),
): UnityDiscoveryResult {
  const roots = hubEditorRoots(deps);
  const seen = new Map<string, UnityEditor>();
  let hubInstalled = false;
  for (const root of roots) {
    if (!deps.exists(root) || !deps.isDirectory(root)) continue;
    hubInstalled = true;
    for (const name of deps.listDir(root)) {
      const versionDir = join(root, name);
      if (!deps.isDirectory(versionDir)) continue;
      const editorPath = join(versionDir, editorRelative(deps.platform));
      if (!deps.exists(editorPath)) continue;
      // Dedupe by absolute path — same Editor surfaced under both
      // `~/Applications` and `/Applications` shouldn't appear twice.
      if (!seen.has(editorPath)) seen.set(editorPath, { version: name, path: editorPath });
    }
  }
  // Sort newest version first using a basic semver-ish compare.
  const editors = [...seen.values()].sort((a, b) => compareUnityVersions(b.version, a.version));
  return { hubInstalled, editors };
}

/** Compare Unity version strings like '6000.0.23f1' vs '2022.3.18f1'.
 *  Returns negative if a < b, positive if a > b, 0 when equal. */
export function compareUnityVersions(a: string, b: string): number {
  const tokens = (s: string) =>
    s
      .split(/[.\s]/)
      .map((t) => t.replace(/[a-z].*/i, '')) // strip 'f1' / 'b3' suffixes
      .map((t) => Number.parseInt(t, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const ta = tokens(a);
  const tb = tokens(b);
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const av = ta[i] ?? 0;
    const bv = tb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
