/**
 * UNITY_PIPELINE.md §U4 — locate `steamcmd` on the host machine.
 *
 * Steamworks SDK ships steamcmd separately. Users install it via:
 *   - macOS: brew install steamcmd  → /opt/homebrew/bin/steamcmd or /usr/local/bin/steamcmd
 *   - Linux: apt install steamcmd / pacman -S steamcmd
 *   - Windows: download from https://partner.steamgames.com/doc/sdk/uploading
 *
 * We refuse to bundle steamcmd ourselves (CLAUDE.md §1: no bundled runtimes).
 * When absent, the "Ship to Steam" button greys out with an install link.
 *
 * Pure-ish: filesystem + env are dependency-injected. Default factory uses
 * `node:fs` + `process.env.PATH`.
 */

import { existsSync } from 'node:fs';
import { posix as posixPath, win32 as win32Path } from 'node:path';

export type SteamCmdStatus = { ok: true; path: string } | { ok: false; reason: 'missing' };

export interface SteamCmdDeps {
  pathEnv: string;
  exists(p: string): boolean;
  /** Override candidate paths for tests / unusual installs. */
  extraCandidates?: readonly string[];
  platform: NodeJS.Platform;
}

export function defaultSteamCmdDeps(): SteamCmdDeps {
  return {
    pathEnv: process.env['PATH'] ?? '',
    exists: (p) => existsSync(p),
    platform: process.platform,
  };
}

const MAC_CANDIDATES = [
  '/opt/homebrew/bin/steamcmd',
  '/usr/local/bin/steamcmd',
  '/Applications/steamcmd/steamcmd.sh',
];

const LINUX_CANDIDATES = ['/usr/games/steamcmd', '/usr/bin/steamcmd', '/usr/local/bin/steamcmd'];

const WIN_CANDIDATES = ['C:\\steamcmd\\steamcmd.exe', 'C:\\Program Files\\steamcmd\\steamcmd.exe'];

export function findSteamCmd(deps: SteamCmdDeps = defaultSteamCmdDeps()): SteamCmdStatus {
  // Use platform-aware path helpers — tests on macOS that exercise win32
  // paths can't rely on the host-driven `node:path` defaults.
  const pathHelpers = deps.platform === 'win32' ? win32Path : posixPath;
  if (deps.pathEnv.length > 0) {
    const dirs = deps.pathEnv.split(pathHelpers.delimiter);
    const binaryName = deps.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd';
    for (const dir of dirs) {
      if (dir.length === 0) continue;
      const candidate = pathHelpers.join(dir, binaryName);
      if (deps.exists(candidate)) return { ok: true, path: candidate };
    }
  }
  // Standard install locations.
  const builtins =
    deps.platform === 'darwin'
      ? MAC_CANDIDATES
      : deps.platform === 'win32'
        ? WIN_CANDIDATES
        : LINUX_CANDIDATES;
  const all = [...(deps.extraCandidates ?? []), ...builtins];
  for (const p of all) {
    if (deps.exists(p)) return { ok: true, path: p };
  }
  return { ok: false, reason: 'missing' };
}
