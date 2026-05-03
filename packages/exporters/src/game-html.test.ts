/**
 * gameplan §A7 — game-html exporter tests.
 *
 * Mocks the global `fetch` to avoid hitting cdn.jsdelivr.net during CI.
 * The exporter's offline-bundling logic is what we want to verify; the
 * actual network shape is exercised by the manual smoke checklist.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportGameHtml } from './game-html';

const FAKE_THREE_SOURCE = '/* three.js stub */\nexport const THREE = {};';
const FAKE_PHASER_SOURCE = '/* phaser stub */\nexport default class Phaser {}';

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-game-html-')));
  // Stub fetch so tests don't hit the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      const body = u.includes('three@') ? FAKE_THREE_SOURCE : FAKE_PHASER_SOURCE;
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
      } as Response;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('exportGameHtml', () => {
  it('produces a single offline file with the engine inlined as a data: URL', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html>
<html><head>
<base href="game-files://designs/abc-123/" />
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;
    const result = await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        {
          path: 'src/main.js',
          content: "import * as THREE from 'three'; const scene = new THREE();",
        },
      ],
      engine: 'three',
    });
    expect(result.path).toBe(dest);
    const written = readFileSync(dest, 'utf8');
    // Engine library inlined as data: URL — original CDN URL is gone.
    expect(written).not.toContain('cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js');
    expect(written).toContain('data:text/javascript;base64,');
    // Module script for src/main.js was rewritten to a data: URL.
    expect(written).toMatch(/<script type="module" src="data:text\/javascript;base64,/);
    // <base href> was stripped — file: URLs need none.
    expect(written).not.toContain('<base ');
  });

  it('rejects engines other than three / phaser', async () => {
    const dest = join(workDir, 'game.html');
    await expect(
      exportGameHtml(dest, {
        files: [{ path: 'index.html', content: '<html></html>' }],
        engine: 'pygame' as never,
      }),
    ).rejects.toThrow(/browser-engine-only|game-html.*does not support/);
  });

  it('throws when the file bundle is missing index.html', async () => {
    const dest = join(workDir, 'game.html');
    await expect(
      exportGameHtml(dest, {
        files: [{ path: 'src/main.js', content: 'console.log(1);' }],
        engine: 'phaser',
      }),
    ).rejects.toThrow(/index\.html entry point/);
  });

  it('inlines binary assets as data: URLs and rewrites path references', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js"}}</script>
</head><body>
<img src="assets/logo.png" />
<script type="module" src="src/main.js"></script>
</body></html>`;
    await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        { path: 'src/main.js', content: "this.load.image('logo', 'assets/logo.png');" },
        { path: 'assets/logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
      engine: 'phaser',
    });
    const written = readFileSync(dest, 'utf8');
    expect(written).toContain('data:image/png;base64,iVBORw==');
    // The asset path string in the HTML body was replaced with the data URL.
    expect(written).not.toMatch(/<img[^>]*src=["']assets\/logo\.png["']/);
  });

  it('honours pinnedVersion override when fetching the engine', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js"}}</script>
</head><body><canvas id="game"></canvas></body></html>`;
    await exportGameHtml(dest, {
      files: [{ path: 'index.html', content: indexHtml }],
      engine: 'three',
      engineVersion: '0.171.0',
    });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js',
    );
  });

  it('surfaces a clear error when the engine fetch fails (network down)', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: () => Promise.resolve('') }) as Response),
    );
    const dest = join(workDir, 'game.html');
    await expect(
      exportGameHtml(dest, {
        files: [
          {
            path: 'index.html',
            content:
              '<html><head><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script></head><body></body></html>',
          },
        ],
        engine: 'three',
      }),
    ).rejects.toThrow(/Failed to fetch the three library/);
  });
});
