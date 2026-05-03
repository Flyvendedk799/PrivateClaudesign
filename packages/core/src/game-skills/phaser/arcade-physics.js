// when_to_use: Phaser Arcade Physics setup for platformer / top-down /
// brick-breaker. Shows the four foot-guns the validator catches:
// physics block in config, world bounds, collide groups, gravity.

import Phaser from 'phaser';

/** Recommended Phaser.Game config block for arcade physics. Spread into
 *  your `new Phaser.Game({...})` call. */
export const arcadeConfig = {
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 600 }, // platformer default; set 0 for top-down
      debug: false, // flip true to visualise hitboxes during dev
    },
  },
};

/** Inside a scene's create(), wire collision groups + world bounds.
 *  Returns helpers your scene logic uses to register colliders. */
export function setupArcadeWorld(scene) {
  // World bounds — sprites bounce off the canvas edges by default.
  scene.physics.world.setBounds(0, 0, scene.scale.width, scene.scale.height);

  // Collision groups — pre-create the common ones so Play scenes don't
  // each invent their own. Add per-game groups by extending this.
  const groups = {
    players: scene.physics.add.group(),
    enemies: scene.physics.add.group(),
    pickups: scene.physics.add.group(),
    projectiles: scene.physics.add.group({ maxSize: 32 }), // pool
    walls: scene.physics.add.staticGroup(),
  };

  // Common interactions — extend with per-game callbacks.
  scene.physics.add.collider(groups.players, groups.walls);
  scene.physics.add.collider(groups.enemies, groups.walls);

  return {
    groups,
    /** Damage when the player overlaps an enemy. */
    onPlayerHit(handler) {
      scene.physics.add.overlap(groups.players, groups.enemies, handler);
    },
    /** Score / pickup interaction. */
    onPlayerPickup(handler) {
      scene.physics.add.overlap(groups.players, groups.pickups, handler);
    },
    /** Projectile hits enemy. */
    onProjectileHit(handler) {
      scene.physics.add.overlap(groups.projectiles, groups.enemies, handler);
    },
  };
}

// Usage (inside a Scene's create()):
//   const world = setupArcadeWorld(this);
//   this.player = this.physics.add.sprite(100, 400, 'player');
//   world.groups.players.add(this.player);
//   this.player.setCollideWorldBounds(true);
//   this.player.body.setGravityY(0); // override for player-only
//   world.onPlayerHit((player, enemy) => this.takeDamage());
