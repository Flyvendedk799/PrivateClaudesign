/**
 * may9 Phase 8 follow-up #27 — Phaser trigger-zone reachability lint.
 *
 * The FPS Wave Defense run shipped a level whose exit zone centroid
 * was outside the walkable area. The Phaser validator now parses
 * Tiled JSON, walks objectgroup layers, and flags out-of-bounds
 * centroids.
 */
import { describe, expect, it } from 'vitest';
import { phaserAdapter } from './phaser';

describe('phaserValidate — trigger-zone reachability (Phase 8 #27)', () => {
  const baseIndexHtml = `<!doctype html><html><body><div id="game"></div>
<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.2/dist/phaser.esm.js"}}</script>
<script type="module">
import Phaser from 'phaser';
class PlayScene extends Phaser.Scene { create() {} update() {} }
new Phaser.Game({ type: Phaser.AUTO, scene: [PlayScene] });
</script></body></html>`;

  const baseSrc =
    "import Phaser from 'phaser'; class PlayScene extends Phaser.Scene { create(){} update(){} }";

  it('FLAGS a trigger object whose centroid is outside the map bounds', () => {
    const tilemapJson = JSON.stringify({
      width: 30, // cols
      height: 20, // rows
      tilewidth: 32,
      tileheight: 32,
      layers: [
        {
          type: 'objectgroup',
          objects: [
            { id: 1, name: 'exit-zone', x: 9999, y: 50, width: 32, height: 32 }, // way past mapW
          ],
        },
      ],
    });
    const result = phaserAdapter.validate([
      { path: 'index.html', content: baseIndexHtml },
      { path: 'src/scene.js', content: baseSrc },
      { path: 'levels/level1.json', content: tilemapJson },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const triggerIssue = result.issues.find((i) =>
        i.message.includes('geometry.unreachable_trigger'),
      );
      expect(triggerIssue).toBeDefined();
      expect(triggerIssue?.message).toContain('exit-zone');
    }
  });

  it('PASSES when all triggers are inside the map bounds', () => {
    const tilemapJson = JSON.stringify({
      width: 30,
      height: 20,
      tilewidth: 32,
      tileheight: 32,
      layers: [
        {
          type: 'objectgroup',
          objects: [
            { id: 1, name: 'exit-zone', x: 800, y: 300, width: 32, height: 32 }, // safely inside 960×640
          ],
        },
      ],
    });
    const result = phaserAdapter.validate([
      { path: 'index.html', content: baseIndexHtml },
      { path: 'src/scene.js', content: baseSrc },
      { path: 'levels/level1.json', content: tilemapJson },
    ]);
    // The result may still have other warnings but no geometry.unreachable_trigger.
    if (!result.ok) {
      const triggerIssue = result.issues.find((i) =>
        i.message.includes('geometry.unreachable_trigger'),
      );
      expect(triggerIssue).toBeUndefined();
    }
  });

  it('IGNORES non-Tiled JSON files (no false positives)', () => {
    const result = phaserAdapter.validate([
      { path: 'index.html', content: baseIndexHtml },
      { path: 'src/scene.js', content: baseSrc },
      { path: 'package.json', content: JSON.stringify({ name: 'mygame', version: '1.0.0' }) },
      { path: 'config.json', content: JSON.stringify({ difficulty: 'hard', music: 'on' }) },
    ]);
    if (!result.ok) {
      const triggerIssue = result.issues.find((i) =>
        i.message.includes('geometry.unreachable_trigger'),
      );
      expect(triggerIssue).toBeUndefined();
    }
  });

  it('SKIPS layers that are not objectgroups', () => {
    const tilemapJson = JSON.stringify({
      width: 30,
      height: 20,
      tilewidth: 32,
      tileheight: 32,
      layers: [
        { type: 'tilelayer', data: [0, 1, 2] },
        { type: 'imagelayer', image: 'bg.png' },
      ],
    });
    const result = phaserAdapter.validate([
      { path: 'index.html', content: baseIndexHtml },
      { path: 'src/scene.js', content: baseSrc },
      { path: 'levels/level1.json', content: tilemapJson },
    ]);
    if (!result.ok) {
      const triggerIssue = result.issues.find((i) =>
        i.message.includes('geometry.unreachable_trigger'),
      );
      expect(triggerIssue).toBeUndefined();
    }
  });
});
