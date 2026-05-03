/**
 * gameplan §3 + §7.1 + §7.6 — Three.js engine adapter tests.
 */

import { describe, expect, it } from 'vitest';
import { threeAdapter } from './three';

describe('threeAdapter shape (gameplan §7.1)', () => {
  it('exposes the gameplan-locked metadata', () => {
    expect(threeAdapter.id).toBe('three');
    expect(threeAdapter.label).toBe('Three.js');
    expect(threeAdapter.defaultVersion).toBe('0.170.0');
    expect(threeAdapter.canonicalEntry).toBe('index.html');
    expect(threeAdapter.supportsLivePreview()).toBe(true);
  });
});

describe('threeAdapter.bootstrap (gameplan §3 + §7.3)', () => {
  const opts = {
    designId: 'abc-123',
    gameBaseUrl: 'game-files://designs/abc-123/',
  };

  it('emits a doctype + the pinned three@0.170.0 ESM importmap', () => {
    const html = threeAdapter.bootstrap(opts);
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('"three":');
    expect(html).toContain('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js');
    expect(html).toContain('three/addons/');
  });

  it('honours pinnedVersion when supplied', () => {
    const html = threeAdapter.bootstrap({ ...opts, pinnedVersion: '0.171.0' });
    expect(html).toContain('three@0.171.0');
    expect(html).not.toContain('three@0.170.0');
  });

  it('injects <base href> against the game-files:// URL', () => {
    const html = threeAdapter.bootstrap(opts);
    expect(html).toContain('<base href="game-files://designs/abc-123/"');
  });

  it('sets up the cross-engine __game global with engine, params, config', () => {
    const html = threeAdapter.bootstrap({
      ...opts,
      initialParams: { player_speed: 5 },
      startMuted: true,
    });
    expect(html).toContain('window.__game.engine = "three"');
    expect(html).toContain('"player_speed":5');
    expect(html).toContain('"startMuted":true');
  });

  it('mounts a <canvas id="game"> + module script slot', () => {
    const html = threeAdapter.bootstrap(opts);
    expect(html).toContain('<canvas id="game">');
    expect(html).toContain('<script type="module" src="src/main.js">');
  });

  it('declares the playtest debug contract with a default snapshot getter', () => {
    const html = threeAdapter.bootstrap(opts);
    expect(html).toContain('window.__game.debug = window.__game.debug || {');
    expect(html).toContain('snapshot: function () { return null; }');
  });
});

describe('threeAdapter.validate (gameplan §7.6)', () => {
  const goodIndex = `<!doctype html><html><head>
    <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
    </head><body><canvas id="game"></canvas></body></html>`;
  const goodMain = `
    import * as THREE from 'three';
    const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#game') });
    const scene = new THREE.Scene();
    function tick() { requestAnimationFrame(tick); renderer.render(scene); }
    tick();
    window.addEventListener('resize', () => {});
    window.addEventListener('beforeunload', () => renderer.dispose());
  `;

  it('returns ok for a well-formed Three.js project', () => {
    const result = threeAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(true);
  });

  it('flags missing index.html as a hard error', () => {
    const result = threeAdapter.validate([{ path: 'src/main.js', content: goodMain }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('index.html is missing'))).toBe(true);
  });

  it('flags missing importmap as a hard error', () => {
    const result = threeAdapter.validate([
      { path: 'index.html', content: '<html><body><canvas></canvas></body></html>' },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('importmap'))).toBe(true);
  });

  it('warns when the Three.js URL pin is not 0.170.x', () => {
    const driftedIndex = `<!doctype html><html><head>
      <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js"}}</script>
      </head><body><canvas></canvas></body></html>`;
    const result = threeAdapter.validate([
      { path: 'index.html', content: driftedIndex },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const drift = result.issues.find((i) => i.message.includes('three@0.170.x'));
    expect(drift?.severity).toBe('warn');
  });

  it('flags a missing requestAnimationFrame loop as a hard error', () => {
    const noLoop = `
      import * as THREE from 'three';
      const renderer = new THREE.WebGLRenderer();
      window.addEventListener('keydown', () => {});
    `;
    const result = threeAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noLoop },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('requestAnimationFrame'))).toBe(true);
  });

  it('flags a missing WebGLRenderer reference as a hard error', () => {
    const noRenderer = `
      const scene = {};
      function tick() { requestAnimationFrame(tick); }
      tick();
      window.addEventListener('keydown', () => {});
    `;
    const result = threeAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noRenderer },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('WebGLRenderer'))).toBe(true);
  });

  it('flags eval / new Function as a hard error', () => {
    const evilMain = `
      import * as THREE from 'three';
      const renderer = new THREE.WebGLRenderer();
      function tick() { requestAnimationFrame(tick); }
      tick();
      window.addEventListener('keydown', () => {});
      const f = new Function('return 1');
    `;
    const result = threeAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: evilMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('eval / new Function'))).toBe(true);
  });

  it('warns when no input or resize listener is present', () => {
    const noListener = `
      import * as THREE from 'three';
      const renderer = new THREE.WebGLRenderer();
      function tick() { requestAnimationFrame(tick); renderer.render({}, {}); }
      tick();
      renderer.dispose();
    `;
    const result = threeAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noListener },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const warn = result.issues.find((i) => i.message.includes('input or resize listener'));
    expect(warn?.severity).toBe('warn');
  });
});
