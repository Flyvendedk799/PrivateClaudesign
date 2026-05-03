/**
 * gameplan §C2 — game-pyodide-html exporter tests.
 *
 * These tests verify the produced HTML's structure (manifest shape, Pyodide
 * loader URL, base64 round-trip). The exporter does NOT fetch anything at
 * export time (Pyodide stays on CDN), so no fetch stub is needed.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportGamePyodideHtml } from './game-pyodide-html';

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-pyodide-html-')));
});
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('exportGamePyodideHtml', () => {
  it('produces a single-file HTML with main.py + assets inlined as base64', async () => {
    const dest = join(workDir, 'game.html');
    const mainPy = 'import pygame\npygame.init()\nscreen = pygame.display.set_mode((400, 300))\n';
    const result = await exportGamePyodideHtml(dest, {
      files: [
        { path: 'main.py', content: mainPy },
        { path: 'assets/sprite.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
      designName: 'My Pygame',
    });
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);

    const html = readFileSync(dest, 'utf8');
    expect(html).toContain('<title>My Pygame</title>');
    // Pyodide loader on CDN, version-pinned.
    expect(html).toContain('cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
    // pygame-ce package load.
    expect(html).toContain("loadPackage(['pygame-ce==2.5.5']");
    // Manifest mounting logic.
    expect(html).toContain("py.FS.writeFile('/home/pyodide/'");
    expect(html).toContain("py.FS.chdir('/home/pyodide')");
    // main.py source inlined as base64 inside the manifest.
    const mainPyB64 = Buffer.from(mainPy, 'utf8').toString('base64');
    expect(html).toContain(mainPyB64);
    // PNG header bytes inlined as base64.
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    expect(html).toContain(pngB64);
  });

  it('embeds the manifest as a parseable JSON script tag', async () => {
    const dest = join(workDir, 'manifest.html');
    await exportGamePyodideHtml(dest, {
      files: [
        { path: 'main.py', content: 'pass\n' },
        { path: 'systems/audio.py', content: 'pass\n' },
      ],
    });
    const html = readFileSync(dest, 'utf8');
    const match = html.match(
      /<script id="pygame-manifest" type="application\/json">(.*?)<\/script>/s,
    );
    expect(match).not.toBeNull();
    const manifest = JSON.parse(match?.[1] ?? '[]') as Array<{ path: string; b64: string }>;
    expect(manifest.length).toBe(2);
    expect(manifest.map((e) => e.path).sort()).toEqual(['main.py', 'systems/audio.py']);
    for (const entry of manifest) {
      // every entry round-trips to UTF-8 'pass\n' for these inputs
      expect(Buffer.from(entry.b64, 'base64').toString('utf8')).toBe('pass\n');
    }
  });

  it('respects custom Pyodide and pygame-ce versions', async () => {
    const dest = join(workDir, 'pinned.html');
    await exportGamePyodideHtml(dest, {
      files: [{ path: 'main.py', content: 'pass\n' }],
      pyodideVersion: '0.27.0',
      engineVersion: '2.6.0',
    });
    const html = readFileSync(dest, 'utf8');
    expect(html).toContain('cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js');
    expect(html).toContain("loadPackage(['pygame-ce==2.6.0']");
  });

  it('seeds window.__game with the engine + default config so skills do not crash', async () => {
    const dest = join(workDir, 'shim.html');
    await exportGamePyodideHtml(dest, {
      files: [{ path: 'main.py', content: 'pass\n' }],
    });
    const html = readFileSync(dest, 'utf8');
    expect(html).toContain('window.__game');
    expect(html).toContain("engine: 'pygame'");
    expect(html).toContain('startMuted: false');
  });

  it('drops a stray index.html from the bundle (the exporter generates its own)', async () => {
    const dest = join(workDir, 'no-index.html');
    await exportGamePyodideHtml(dest, {
      files: [
        { path: 'main.py', content: 'pass\n' },
        // Suppose the bundle also held the iframe index.html — it must not
        // be inlined into the manifest, which would either confuse Pyodide
        // or shadow the exporter's outer HTML.
        { path: 'index.html', content: '<html>iframe shell</html>' },
      ],
    });
    const html = readFileSync(dest, 'utf8');
    const match = html.match(
      /<script id="pygame-manifest" type="application\/json">(.*?)<\/script>/s,
    );
    const manifest = JSON.parse(match?.[1] ?? '[]') as Array<{ path: string }>;
    expect(manifest.map((e) => e.path)).not.toContain('index.html');
  });

  it('html-escapes the design name in the <title> tag', async () => {
    const dest = join(workDir, 'escaped.html');
    await exportGamePyodideHtml(dest, {
      files: [{ path: 'main.py', content: 'pass\n' }],
      designName: '<script>alert(1)</script>',
    });
    const html = readFileSync(dest, 'utf8');
    expect(html).not.toContain('<title><script>alert(1)</script></title>');
    expect(html).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
  });

  it('throws when main.py is missing', async () => {
    const dest = join(workDir, 'no-main.html');
    await expect(
      exportGamePyodideHtml(dest, {
        files: [{ path: 'systems/audio.py', content: 'pass\n' }],
      }),
    ).rejects.toThrow(/main\.py entry point/);
  });

  it('throws when given an empty file list', async () => {
    const dest = join(workDir, 'empty.html');
    await expect(exportGamePyodideHtml(dest, { files: [] })).rejects.toThrow(/empty file list/);
  });
});
