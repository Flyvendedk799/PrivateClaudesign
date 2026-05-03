/**
 * gameplan §3 + §7.1 + §7.6 — Phaser engine adapter tests.
 */

import { describe, expect, it } from 'vitest';
import { phaserAdapter } from './phaser';

describe('phaserAdapter shape (gameplan §7.1)', () => {
  it('exposes the gameplan-locked metadata', () => {
    expect(phaserAdapter.id).toBe('phaser');
    expect(phaserAdapter.label).toBe('Phaser');
    expect(phaserAdapter.defaultVersion).toBe('3.88.0');
    expect(phaserAdapter.canonicalEntry).toBe('index.html');
    expect(phaserAdapter.supportsLivePreview()).toBe(true);
  });
});

describe('phaserAdapter.bootstrap (gameplan §3 + §7.3)', () => {
  const opts = {
    designId: 'abc-123',
    gameBaseUrl: 'game-files://designs/abc-123/',
  };

  it('emits a doctype + the pinned phaser@3.88.0 ESM importmap', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('"phaser":');
    expect(html).toContain('https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js');
  });

  it('honours pinnedVersion override', () => {
    const html = phaserAdapter.bootstrap({ ...opts, pinnedVersion: '3.89.0' });
    expect(html).toContain('phaser@3.89.0');
  });

  it('injects <base href> against the game-files:// URL', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html).toContain('<base href="game-files://designs/abc-123/"');
  });

  it('sets up the cross-engine __game global with engine="phaser"', () => {
    const html = phaserAdapter.bootstrap({
      ...opts,
      initialParams: { paddle_speed: 8 },
    });
    expect(html).toContain('window.__game.engine = "phaser"');
    expect(html).toContain('"paddle_speed":8');
  });

  it('mounts a <div id="game"> + module script slot', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html).toContain('<div id="game">');
    expect(html).toContain('<script type="module" src="src/main.js">');
  });

  it('declares the playtest debug contract with a default snapshot getter', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html).toContain('window.__game.debug');
    expect(html).toContain('snapshot: function () { return null; }');
  });
});

describe('phaserAdapter.validate (gameplan §7.6)', () => {
  const goodIndex = `<!doctype html><html><head>
    <script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js"}}</script>
    </head><body><div id="game"></div></body></html>`;
  const goodMain = `
    import Phaser from 'phaser';
    class PlayScene extends Phaser.Scene {
      preload() { this.load.image('paddle', 'assets/paddle.png'); }
      create() { this.add.image(100, 100, 'paddle'); }
      update() {}
    }
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game',
      width: 800, height: 600,
      physics: { default: 'arcade', arcade: { gravity: { y: 300 } } },
      scene: [PlayScene],
    });
  `;

  it('returns ok for a well-formed Phaser project', () => {
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(true);
  });

  it('flags missing index.html as a hard error', () => {
    const result = phaserAdapter.validate([{ path: 'src/main.js', content: goodMain }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('index.html is missing'))).toBe(true);
  });

  it('warns when the Phaser version drifts off 3.88.x', () => {
    const driftedIndex = `<!doctype html><html><head>
      <script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@4.0.0-alpha.1/dist/phaser.esm.js"}}</script>
      </head><body><div id="game"></div></body></html>`;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: driftedIndex },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const drift = result.issues.find((i) => i.message.includes('phaser@3.88.x'));
    expect(drift?.severity).toBe('warn');
  });

  it('flags missing Phaser.Game/Scene as a hard error', () => {
    const noPhaser = `
      const x = 1;
      console.log(x);
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noPhaser },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('Phaser.Scene'))).toBe(true);
  });

  it('warns when a scene declares no lifecycle methods', () => {
    const noLifecycle = `
      import Phaser from 'phaser';
      class HollowScene extends Phaser.Scene { constructor() { super(); } }
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        physics: { default: 'arcade' },
        scene: [HollowScene],
      });
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noLifecycle },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const warn = result.issues.find((i) => i.message.includes('lifecycle methods'));
    expect(warn?.severity).toBe('warn');
  });

  it('flags this.physics.add.* without a physics block in the game config', () => {
    const physicsMissing = `
      import Phaser from 'phaser';
      class PlayScene extends Phaser.Scene {
        create() { this.physics.add.sprite(100, 100, 'player'); }
        update() {}
      }
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        scene: [PlayScene],
      });
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: physicsMissing },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('physics: { default'))).toBe(true);
  });

  it('flags this.add.image with an unloaded asset key', () => {
    const orphanKey = `
      import Phaser from 'phaser';
      class PlayScene extends Phaser.Scene {
        preload() { this.load.image('paddle', 'assets/paddle.png'); }
        create() {
          this.add.image(100, 100, 'paddle');
          this.add.image(200, 200, 'ghost-asset');
        }
        update() {}
      }
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        physics: { default: 'arcade' },
        scene: [PlayScene],
      });
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: orphanKey },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some(
        (i) => i.message.includes('"ghost-asset"') && i.message.includes('never loaded'),
      ),
    ).toBe(true);
  });

  it('flags eval / new Function as a hard error', () => {
    const evilMain = `${goodMain}
      const f = eval('1+1');
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: evilMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('eval / new Function'))).toBe(true);
  });
});
