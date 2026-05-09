/**
 * may9 Phase 10 follow-up #33 — bundled game-builder example briefs.
 *
 * The NewDesignDialog renders these as suggestion chips under the
 * genre dropdown. Each entry pairs a label (≤ 28 chars, used as
 * the card text) with the actual brief the agent receives if the
 * user picks it. Engines + genres mirror what's offered in the
 * dialog so the suggestion lands on a known-good config.
 */

export interface GameExampleBrief {
  /** Short kebab-case id; used by the suggestion-pick handler. */
  slug: string;
  /** Human label shown on the card. ≤ 28 chars to stay scannable. */
  label: string;
  engine: 'three' | 'phaser' | 'pygame' | 'godot';
  /** One of the GameGenre values the dialog knows about. */
  genre: string;
  /** The actual prompt text the agent receives when picked. */
  brief: string;
}

export const GAME_EXAMPLE_BRIEFS: ReadonlyArray<GameExampleBrief> = [
  {
    slug: 'phaser-platformer',
    label: '2D platformer (Phaser)',
    engine: 'phaser',
    genre: 'platformer',
    brief:
      'Make a 2D side-scrolling platformer with jump physics, a flag at the level end, and at least one enemy that patrols a fixed range. Player dies on enemy contact and respawns.',
  },
  {
    slug: 'phaser-puzzle',
    label: 'Match-3 puzzle (Phaser)',
    engine: 'phaser',
    genre: 'puzzle',
    brief:
      'Match-3 puzzle on a 6x8 grid. Tap two adjacent tiles to swap; three-in-a-row clears + adds 100 to the score. Cascade matches award 2x. Music + clear SFX.',
  },
  {
    slug: 'three-fps',
    label: 'FPS wave defense (Three.js)',
    engine: 'three',
    genre: 'fps',
    brief:
      'First-person shooter with WASD movement, mouse look, and waves of enemies. Each wave gets harder. Player has 3 lives, ammo refills between waves, exit door appears after wave 5.',
  },
  {
    slug: 'three-runner',
    label: 'Endless runner (Three.js)',
    engine: 'three',
    genre: 'runner',
    brief:
      'Endless runner along a track. Player auto-advances; jump (Space) clears low obstacles; left/right (A/D) dodges side obstacles. Speed ramps up over time. Game ends on collision; show distance + best.',
  },
  {
    slug: 'three-fighting',
    label: 'Top-down brawler (Three.js)',
    engine: 'three',
    genre: 'fighting',
    brief:
      'Top-down 3D brawler with two opposing fighters. Lead-hand punch + rear-hand punch (both fire forward). Combos extend the chain. HP bars + win on opponent KO. Hit/whiff SFX + brief hitstop on hit.',
  },
  {
    slug: 'godot-rpg',
    label: 'Top-down RPG skeleton (Godot)',
    engine: 'godot',
    genre: 'rpg',
    brief:
      'Top-down 2D RPG skeleton with player movement, an NPC who speaks via dialog box, an inventory of 3 starter items, and a save/load slot in slot 1. Use Godot 4.3.',
  },
  {
    slug: 'pygame-shmup',
    label: 'Vertical shmup (Pygame)',
    engine: 'pygame',
    genre: 'shmup',
    brief:
      'Vertical shoot-em-up. Player ship at bottom moves with arrow keys, fires Space. Enemies descend in waves; bullets cull on screen edge; score per kill. Game over on player hit; press R to restart.',
  },
  {
    slug: 'phaser-tower-defense',
    label: 'Tower defense (Phaser)',
    engine: 'phaser',
    genre: 'tower_defense',
    brief:
      'Tower defense on a fixed grid. Click a tile to place a tower (cost 50 gold); enemies follow a path from spawn to base; towers auto-fire on enemies in range. Wave system; lose 1 HP per enemy reaching base.',
  },
];

/** Filter the bundled briefs to only the ones matching a particular
 *  engine + genre pair. The dialog uses this when both pickers are
 *  set; falls back to "everything for this engine" when only the
 *  engine is known. */
export function filterGameExampleBriefs(opts: {
  engine?: GameExampleBrief['engine'];
  genre?: string;
}): ReadonlyArray<GameExampleBrief> {
  return GAME_EXAMPLE_BRIEFS.filter((b) => {
    if (opts.engine !== undefined && b.engine !== opts.engine) return false;
    if (opts.genre !== undefined && b.genre !== opts.genre) return false;
    return true;
  });
}
