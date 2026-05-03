// when_to_use: Loading a Tiled-format tilemap (.json export) plus its
// tileset image into a Phaser scene, including collision layers. Ships
// with a fallback inline JSON shape when no Tiled file is available.

import Phaser from 'phaser';

/** Inside preload(): load the tileset PNG + map JSON. */
export function preloadTilemap(scene, { mapKey, mapPath, tilesetKey, tilesetPath }) {
  scene.load.image(tilesetKey, tilesetPath);
  scene.load.tilemapTiledJSON(mapKey, mapPath);
}

/** Inside create(): build the tilemap, layers, and (optionally) extract
 *  collision objects. Returns the layer references your scene logic
 *  collides against. */
export function setupTilemap(scene, { mapKey, tilesetKey, tilesetName, layerNames }) {
  const map = scene.make.tilemap({ key: mapKey });
  // tilesetName must match the name field inside the Tiled JSON. Most
  // Tiled exports store this as the source PNG's basename without ext.
  const tileset = map.addTilesetImage(tilesetName, tilesetKey);
  if (tileset === null) {
    throw new Error(
      `tileset "${tilesetName}" not found in map "${mapKey}". Open the .json in a text editor and check the "tilesets[].name" field.`,
    );
  }
  const layers = {};
  for (const name of layerNames) {
    const layer = map.createLayer(name, tileset, 0, 0);
    if (layer !== null) layers[name] = layer;
  }
  return { map, tileset, layers };
}

/** Mark a layer's tiles as colliders by gid. Pass `[1, 2, 3]` to make
 *  tiles 1, 2, 3 solid; or pass `true` to make every non-empty tile
 *  solid. */
export function setLayerCollision(layer, tiles) {
  if (tiles === true) {
    layer.setCollisionByExclusion([-1]);
  } else {
    layer.setCollision(tiles);
  }
}

// Usage (PlayScene with a Tiled-authored map):
//   preload() {
//     preloadTilemap(this, {
//       mapKey: 'level1',
//       mapPath: 'assets/tilemaps/level1.json',
//       tilesetKey: 'tiles',
//       tilesetPath: 'assets/tilemaps/tiles.png',
//     });
//   }
//   create() {
//     const { layers } = setupTilemap(this, {
//       mapKey: 'level1',
//       tilesetKey: 'tiles',
//       tilesetName: 'tiles',
//       layerNames: ['ground', 'platforms', 'background'],
//     });
//     setLayerCollision(layers.platforms, true);
//     this.physics.add.collider(this.player, layers.platforms);
//   }
