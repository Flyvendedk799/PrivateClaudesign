/**
 * gameplan §C2 — game-py exporter tests.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportGamePy } from './game-py';

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-py-export-')));
});
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function unzipTo(zipPath: string, destDir: string): Promise<string[]> {
  const ZipFile: typeof import('zip-lib') = await import('zip-lib');
  mkdirSync(destDir, { recursive: true });
  await ZipFile.extract(zipPath, destDir);
  const { readdirSync } = await import('node:fs');
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

describe('exportGamePy', () => {
  it('produces a runnable Pygame project zip with the required scaffolding', async () => {
    const dest = join(workDir, 'game.zip');
    const result = await exportGamePy(dest, {
      files: [
        {
          path: 'main.py',
          content: 'import asyncio\nimport pygame\n\nasync def main():\n    pygame.init()\n',
        },
        { path: 'entities/__init__.py', content: '' },
        {
          path: 'entities/player.py',
          content: 'import pygame\n\nclass Player:\n    pass\n',
        },
        {
          path: 'assets/sprites/hero.png',
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
      designName: 'Topdown Adventure',
      engineVersion: '2.5.5',
    });
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);

    const extracted = await unzipTo(dest, join(workDir, 'unzipped'));
    expect(extracted).toContain('main.py');
    expect(extracted).toContain('entities/__init__.py');
    expect(extracted).toContain('entities/player.py');
    expect(extracted).toContain('assets/sprites/hero.png');
    expect(extracted).toContain('requirements.txt');
    expect(extracted).toContain('.gitignore');
    expect(extracted).toContain('README.md');
  });

  it('writes a single-line requirements.txt pinning pygame-ce', async () => {
    const dest = join(workDir, 'req.zip');
    await exportGamePy(dest, {
      files: [{ path: 'main.py', content: 'import pygame\n' }],
      engineVersion: '2.5.5',
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    const req = readFileSync(join(extracted, 'requirements.txt'), 'utf8');
    expect(req.trim()).toBe('pygame-ce==2.5.5');
  });

  it('writes a Python-shaped .gitignore that excludes __pycache__ + .venv', async () => {
    const dest = join(workDir, 'gi.zip');
    await exportGamePy(dest, {
      files: [{ path: 'main.py', content: 'import pygame\n' }],
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    const gi = readFileSync(join(extracted, '.gitignore'), 'utf8');
    expect(gi).toContain('__pycache__/');
    expect(gi).toContain('*.pyc');
    expect(gi).toContain('.venv/');
  });

  it('writes a README that names the venv + pip path', async () => {
    const dest = join(workDir, 'readme.zip');
    await exportGamePy(dest, {
      files: [{ path: 'main.py', content: 'import pygame\n' }],
      designName: 'My Pygame',
      engineVersion: '2.5.5',
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    const readme = readFileSync(join(extracted, 'README.md'), 'utf8');
    expect(readme).toContain('My Pygame');
    expect(readme).toContain('python3 -m venv');
    expect(readme).toContain('pip install -r requirements.txt');
    expect(readme).toContain('python main.py');
    expect(readme).toContain('Pygame 2.5.5');
  });

  it('drops __pycache__ + *.pyc + *.pyo files even if they slipped into the bundle', async () => {
    const dest = join(workDir, 'clean.zip');
    await exportGamePy(dest, {
      files: [
        { path: 'main.py', content: 'import pygame\n' },
        { path: 'entities/__pycache__/player.cpython-313.pyc', content: Buffer.from([0xff]) },
        { path: 'main.cpython-313.pyc', content: Buffer.from([0xff]) },
        { path: 'foo.pyo', content: Buffer.from([0xff]) },
      ],
    });
    const extracted = await unzipTo(dest, join(workDir, 'unzipped'));
    expect(extracted).toContain('main.py');
    for (const path of extracted) {
      expect(path).not.toContain('__pycache__');
      expect(path.endsWith('.pyc')).toBe(false);
      expect(path.endsWith('.pyo')).toBe(false);
    }
  });

  it('does not overwrite a user-authored requirements.txt / .gitignore / README', async () => {
    const dest = join(workDir, 'authored.zip');
    await exportGamePy(dest, {
      files: [
        { path: 'main.py', content: 'import pygame\n' },
        { path: 'requirements.txt', content: 'pygame-ce==2.5.5\nnumpy==2.0.0\n' },
        { path: '.gitignore', content: '# custom\nlocal-only/\n' },
        { path: 'README.md', content: '# Custom README\nDont overwrite.\n' },
      ],
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    expect(readFileSync(join(extracted, 'requirements.txt'), 'utf8')).toContain('numpy==2.0.0');
    expect(readFileSync(join(extracted, '.gitignore'), 'utf8')).toContain('# custom');
    expect(readFileSync(join(extracted, 'README.md'), 'utf8')).toContain('Custom README');
  });

  it('throws when main.py is missing (non-runnable archive)', async () => {
    const dest = join(workDir, 'no-main.zip');
    await expect(
      exportGamePy(dest, {
        files: [{ path: 'entities/player.py', content: 'class Player: pass\n' }],
      }),
    ).rejects.toThrow(/main\.py entry point/);
  });

  it('throws when given an empty file list', async () => {
    const dest = join(workDir, 'empty.zip');
    await expect(exportGamePy(dest, { files: [] })).rejects.toThrow(/empty file list/);
  });
});
