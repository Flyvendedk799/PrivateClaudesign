// when_to_use: Canonical Three.js render loop with delta-time, pause, and
// dispose-on-unmount. Drop-in for any single-scene Three.js game. Reads
// `window.__game.params` live — slider drags update without reload.

import * as THREE from 'three';

export function startGameLoop({ canvas, scene, camera, onUpdate }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  let prev = performance.now();
  let paused = false;
  let raf = 0;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - prev) / 1000, 1 / 30); // clamp big tab-switch dt
    prev = now;
    if (!paused) onUpdate(dt, window.__game?.params ?? {});
    renderer.render(scene, camera);
  }

  function onResize() {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }

  function onVisibility() {
    paused = document.hidden;
    if (!paused) prev = performance.now();
  }

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  raf = requestAnimationFrame(tick);

  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      prev = performance.now();
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.dispose();
    },
    renderer,
  };
}

// Usage:
//   const scene = new THREE.Scene();
//   const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
//   const loop = startGameLoop({ canvas, scene, camera, onUpdate(dt, params) {
//     mesh.rotation.y += (params.spin_speed ?? 1) * dt;
//   }});
//   window.addEventListener('beforeunload', () => loop.dispose());
