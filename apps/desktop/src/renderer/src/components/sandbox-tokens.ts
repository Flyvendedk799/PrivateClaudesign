/**
 * may9 Phase 5 — single source of truth for iframe sandbox attributes.
 *
 * Inline strings drift over time and the engine guides drift with them
 * (FPS-run #1: three-engine-guide.v1.txt:61 claimed pointer-lock was
 * granted while several iframes were missing the token). Centralizing
 * the policy makes the truth-claim auditable: change a constant here +
 * the engine guides + grep for the old string.
 *
 * Constants describe what the iframe is ALLOWED to do; the runtime
 * fallback strategies still live in the engine guides for the agent to
 * read.
 */

/** Plain HTML / React design previews — minimum scripting privilege. */
export const SANDBOX_DESIGN = 'allow-scripts';

/** Design previews that must run on an opaque origin so postMessage
 *  works without same-origin checks. Used by the renderer's preview
 *  pane when game-files:// is not the source. */
export const SANDBOX_DESIGN_SAME_ORIGIN = 'allow-scripts allow-same-origin';

/** 2D + 2.5D game previews (Phaser, Pygame). Permits pointer lock for
 *  cursor-trapping cameras and fullscreen for the user-driven F11 path.
 *  No same-origin: the iframe's contents must continue to work in the
 *  installer/release build's CSP-strict environment. */
export const SANDBOX_GAME_2D = 'allow-scripts allow-pointer-lock allow-fullscreen';

/** 3D / FPS / TPS games. Same as 2D today (the difference is in the
 *  engine guide guidance, not the sandbox tokens). Kept as a separate
 *  constant so a future GPU-related token addition can land in one
 *  place without touching every call site. */
export const SANDBOX_GAME_3D = SANDBOX_GAME_2D;

/** Godot web export — needs SharedArrayBuffer, which requires
 *  cross-origin isolation, which the renderer enables for game-files://
 *  via COOP/COEP headers. The sandbox itself adds same-origin + the
 *  game tokens. */
export const SANDBOX_GODOT_WEB =
  'allow-scripts allow-same-origin allow-pointer-lock allow-fullscreen';

/** Sprite / animation preview iframes — read-only inspector, no
 *  pointer-lock needed. */
export const SANDBOX_PREVIEW_INSPECTOR = 'allow-scripts';
