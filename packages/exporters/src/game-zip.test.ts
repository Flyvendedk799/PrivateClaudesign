/**
 * gameplan §A7 — game-zip exporter tests.
 *
 * Round-trips: write a multi-file bundle as zip → unzip into a temp
 * directory → assert the layout matches and the README mentions the
 * engine + how-to-run hint.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportGameZip } from './game-zip';

let workDir = '';

beforeEach(() => {
  // macOS /var → /private/var symlink trips zip-lib's extract guard,
  // so resolve to the canonical path up front (matches zip.test.ts).
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-game-zip-')));
});
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function unzipTo(zipPath: string, destDir: string): Promise<string[]> {
  const ZipFile: typeof import('zip-lib') = await import('zip-lib');
  const { mkdirSync, readdirSync, statSync } = await import('node:fs');
  mkdirSync(destDir, { recursive: true });
  await ZipFile.extract(zipPath, destDir);
  const out: string[] = [];
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  }
  walk(destDir, '');
  return out.sort();
}

describe('exportGameZip', () => {
  it('produces a portable zip with the project tree intact', async () => {
    const dest = join(workDir, 'out.zip');
    const result = await exportGameZip(dest, {
      files: [
        { path: 'index.html', content: '<!doctype html><body><div id="game"></div></body>' },
        { path: 'src/main.js', content: "import Phaser from 'phaser';" },
        { path: 'assets/paddle.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
      designName: 'Pong',
      engine: 'phaser',
      engineVersion: '3.88.0',
    });
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);

    const extractDir = join(workDir, 'unzipped');
    const entries = await unzipTo(dest, extractDir);
    expect(entries).toContain('index.html');
    expect(entries).toContain('src/main.js');
    expect(entries).toContain('assets/paddle.png');
    expect(entries).toContain('README.md');
  });

  it('writes an engine-aware README with how-to-run guidance for Three.js', async () => {
    const dest = join(workDir, 'three.zip');
    await exportGameZip(dest, {
      files: [{ path: 'index.html', content: '<html></html>' }],
      designName: 'Endless Runner',
      engine: 'three',
      engineVersion: '0.170.0',
    });
    const extractDir = join(workDir, 'unzipped');
    await unzipTo(dest, extractDir);
    const readme = readFileSync(join(extractDir, 'README.md'), 'utf8');
    expect(readme).toContain('Endless Runner');
    expect(readme).toContain('Three.js 0.170.0');
    expect(readme).toContain('python3 -m http.server');
  });

  it('writes a Pygame-shaped README (venv + pip install)', async () => {
    const dest = join(workDir, 'py.zip');
    await exportGameZip(dest, {
      files: [{ path: 'main.py', content: 'import pygame' }],
      engine: 'pygame',
      engineVersion: '2.5.5',
    });
    const extractDir = join(workDir, 'unzipped');
    await unzipTo(dest, extractDir);
    const readme = readFileSync(join(extractDir, 'README.md'), 'utf8');
    expect(readme).toContain('Pygame 2.5.5');
    expect(readme).toContain('python3 -m venv');
    expect(readme).toContain('pip install -r requirements.txt');
  });

  it('writes a Godot-shaped README (open in Godot)', async () => {
    const dest = join(workDir, 'godot.zip');
    await exportGameZip(dest, {
      files: [{ path: 'project.godot', content: '[application]\nname="RPG"' }],
      engine: 'godot',
    });
    const extractDir = join(workDir, 'unzipped');
    await unzipTo(dest, extractDir);
    const readme = readFileSync(join(extractDir, 'README.md'), 'utf8');
    expect(readme).toContain('Open `project.godot`');
  });

  it('does not overwrite a model-authored README', async () => {
    const dest = join(workDir, 'authored.zip');
    await exportGameZip(dest, {
      files: [
        { path: 'index.html', content: '<html></html>' },
        { path: 'README.md', content: '# Custom README\nDont overwrite me.' },
      ],
      engine: 'three',
    });
    const extractDir = join(workDir, 'unzipped');
    await unzipTo(dest, extractDir);
    const readme = readFileSync(join(extractDir, 'README.md'), 'utf8');
    expect(readme).toContain('Custom README');
    expect(readme).toContain('Dont overwrite me');
  });

  it('throws when given an empty file list', async () => {
    const dest = join(workDir, 'empty.zip');
    await expect(
      exportGameZip(dest, {
        files: [],
        engine: 'phaser',
      }),
    ).rejects.toThrow(/empty file list/);
  });
});
