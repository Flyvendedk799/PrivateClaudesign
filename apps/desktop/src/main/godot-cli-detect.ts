/**
 * gameplan §D — locate a usable `godot` (or `godot-headless`) binary on the
 * user's PATH and verify its major version. Phase D's "Build web preview"
 * button is gated on this; Settings surfaces the result so the user knows
 * whether to install Godot 4.3+.
 *
 * The detector is pure-ish — file system + child_process are injected so
 * tests can run without a real Godot install. The default factory wires
 * to `node:fs` and `node:child_process` for production.
 *
 * Resolution order (Q-style: prefer the headless build because in-app web
 * builds run with `--headless` anyway, and the headless binary is smaller
 * + sometimes installed alongside the GUI app):
 *   1. `godot-headless` on PATH
 *   2. `godot` on PATH
 *
 * Version parsing handles Godot's canonical `MAJOR.MINOR.PATCH.<status>` —
 * e.g. `4.3.1.stable.official.f06b6836a`. Only MAJOR is enforced (must be
 * >= 4); we do NOT pin a minor because Godot 4.x project format stays
 * compatible across minor versions.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GodotCliStatus =
  | { ok: true; path: string; version: string; major: number; minor: number; patch: number }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'wrong-version'; path: string; version: string; major: number };

export interface GodotCliDeps {
  /** Lists candidate binary names to search for, in priority order. */
  candidateNames: readonly string[];
  /** PATH-string source. Production passes `process.env.PATH ?? ''`. */
  pathEnv: string;
  /** Probe whether a candidate path exists and is a regular/exe file. */
  exists(p: string): boolean;
  /** Run a binary with args and capture stdout. Reject on non-zero exit
   *  OR on the timeout — caller treats both as "binary unusable". */
  runWithVersion(bin: string): Promise<string>;
}

const DEFAULT_CANDIDATES = ['godot-headless', 'godot'] as const;

/** Production deps. `process.platform === 'win32'` adds `.exe` suffixes
 *  to the search list so a Windows PATH lookup works. */
export function defaultGodotCliDeps(): GodotCliDeps {
  const onWindows = process.platform === 'win32';
  const candidates = onWindows
    ? DEFAULT_CANDIDATES.flatMap((c) => [`${c}.exe`, c])
    : [...DEFAULT_CANDIDATES];
  return {
    candidateNames: candidates,
    pathEnv: process.env['PATH'] ?? '',
    exists: (p) => existsSync(p),
    runWithVersion: async (bin) => {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 4000 });
      return stdout;
    },
  };
}

/** Walk PATH and return the first absolute path under which one of the
 *  candidate binary names exists. Null when nothing matched. */
export function findGodotOnPath(deps: GodotCliDeps): string | null {
  if (deps.pathEnv.length === 0) return null;
  const dirs = deps.pathEnv.split(delimiter);
  for (const name of deps.candidateNames) {
    for (const dir of dirs) {
      if (dir.length === 0) continue;
      const candidate = join(dir, name);
      if (deps.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Parse a Godot --version string. Accepts the canonical
 *  `MAJOR.MINOR.PATCH.status...` form and the shorter `MAJOR.MINOR.status`
 *  some early dev-channel builds emit. Returns null on shape mismatch. */
export function parseGodotVersion(
  raw: string,
): { version: string; major: number; minor: number; patch: number } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Take the first non-empty line; --version on some Godot builds emits a
  // banner followed by extra runtime info on subsequent lines.
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? '';
  // Extract leading dotted numerics.
  const match = firstLine.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (match === null) return null;
  const major = Number.parseInt(match[1] ?? '0', 10);
  const minor = Number.parseInt(match[2] ?? '0', 10);
  const patch = match[3] !== undefined ? Number.parseInt(match[3], 10) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { version: firstLine, major, minor, patch };
}

/** Best-effort detection. Returns a discriminated union the renderer can
 *  switch on to render its three states (ok / missing / wrong-version). */
export async function detectGodotCli(
  deps: GodotCliDeps = defaultGodotCliDeps(),
): Promise<GodotCliStatus> {
  const path = findGodotOnPath(deps);
  if (path === null) return { ok: false, reason: 'missing' };

  let stdout: string;
  try {
    stdout = await deps.runWithVersion(path);
  } catch {
    // Couldn't run the binary at all — treat as missing rather than
    // wrong-version so the user sees the install link, not a confusing
    // "wrong version" hint with no version number.
    return { ok: false, reason: 'missing' };
  }

  const parsed = parseGodotVersion(stdout);
  if (parsed === null) {
    // Something at the right path, but its --version doesn't look like
    // Godot. Treat as missing — the install instructions are still the
    // best next step.
    return { ok: false, reason: 'missing' };
  }
  if (parsed.major < 4) {
    return {
      ok: false,
      reason: 'wrong-version',
      path,
      version: parsed.version,
      major: parsed.major,
    };
  }
  return {
    ok: true,
    path,
    version: parsed.version,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
  };
}
