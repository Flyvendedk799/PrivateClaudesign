/**
 * gameplan §D — Pure web-build pipeline. The IPC layer wraps this with
 * channel registration + electron progress events; the build itself is
 * file-system + child_process work and stays testable in isolation.
 *
 * Build steps:
 *   1. Materialize the design's project files into a per-design build
 *      root (`<base>/<designId>/project/`). Reused across builds so
 *      Godot's `.godot/` import cache survives, dropping subsequent
 *      build times from 10-20s cold to 3-6s warm.
 *   2. Write a `Web` export preset into `export_presets.cfg` if absent.
 *   3. Materialize an export_presets.cfg.preset bookkeeping shim Godot
 *      requires.
 *   4. Spawn `godot --headless --export-release Web <build-out>/index.html`.
 *   5. Read back the produced files (index.html, .js, .wasm, .pck, etc.)
 *      and return their absolute build dir for protocol-handler lookup.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const SENTINEL_BASE64 = 'data:base64,';

export interface DesignFile {
  /** Project-relative POSIX path. */
  path: string;
  /** Either raw text content OR a `data:base64,<...>` sentinel for binary. */
  content: string;
}

export interface SpawnGodotResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface GodotBuildDeps {
  /** Lists the design's project files. Production reads from SQLite via
   *  `listDesignFiles` in snapshots-db; tests pass a fixed array. */
  listFiles: (designId: string) => DesignFile[];
  /** Absolute path to the godot binary the user has installed. The IPC
   *  layer fills this from `detectGodotCli`. */
  godotBin: string;
  /** Root dir under which per-design build trees live. Production uses
   *  `app.getPath('temp')/codesign-godot-web`; tests pass a tmpdir. */
  buildRoot: string;
  /** Optional progress callback — IPC pipes this into webContents.send. */
  onProgress?: (event: GodotBuildProgress) => void;
  /** Injectable spawner. Production uses node:child_process.spawn via
   *  `defaultSpawnGodot`; tests stub the result. Receives the absolute
   *  binary path, the args, and the cwd. Optionally writes stdout /
   *  stderr lines through `onStdout` / `onStderr` for live progress. */
  spawnGodot?: (
    bin: string,
    args: readonly string[],
    cwd: string,
    onStdout: (line: string) => void,
    onStderr: (line: string) => void,
  ) => Promise<SpawnGodotResult>;
}

/** Production spawner. Runs the binary, line-buffers its stdio, resolves
 *  with the captured streams + exit code. */
export async function defaultSpawnGodot(
  bin: string,
  args: readonly string[],
  cwd: string,
  onStdout: (line: string) => void,
  onStderr: (line: string) => void,
): Promise<SpawnGodotResult> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [...args], { cwd });
    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stdout += s;
      for (const line of s.split(/\r?\n/)) if (line.length > 0) onStdout(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stderr += s;
      for (const line of s.split(/\r?\n/)) if (line.length > 0) onStderr(line);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      exitCode = code;
      resolve();
    });
  });
  return { stdout, stderr, exitCode };
}

export type GodotBuildProgress =
  | { phase: 'materialize'; pct: number }
  | { phase: 'preset' }
  | { phase: 'build:start' }
  | { phase: 'build:stdout'; line: string }
  | { phase: 'build:stderr'; line: string }
  | { phase: 'collect' };

export type GodotBuildResult =
  | { ok: true; buildDir: string; files: string[] }
  | {
      ok: false;
      reason: 'spawn-failed' | 'non-zero-exit' | 'no-output' | 'missing-templates';
      detail: string;
    };

/** Decode `data:base64,XXX` → raw bytes. Plain text returned as utf8 buffer. */
function decodeContent(c: string): Buffer {
  if (c.startsWith(SENTINEL_BASE64)) return Buffer.from(c.slice(SENTINEL_BASE64.length), 'base64');
  return Buffer.from(c, 'utf8');
}

/** Default Web export preset — pinned to Godot 4.3's preset schema. The
 *  custom_template fields stay empty so Godot uses the bundled web
 *  template. Variant=threads enables SharedArrayBuffer (the COOP/COEP
 *  pair the protocol handler emits matches this). */
function defaultExportPresets(designName: string): string {
  return `[preset.0]

name="Web"
platform="Web"
runnable=true
advanced_options=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path="_build/index.html"
encryption_include_filters=""
encryption_exclude_filters=""
encrypt_pck=false
encrypt_directory=false

[preset.0.options]

custom_template/debug=""
custom_template/release=""
variant/extensions_support=false
variant/thread_support=true
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
html/export_icon=true
html/custom_html_shell=""
html/head_include=""
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
html/experimental_virtual_keyboard=false
progressive_web_app/enabled=false
application/name="${designName}"
`;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
  await walk(root);
  return out.sort();
}

/** Top-level build pipeline. Returns a `GodotBuildResult`. */
export async function runGodotWebBuild(
  designId: string,
  deps: GodotBuildDeps,
): Promise<GodotBuildResult> {
  const projectDir = join(deps.buildRoot, designId, 'project');
  const buildOutDir = join(projectDir, '_build');

  // Step 1: materialize files. We DO NOT clean the project dir between
  // builds — Godot's .godot/ + .import/ caches make subsequent runs much
  // faster. We DO clean the _build/ dir so we don't pick up stale files.
  await mkdir(projectDir, { recursive: true });
  await rm(buildOutDir, { recursive: true, force: true });
  await mkdir(buildOutDir, { recursive: true });

  const files = deps.listFiles(designId);
  if (files.length === 0) {
    return {
      ok: false,
      reason: 'no-output',
      detail: 'No project files registered for this design — nothing to build.',
    };
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f === undefined) continue;
    const out = join(projectDir, f.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, decodeContent(f.content));
    if (deps.onProgress !== undefined) {
      deps.onProgress({ phase: 'materialize', pct: Math.round(((i + 1) / files.length) * 100) });
    }
  }

  // Step 2: write export_presets.cfg if the model didn't author one.
  const presetsPath = join(projectDir, 'export_presets.cfg');
  if (!existsSync(presetsPath)) {
    await writeFile(presetsPath, defaultExportPresets(designId), 'utf8');
  }
  if (deps.onProgress !== undefined) deps.onProgress({ phase: 'preset' });

  // Step 3: spawn godot.
  if (deps.onProgress !== undefined) deps.onProgress({ phase: 'build:start' });
  const exportTarget = join(buildOutDir, 'index.html');
  const args = ['--headless', '--export-release', 'Web', exportTarget];
  const spawner = deps.spawnGodot ?? defaultSpawnGodot;
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    const result = await spawner(
      deps.godotBin,
      args,
      projectDir,
      (line) => {
        if (deps.onProgress !== undefined) deps.onProgress({ phase: 'build:stdout', line });
      },
      (line) => {
        if (deps.onProgress !== undefined) deps.onProgress({ phase: 'build:stderr', line });
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (exitCode !== 0) {
    // Godot's most common failure on a fresh install is the missing web
    // export templates. Surface a specific reason so the UI can show the
    // download-templates link instead of generic "build failed."
    const combined = `${stdout}\n${stderr}`;
    if (
      /export template.*not found/i.test(combined) ||
      /no export template available/i.test(combined) ||
      /export template.*missing/i.test(combined)
    ) {
      return {
        ok: false,
        reason: 'missing-templates',
        detail:
          'Godot web-export templates are not installed. Open Godot → Editor → Manage Export Templates → Download to install them, then retry.',
      };
    }
    return {
      ok: false,
      reason: 'non-zero-exit',
      detail: `godot --export-release Web exited with code ${exitCode}.\n\nstdout:\n${stdout.slice(-800)}\n\nstderr:\n${stderr.slice(-800)}`,
    };
  }

  // Step 4: collect produced files. Godot writes them next to the
  // export target (index.html, index.js, index.wasm, index.pck, etc.).
  if (deps.onProgress !== undefined) deps.onProgress({ phase: 'collect' });
  const produced = await listFilesRecursive(buildOutDir);
  if (produced.length === 0 || !produced.includes('index.html')) {
    return {
      ok: false,
      reason: 'no-output',
      detail: 'godot exited successfully but produced no index.html in _build/.',
    };
  }
  return { ok: true, buildDir: buildOutDir, files: produced };
}

/** Resolve a `_build/{path}` request from a registered build dir. Returns
 *  the file's bytes + content type, or null when the path is missing /
 *  outside the build dir. */
export async function readGodotBuildFile(
  buildDir: string,
  relPath: string,
): Promise<{ body: Buffer; mtimeMs: number } | null> {
  // Defence in depth — reject path traversal even though the protocol
  // parser also strips `..` segments before reaching this code.
  if (relPath.includes('..') || relPath.startsWith('/')) return null;
  const full = join(buildDir, relPath);
  const rel = relative(buildDir, full);
  if (rel.startsWith('..') || rel === '') return null;
  try {
    const [body, st] = await Promise.all([readFile(full), stat(full)]);
    return { body, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
