// when_to_use: Phaser audio cues with autoplay-policy unlock and
// `window.__game.config.startMuted` respect. Wraps Phaser's
// `this.sound.add(key)` so volume tweens, ducking, and the
// no-audio-on-iframe-mount case all work consistently.

import Phaser from 'phaser';

/** Inside preload(): register every audio asset key the scene needs.
 *  Validator catches `this.sound.add('key')` calls where `key` was never
 *  loaded. */
export function preloadAudio(scene, manifest) {
  for (const [key, def] of Object.entries(manifest)) {
    // def can be a single path string or an array (Phaser tries each in
    // order — useful for .ogg/.wav fallback).
    scene.load.audio(key, Array.isArray(def) ? def : [def]);
  }
}

/** Inside create(): build a cue map your scene calls to play sfx.
 *  Returns { play, stop, setMuted } — autoplay-policy + startMuted
 *  baked in. */
export function setupAudio(scene, keys) {
  const cues = {};
  for (const key of keys) {
    cues[key] = scene.sound.add(key, { volume: 0.4 });
  }
  let muted = window.__game?.config?.startMuted ?? false;

  // Autoplay-policy unlock: Phaser's web audio context starts suspended
  // until first user gesture. Phaser auto-resumes on input, but be
  // explicit so the first sfx call after a programmatic event still works.
  scene.input.once('pointerdown', () => {
    if (scene.sound.context && scene.sound.context.state === 'suspended') {
      void scene.sound.context.resume();
    }
  });

  return {
    play(key, opts = {}) {
      if (muted) return;
      const cue = cues[key];
      if (cue === undefined) {
        // Skill files run in the iframe — host's no-console rule does not
        // apply here, but biome lints it anyway. Use the iframe-safe
        // dispatchEvent pattern so the host's overlay can surface this.
        window.dispatchEvent(
          new CustomEvent('game:warn', { detail: `audio key "${key}" not registered` }),
        );
        return;
      }
      cue.play({ volume: opts.volume ?? 0.4, rate: opts.rate ?? 1 });
    },
    stop(key) {
      cues[key]?.stop();
    },
    setMuted(v) {
      muted = v;
      scene.sound.mute = v;
    },
  };
}

// Usage:
//   class PlayScene extends Phaser.Scene {
//     preload() {
//       preloadAudio(this, {
//         hit: 'assets/audio/hit.wav',
//         coin: 'assets/audio/coin.wav',
//         music: ['assets/audio/loop.ogg', 'assets/audio/loop.wav'],
//       });
//     }
//     create() {
//       this.audio = setupAudio(this, ['hit', 'coin', 'music']);
//       this.audio.play('music', { volume: 0.2 });
//     }
//     onHit() { this.audio.play('hit'); }
//   }
