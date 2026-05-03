// when_to_use: 2D sprite rendering inside a Three.js scene — coins, enemies,
// projectiles. Uses InstancedMesh when you have ≥ 32 of the same sprite,
// PlaneGeometry + Sprite material for hero entities. Handles atlas slicing
// via UV offsets without an external library.

import * as THREE from 'three';

/** Single hero sprite — use for the player + handful of named entities. */
export function makeHeroSprite({ texture, width = 1, height = 1 }) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter; // pixel-perfect
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: false,
  });
  const geo = new THREE.PlaneGeometry(width, height);
  return new THREE.Mesh(geo, mat);
}

/** Many-of-the-same-sprite — coins, particles, tiles. Pass instance count
 *  upfront; mutate per-instance matrix in your update loop. */
export function makeSpriteCloud({ texture, count, width = 1, height = 1 }) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: false,
  });
  const geo = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

/** Slice an atlas into `frames` sub-textures keyed by name. Each sub-texture
 *  shares the GPU texture but has its own UV offset/repeat. */
export function sliceAtlas(atlas, frames) {
  const out = {};
  for (const [name, { x, y, w, h, sheetW, sheetH }] of Object.entries(frames)) {
    const t = atlas.clone();
    t.needsUpdate = true;
    t.repeat.set(w / sheetW, h / sheetH);
    t.offset.set(x / sheetW, 1 - (y + h) / sheetH);
    out[name] = t;
  }
  return out;
}

// Usage:
//   const tex = new THREE.TextureLoader().load('assets/sprites/coin.png');
//   const coins = makeSpriteCloud({ texture: tex, count: 64 });
//   scene.add(coins);
//   const m = new THREE.Matrix4();
//   for (let i = 0; i < 64; i++) {
//     m.setPosition(Math.random()*10, 0, Math.random()*10);
//     coins.setMatrixAt(i, m);
//   }
//   coins.instanceMatrix.needsUpdate = true;
