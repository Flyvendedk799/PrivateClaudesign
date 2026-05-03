/**
 * gameplan §D — game-godot-web exporter tests.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportGameGodotWeb } from './game-godot-web';

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-godot-web-')));
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

describe('exportGameGodotWeb', () => {
  it('zips a Godot web build with all of the expected runtime files', async () => {
    const dest = join(workDir, 'web.zip');
    const result = await exportGameGodotWeb(dest, {
      files: [
        { path: 'index.html', content: '<!doctype html><html></html>' },
        { path: 'index.js', content: '/* glue */' },
        { path: 'index.wasm', content: Buffer.from([0x00, 0x61, 0x73, 0x6d]) },
        { path: 'index.pck', content: Buffer.from([0xff, 0xff, 0xff]) },
        { path: 'index.audio.worklet.js', content: '/* worklet */' },
        { path: 'index.icon.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
      designName: 'Topdown RPG',
      engineVersion: '4.3',
    });
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);

    const extracted = await unzipTo(dest, join(workDir, 'unzipped'));
    expect(extracted).toContain('index.html');
    expect(extracted).toContain('index.js');
    expect(extracted).toContain('index.wasm');
    expect(extracted).toContain('index.pck');
    expect(extracted).toContain('index.audio.worklet.js');
    expect(extracted).toContain('index.icon.png');
    expect(extracted).toContain('README.md');
  });

  it('writes a README that explains the COOP/COEP requirement', async () => {
    const dest = join(workDir, 'readme.zip');
    await exportGameGodotWeb(dest, {
      files: [
        { path: 'index.html', content: '<html/>' },
        { path: 'index.wasm', content: Buffer.from([0x00, 0x61, 0x73, 0x6d]) },
      ],
      designName: 'My RPG',
      engineVersion: '4.3',
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    const readme = readFileSync(join(extracted, 'README.md'), 'utf8');
    expect(readme).toContain('My RPG');
    expect(readme).toContain('SharedArrayBuffer');
    expect(readme).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(readme).toContain('Cross-Origin-Embedder-Policy: require-corp');
  });

  it('throws when index.html is missing', async () => {
    const dest = join(workDir, 'no-html.zip');
    await expect(
      exportGameGodotWeb(dest, {
        files: [{ path: 'index.wasm', content: Buffer.from([0x00, 0x61, 0x73, 0x6d]) }],
      }),
    ).rejects.toThrow(/index\.html/);
  });

  it('throws when index.wasm is missing', async () => {
    const dest = join(workDir, 'no-wasm.zip');
    await expect(
      exportGameGodotWeb(dest, {
        files: [{ path: 'index.html', content: '<html/>' }],
      }),
    ).rejects.toThrow(/index\.wasm/);
  });

  it('throws when given an empty file list', async () => {
    const dest = join(workDir, 'empty.zip');
    await expect(exportGameGodotWeb(dest, { files: [] })).rejects.toThrow(/empty file list/);
  });

  it('does not overwrite a model-authored README', async () => {
    const dest = join(workDir, 'authored-readme.zip');
    await exportGameGodotWeb(dest, {
      files: [
        { path: 'index.html', content: '<html/>' },
        { path: 'index.wasm', content: Buffer.from([0x00, 0x61, 0x73, 0x6d]) },
        { path: 'README.md', content: '# Custom README\nDont overwrite.\n' },
      ],
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    expect(readFileSync(join(extracted, 'README.md'), 'utf8')).toContain('Custom README');
  });
});
