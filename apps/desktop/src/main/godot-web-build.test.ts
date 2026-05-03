/**
 * gameplan §D — godot-web-build pipeline tests. Spawn is injected so the
 * suite runs without a real Godot install.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DesignFile,
  type SpawnGodotResult,
  readGodotBuildFile,
  runGodotWebBuild,
} from './godot-web-build';

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-godot-build-')));
});
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const PROJECT_FILES: DesignFile[] = [
  { path: 'project.godot', content: '[application]\nconfig/name="Test"\n' },
  { path: 'main.tscn', content: '[gd_scene format=3]\n' },
];

function fakeSpawn(result: SpawnGodotResult, sideEffect?: (cwd: string) => Promise<void>) {
  return async (
    _bin: string,
    _args: readonly string[],
    cwd: string,
    onStdout: (line: string) => void,
    onStderr: (line: string) => void,
  ): Promise<SpawnGodotResult> => {
    if (sideEffect) await sideEffect(cwd);
    for (const line of result.stdout.split(/\r?\n/)) if (line.length > 0) onStdout(line);
    for (const line of result.stderr.split(/\r?\n/)) if (line.length > 0) onStderr(line);
    return result;
  };
}

describe('runGodotWebBuild', () => {
  it('materializes project files, writes a default export_presets.cfg, and returns the produced file list', async () => {
    const result = await runGodotWebBuild('design-1', {
      listFiles: () => PROJECT_FILES,
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({ stdout: 'building...\n', stderr: '', exitCode: 0 }, async (cwd) => {
        // Pretend Godot wrote its export output.
        await mkdir(join(cwd, '_build'), { recursive: true });
        await writeFile(join(cwd, '_build', 'index.html'), '<html/>');
        await writeFile(join(cwd, '_build', 'index.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
        await writeFile(join(cwd, '_build', 'index.js'), '/* glue */');
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.sort()).toEqual(['index.html', 'index.js', 'index.wasm']);
    expect(result.buildDir).toBe(join(workDir, 'design-1', 'project', '_build'));

    // Project files were materialized to disk.
    expect(readFileSync(join(workDir, 'design-1', 'project', 'project.godot'), 'utf8')).toContain(
      'config/name="Test"',
    );
    // export_presets.cfg was generated (the model didn't author one).
    expect(
      readFileSync(join(workDir, 'design-1', 'project', 'export_presets.cfg'), 'utf8'),
    ).toContain('platform="Web"');
  });

  it('does not overwrite a model-authored export_presets.cfg', async () => {
    const result = await runGodotWebBuild('design-2', {
      listFiles: () => [
        ...PROJECT_FILES,
        { path: 'export_presets.cfg', content: '[preset.0]\nname="Custom"\n' },
      ],
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({ stdout: '', stderr: '', exitCode: 0 }, async (cwd) => {
        await mkdir(join(cwd, '_build'), { recursive: true });
        await writeFile(join(cwd, '_build', 'index.html'), '<html/>');
      }),
    });
    expect(result.ok).toBe(true);
    expect(
      readFileSync(join(workDir, 'design-2', 'project', 'export_presets.cfg'), 'utf8'),
    ).toContain('name="Custom"');
  });

  it('decodes data:base64 file content into raw bytes on disk', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await runGodotWebBuild('design-3', {
      listFiles: () => [
        ...PROJECT_FILES,
        { path: 'assets/icon.png', content: `data:base64,${pngBytes.toString('base64')}` },
      ],
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({ stdout: '', stderr: '', exitCode: 0 }, async (cwd) => {
        await mkdir(join(cwd, '_build'), { recursive: true });
        await writeFile(join(cwd, '_build', 'index.html'), '<html/>');
      }),
    });
    expect(result.ok).toBe(true);
    const onDisk = readFileSync(join(workDir, 'design-3', 'project', 'assets', 'icon.png'));
    expect(onDisk.equals(pngBytes)).toBe(true);
  });

  it('reports missing-templates when the spawn output mentions missing export templates', async () => {
    const result = await runGodotWebBuild('design-4', {
      listFiles: () => PROJECT_FILES,
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({
        stdout: '',
        stderr: 'ERROR: Web export template not found\n',
        exitCode: 1,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing-templates');
    expect(result.detail).toContain('Manage Export Templates');
  });

  it('reports non-zero-exit with both streams captured for a generic build failure', async () => {
    const result = await runGodotWebBuild('design-5', {
      listFiles: () => PROJECT_FILES,
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({
        stdout: 'compiling shaders...\n',
        stderr: 'ERROR: scripts/main.gd:5 — undeclared identifier "foo"\n',
        exitCode: 1,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('non-zero-exit');
    expect(result.detail).toContain('exited with code 1');
    expect(result.detail).toContain('undeclared identifier');
  });

  it('reports spawn-failed when the spawner throws (binary missing / permission denied)', async () => {
    const result = await runGodotWebBuild('design-6', {
      listFiles: () => PROJECT_FILES,
      godotBin: '/nope',
      buildRoot: workDir,
      spawnGodot: async () => {
        throw new Error('ENOENT spawn /nope');
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn-failed');
    expect(result.detail).toContain('ENOENT');
  });

  it('reports no-output when godot exits 0 but no index.html lands in _build/', async () => {
    const result = await runGodotWebBuild('design-7', {
      listFiles: () => PROJECT_FILES,
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({ stdout: 'silent success\n', stderr: '', exitCode: 0 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-output');
  });

  it('reports no-output when the design has zero project files', async () => {
    const result = await runGodotWebBuild('design-8', {
      listFiles: () => [],
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({ stdout: '', stderr: '', exitCode: 0 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-output');
    expect(result.detail).toContain('No project files');
  });

  it('emits progress events through the materialize, preset, build, and collect phases', async () => {
    const events: string[] = [];
    await runGodotWebBuild('design-9', {
      listFiles: () => PROJECT_FILES,
      godotBin: '/fake/godot',
      buildRoot: workDir,
      onProgress: (e) => events.push(e.phase),
      spawnGodot: fakeSpawn(
        { stdout: 'Saving compressed asset...\n', stderr: '', exitCode: 0 },
        async (cwd) => {
          await mkdir(join(cwd, '_build'), { recursive: true });
          await writeFile(join(cwd, '_build', 'index.html'), '<html/>');
        },
      ),
    });
    expect(events).toContain('materialize');
    expect(events).toContain('preset');
    expect(events).toContain('build:start');
    expect(events).toContain('build:stdout');
    expect(events).toContain('collect');
  });

  it('clears the previous _build dir between runs but preserves the import cache outside it', async () => {
    // Seed a prior build with a stale file + a cache marker.
    const projectDir = join(workDir, 'design-10', 'project');
    await mkdir(join(projectDir, '_build'), { recursive: true });
    writeFileSync(join(projectDir, '_build', 'stale.txt'), 'should be deleted');
    await mkdir(join(projectDir, '.godot'), { recursive: true });
    writeFileSync(join(projectDir, '.godot', 'cache.bin'), 'should survive');

    const result = await runGodotWebBuild('design-10', {
      listFiles: () => PROJECT_FILES,
      godotBin: '/fake/godot',
      buildRoot: workDir,
      spawnGodot: fakeSpawn({ stdout: '', stderr: '', exitCode: 0 }, async (cwd) => {
        await mkdir(join(cwd, '_build'), { recursive: true });
        await writeFile(join(cwd, '_build', 'index.html'), '<html/>');
      }),
    });
    expect(result.ok).toBe(true);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(projectDir, '_build', 'stale.txt'))).toBe(false);
    expect(existsSync(join(projectDir, '.godot', 'cache.bin'))).toBe(true);
  });
});

describe('readGodotBuildFile', () => {
  it('returns the file bytes + mtime for a path inside the build dir', async () => {
    writeFileSync(join(workDir, 'index.html'), '<html/>');
    const got = await readGodotBuildFile(workDir, 'index.html');
    expect(got).not.toBeNull();
    expect(got?.body.toString('utf8')).toBe('<html/>');
    expect(got?.mtimeMs).toBeGreaterThan(0);
  });

  it('returns null for a missing path', async () => {
    expect(await readGodotBuildFile(workDir, 'missing.html')).toBeNull();
  });

  it('rejects path traversal escaping the build dir', async () => {
    expect(await readGodotBuildFile(workDir, '../sneaky.txt')).toBeNull();
  });

  it('rejects an absolute path', async () => {
    expect(await readGodotBuildFile(workDir, '/etc/hosts')).toBeNull();
  });
});
