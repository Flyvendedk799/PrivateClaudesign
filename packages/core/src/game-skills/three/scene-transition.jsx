// when_to_use: Crossfade between menu / play / gameover scenes without
// reloading the iframe. Keeps state of inactive scenes alive (so "resume"
// works) but stops their tick. Pair with `startGameLoop` from game-loop.jsx.

import * as THREE from 'three';

export function createSceneManager({ canvas }) {
  const scenes = new Map(); // id -> { scene, camera, onTick, onEnter, onExit }
  let active = null;
  let nextActive = null;
  let fadeProgress = 0; // 0 = no fade, 1 = fully faded out
  let fadeDir = 0; // -1 = fade-out then swap, +1 = fade-in
  const fadeMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthTest: false,
  });
  const fadeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fadeMaterial);
  const fadeScene = new THREE.Scene();
  fadeScene.add(fadeQuad);
  const fadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    add(id, def) {
      scenes.set(id, def);
      if (active === null) active = id;
      def.onEnter?.();
    },
    /** Crossfade to a different scene. Idempotent if already active. */
    switchTo(id, fadeMs = 240) {
      if (active === id) return;
      if (!scenes.has(id)) throw new Error(`unknown scene: ${id}`);
      nextActive = id;
      fadeDir = -1;
      fadeProgress = 0;
      // dt-based fade — store per-call duration for the tick math.
      this._fadeDuration = fadeMs / 1000;
    },
    tick(dt, renderer) {
      const cur = scenes.get(active);
      if (cur) {
        cur.onTick?.(dt);
        renderer.render(cur.scene, cur.camera);
      }
      if (fadeDir !== 0) {
        fadeProgress += (dt / (this._fadeDuration ?? 0.24)) * (fadeDir === -1 ? 1 : -1);
        if (fadeDir === -1 && fadeProgress >= 1) {
          // mid-swap
          if (nextActive !== null) {
            scenes.get(active)?.onExit?.();
            active = nextActive;
            nextActive = null;
            scenes.get(active)?.onEnter?.();
          }
          fadeDir = 1;
        } else if (fadeDir === 1 && fadeProgress <= 0) {
          fadeProgress = 0;
          fadeDir = 0;
        }
        fadeMaterial.opacity = Math.max(0, Math.min(1, fadeProgress));
        renderer.autoClear = false;
        renderer.render(fadeScene, fadeCamera);
        renderer.autoClear = true;
      }
    },
    activeId: () => active,
    dispose() {
      fadeMaterial.dispose();
      fadeQuad.geometry.dispose();
    },
  };
}

// Usage:
//   const sm = createSceneManager({ canvas });
//   sm.add('menu', { scene: menuScene, camera: menuCam, onTick: tickMenu });
//   sm.add('play', { scene: playScene, camera: playCam, onTick: tickPlay });
//   onStartButton(() => sm.switchTo('play', 320));
//   // inside game loop:
//   sm.tick(dt, renderer);
