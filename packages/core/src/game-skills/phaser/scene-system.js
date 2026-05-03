// when_to_use: Boot → Menu → Play → GameOver scene chain for Phaser games
// with > 1 screen. Boot preloads global atlases / fonts; Menu shows title
// + start; Play runs the mechanic; GameOver displays score + restart.
// Pass score data via scene.start's second arg.

import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }
  preload() {
    // Global atlases / fonts loaded once. Subsequent scenes reuse cache.
    this.load.image('logo', 'assets/sprites/logo.png');
  }
  create() {
    this.scene.start('Menu');
  }
}

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }
  create() {
    const w = this.scale.width;
    const h = this.scale.height;
    this.add.image(w / 2, h / 3, 'logo');
    this.add
      .text(w / 2, h / 2, 'Press Space to start', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    this.input.keyboard?.once('keydown-SPACE', () => this.scene.start('Play'));
  }
}

export class GameOverScene extends Phaser.Scene {
  constructor() {
    super('GameOver');
  }
  create(data) {
    const score = data?.score ?? 0;
    const w = this.scale.width;
    const h = this.scale.height;
    this.add
      .text(w / 2, h / 3, 'Game Over', {
        fontFamily: 'monospace',
        fontSize: '48px',
        color: '#ff5555',
      })
      .setOrigin(0.5);
    this.add
      .text(w / 2, h / 2, `Score: ${score}`, {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    this.add
      .text(w / 2, (h * 2) / 3, 'Press R to restart', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#aaaaaa',
      })
      .setOrigin(0.5);
    this.input.keyboard?.once('keydown-R', () => this.scene.start('Play'));
  }
}

// Usage:
//   import { BootScene, MenuScene, GameOverScene } from './scenes/scene-system.js';
//   import { PlayScene } from './scenes/play.js';
//   const game = new Phaser.Game({
//     type: Phaser.AUTO,
//     parent: 'game',
//     width: 800, height: 600,
//     physics: { default: 'arcade' },
//     scene: [BootScene, MenuScene, PlayScene, GameOverScene],
//   });
//   // Inside Play: this.scene.start('GameOver', { score: this.score });
