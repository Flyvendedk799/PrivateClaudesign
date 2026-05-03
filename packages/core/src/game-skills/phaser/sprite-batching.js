// when_to_use: Loading + animating sprite atlases in Phaser. Shows the
// pre-load → atlas frames → AnimatedSprite chain that prevents the
// orphan-asset-key validator hit.

import Phaser from 'phaser';

/** Preload helper — call inside your scene's preload(). Loads a Phaser
 *  multi-atlas (PNG + JSON sidecar) plus a flat spritesheet for simple
 *  uniform-grid sprites. */
export function preloadSpriteBank(scene, manifest) {
  for (const [key, def] of Object.entries(manifest)) {
    if (def.type === 'atlas') {
      // PNG + JSON pair (Texture Packer format)
      scene.load.atlas(key, def.png, def.json);
    } else if (def.type === 'spritesheet') {
      // Uniform-grid spritesheet — `frameWidth` x `frameHeight` per cell
      scene.load.spritesheet(key, def.path, {
        frameWidth: def.frameWidth,
        frameHeight: def.frameHeight,
        margin: def.margin ?? 0,
        spacing: def.spacing ?? 0,
      });
    } else {
      scene.load.image(key, def.path);
    }
  }
}

/** Register named animations against a previously-loaded atlas/sheet.
 *  Call inside your scene's create(). The validator tolerates animations
 *  that reference loaded keys; orphan keys still fail. */
export function registerAnimations(scene, animations) {
  for (const [animKey, def] of Object.entries(animations)) {
    if (scene.anims.exists(animKey)) continue;
    const frames =
      def.frames !== undefined
        ? def.frames.map((f) => ({ key: def.textureKey, frame: f }))
        : scene.anims.generateFrameNumbers(def.textureKey, {
            start: def.start ?? 0,
            end: def.end ?? 0,
          });
    scene.anims.create({
      key: animKey,
      frames,
      frameRate: def.frameRate ?? 8,
      repeat: def.repeat ?? -1, // -1 = loop forever
    });
  }
}

// Usage:
//   class PlayScene extends Phaser.Scene {
//     preload() {
//       preloadSpriteBank(this, {
//         player: { type: 'spritesheet', path: 'assets/sprites/player.png',
//                   frameWidth: 32, frameHeight: 32 },
//         enemies: { type: 'atlas', png: 'assets/sprites/enemies.png',
//                    json: 'assets/sprites/enemies.json' },
//       });
//     }
//     create() {
//       registerAnimations(this, {
//         'player-run': { textureKey: 'player', start: 0, end: 5, frameRate: 12 },
//         'player-idle': { textureKey: 'player', frames: [6], repeat: 0 },
//       });
//       this.player = this.physics.add.sprite(100, 100, 'player');
//       this.player.play('player-run');
//     }
//   }
