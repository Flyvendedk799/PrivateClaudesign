/**
 * may9 Phase 9 — genre playtest playbooks.
 *
 * The brawler `c44763af…` run shipped a sign error (rotation.y =
 * -playerAngle) through three snapshots because nobody asserted that
 * pressing D actually moved the player toward +x. Phase 4's spec gate
 * captures `genre`; this module turns that genre into a canonical
 * input → state assertion list the agent can hand to `playtest_game`.
 *
 * The playbooks below are deliberately small (≤ 12 steps each) and
 * generic across engines. They cover the empirically-broken cases:
 *
 *   - fighting   — lateral move + attack + opponent damage
 *   - fps        — pointer-lock acquire + mousemove yaw delta
 *   - platformer — jump → y rises → land → y stable
 *   - puzzle     — drag/swap → grid permutation
 *   - topdown    — cardinal moves → x/y deltas
 *   - runner     — auto-forward + jump → y delta only
 *
 * The agent reads `getPlaytestPlaybook(genre)` and adapts the keycodes
 * + assertions to its own input bindings. The host's `playtest_game`
 * stays generic — it just dispatches the steps and reads back
 * `window.__game.debug.snapshot()` between them.
 */
import type { GameGenre } from '@open-codesign/shared';

/** A single recommended playtest step in the same shape as the
 *  `playtest_game` tool's `Step` discriminated union. We re-encode here
 *  rather than importing the TypeBox schema so consumers (renderer,
 *  docs, future eval harness) don't pull TypeBox transitively. */
export interface PlaybookStep {
  kind: 'key' | 'mouse' | 'wait';
  /** For 'key': DOM KeyboardEvent.code. */
  code?: string;
  /** For 'key' / 'mouse': how many RAF frames to hold. */
  frames?: number;
  /** For 'mouse': pointer-lock relative-delta. */
  movementX?: number;
  movementY?: number;
  /** For 'mouse': button index (0=left, 2=right). Default 0. */
  button?: number;
  /** For 'wait': how many RAF frames to advance with no input. */
  durationFrames?: number;
  /** Human-readable assertion the agent should evaluate against the
   *  snapshot returned by playtest_game AFTER this step. Free-form so
   *  per-engine state shapes don't constrain the playbook. */
  assert?: string;
}

export interface PlaytestPlaybook {
  schemaVersion: 1;
  genre: GameGenre;
  /** One sentence on what this playbook proves. Surfaced to the agent
   *  in the result text so it understands the shape of the test. */
  intent: string;
  steps: PlaybookStep[];
  /** Free-form notes on common mismatches the agent should watch for. */
  watchFor: string[];
}

const PLATFORMER: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'platformer',
  intent:
    'Jump arc: pressing the jump key raises the player y, then gravity returns y to a ground-stable value.',
  steps: [
    { kind: 'wait', durationFrames: 30, assert: 'Player is on ground; y is stable.' },
    { kind: 'key', code: 'Space', frames: 5, assert: 'Player y is RISING (jump initiated).' },
    { kind: 'wait', durationFrames: 30, assert: 'Player y peaks then descends.' },
    {
      kind: 'wait',
      durationFrames: 60,
      assert: 'Player is back on ground; y matches the pre-jump value within ±1.',
    },
  ],
  watchFor: [
    'No gravity (player floats after jump).',
    'No max-jump-height (key held forever -> y unbounded).',
    'Landing inside a platform (y goes below ground level).',
  ],
};

const FIGHTING: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'fighting',
  intent:
    'Lateral movement + attack: pressing right increases x, pressing the attack key reduces opponent HP.',
  steps: [
    { kind: 'key', code: 'KeyD', frames: 30, assert: 'Player x is INCREASING (rightward).' },
    { kind: 'key', code: 'KeyA', frames: 30, assert: 'Player x is DECREASING (leftward).' },
    {
      kind: 'wait',
      durationFrames: 10,
      assert: 'Player is within striking range (close to opponent).',
    },
    {
      kind: 'key',
      code: 'KeyJ',
      frames: 5,
      assert: 'Attack animation triggered; opponent HP DECREASED by > 0 within 30 frames.',
    },
  ],
  watchFor: [
    'Lateral keys reversed (pressing D moves left): the c44763af sign-error class.',
    'Attack registers on enemy AT or PAST player position (hitbox sign error).',
    'Lead-vs-rear hand confusion: both attacks should fire forward, not toward keypress side.',
  ],
};

const FPS: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'fps',
  intent:
    'Pointer-lock + look: clicking the canvas acquires lock, mouse movementX rotates the camera yaw.',
  steps: [
    {
      kind: 'mouse',
      button: 0,
      assert: 'Pointer lock acquired (document.pointerLockElement === canvas).',
    },
    {
      kind: 'mouse',
      movementX: 50,
      movementY: 0,
      assert: 'Camera yaw INCREASED (positive movementX → +yaw).',
    },
    {
      kind: 'mouse',
      movementX: -100,
      movementY: 0,
      assert: 'Camera yaw DECREASED below the prior value.',
    },
    {
      kind: 'key',
      code: 'KeyW',
      frames: 30,
      assert: 'Player position moved FORWARD along camera basis (not world +z).',
    },
  ],
  watchFor: [
    'Pointer-lock SecurityError on rapid re-acquire — engine guides require 1.25 s cooldown after Esc.',
    'WASD moves world-axis instead of camera-relative axis.',
    'movementX inverted (look right → camera yaws left).',
  ],
};

const PUZZLE: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'puzzle',
  intent:
    'Tile interaction: clicking adjacent tiles swaps their grid positions; matches clear from the grid.',
  steps: [
    {
      kind: 'mouse',
      button: 0,
      assert: 'A tile becomes selected (highlight visible OR state.selected non-null).',
    },
    {
      kind: 'mouse',
      button: 0,
      assert: 'Selected tile swapped with the clicked-adjacent tile (grid permuted).',
    },
    {
      kind: 'wait',
      durationFrames: 60,
      assert:
        'If the swap completed a match, those tiles cleared from the grid AND the score increased.',
    },
  ],
  watchFor: [
    'Match detection only checks one axis (rows but not columns or vice versa).',
    'Score never increments (the score is decorative).',
    'Tiles overlap after swap (rendering layer issue).',
  ],
};

const TOPDOWN: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'topdown_arcade',
  intent: 'Cardinal movement: WASD keys map to N/W/S/E movement deltas in screen-relative axes.',
  steps: [
    {
      kind: 'key',
      code: 'KeyW',
      frames: 20,
      assert: 'Player y DECREASED (north / up the screen).',
    },
    {
      kind: 'key',
      code: 'KeyS',
      frames: 20,
      assert: 'Player y INCREASED (south / down the screen).',
    },
    { kind: 'key', code: 'KeyA', frames: 20, assert: 'Player x DECREASED (west / left).' },
    { kind: 'key', code: 'KeyD', frames: 20, assert: 'Player x INCREASED (east / right).' },
  ],
  watchFor: [
    'World y-axis flipped (W moves player down because the engine uses screen-coord y).',
    'Diagonal movement is faster than cardinal (no normalization on the input vector).',
  ],
};

const RUNNER: PlaytestPlaybook = {
  schemaVersion: 1,
  genre: 'runner',
  intent:
    'Endless-runner: player auto-advances along the run axis; jump key affects only y, never the run axis.',
  steps: [
    {
      kind: 'wait',
      durationFrames: 60,
      assert: 'Player x (or z) ADVANCED automatically along the run axis with no input.',
    },
    {
      kind: 'key',
      code: 'Space',
      frames: 5,
      assert: 'Player y RISES while the run-axis position keeps advancing.',
    },
  ],
  watchFor: [
    'Jump pauses the run axis (player x stops advancing while in the air).',
    'No floor collision — player falls forever on landing.',
  ],
};

const PLAYBOOKS: Partial<Record<GameGenre, PlaytestPlaybook>> = {
  platformer: PLATFORMER,
  fighting: FIGHTING,
  fps: FPS,
  puzzle: PUZZLE,
  topdown_arcade: TOPDOWN,
  runner: RUNNER,
};

/** Return the canonical playbook for a genre, or null when no
 *  playbook is bundled yet. The agent can fall back to its own
 *  improvised step list. */
export function getPlaytestPlaybook(genre: GameGenre): PlaytestPlaybook | null {
  return PLAYBOOKS[genre] ?? null;
}

/** List the genres that ship a built-in playbook. Used by the
 *  `get_playtest_playbook` tool's description so the agent knows what's
 *  available without trial-and-error. */
export function listSupportedGenres(): GameGenre[] {
  return Object.keys(PLAYBOOKS) as GameGenre[];
}
