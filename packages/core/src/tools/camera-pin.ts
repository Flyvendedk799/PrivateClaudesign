/**
 * Sequence-5 (game-mode guardrails) — refuse silent camera-type swaps in
 * edit-mode runs.
 *
 * The 2026-05-03 c44763af trace oscillated between Perspective and
 * Orthographic camera across SIX consecutive edits even though only the
 * first user prompt mentioned the camera. Every other correction was
 * about aim, attacks, animation — yet the agent kept rewriting the
 * camera class as a side effect. That single regression class accounted
 * for the second-largest bucket of correction loops in the trace.
 *
 * The rule encoded here: when the run is editing an existing artifact
 * (i.e. there is prior history, OR the artifact already contains one
 * camera type), the agent must NOT swap camera types unless the user's
 * current prompt explicitly references one of these terms:
 *
 *     camera, perspective, view, zoom, angle
 *
 * The detector is purely textual — Three.js exposes the swap as a class
 * change between `THREE.PerspectiveCamera` and `THREE.OrthographicCamera`
 * which both appear as constructor calls. Phaser's `cameras.main` is
 * single-class but supports `setOrthographic()` / `setZoom()` which the
 * "zoom"/"view" wake words cover.
 */

const CAMERA_PERMISSION_TERMS: readonly RegExp[] = [
  /\bcamera\b/i,
  /\bperspective\b/i,
  /\bview\b/i,
  /\bzoom\b/i,
  /\bangle\b/i,
  /\bortho(?:graphic)?\b/i,
];

const PERSPECTIVE_CLASS = /PerspectiveCamera/;
const ORTHOGRAPHIC_CLASS = /OrthographicCamera/;

export interface CameraPinDecision {
  /** True when the str_replace is allowed to land. */
  allowed: boolean;
  /** When allowed=false, an actionable message the tool surfaces back
   *  to the agent so it can either rephrase the edit or ask the user
   *  to mention the camera explicitly. */
  reason?: string;
}

/** Cheap, allocation-light heuristic over the user's CURRENT prompt
 *  (input.prompt). Strips fenced code blocks first so a copy-pasted
 *  Three.js snippet that mentions PerspectiveCamera doesn't count as
 *  user permission. */
export function userPromptPermitsCameraSwap(userPrompt: string): boolean {
  const stripped = userPrompt.replace(/```[\s\S]*?```/g, '');
  return CAMERA_PERMISSION_TERMS.some((re) => re.test(stripped));
}

/** Returns `{ allowed: false, reason }` when the str_replace would swap
 *  PerspectiveCamera ↔ OrthographicCamera and we don't have user
 *  permission. Allows everything else through. */
export function evaluateCameraSwap(
  oldStr: string,
  newStr: string,
  userPromptPermits: boolean,
): CameraPinDecision {
  if (userPromptPermits) return { allowed: true };
  const oldHasP = PERSPECTIVE_CLASS.test(oldStr);
  const oldHasO = ORTHOGRAPHIC_CLASS.test(oldStr);
  const newHasP = PERSPECTIVE_CLASS.test(newStr);
  const newHasO = ORTHOGRAPHIC_CLASS.test(newStr);
  // Not a camera-related edit at all.
  if (!oldHasP && !oldHasO && !newHasP && !newHasO) return { allowed: true };
  // Same class on both sides — that's a tweak (e.g. FOV change), not a swap.
  if ((oldHasP && newHasP) || (oldHasO && newHasO)) return { allowed: true };
  // Cross-class swap with no user permission.
  if ((oldHasP && newHasO) || (oldHasO && newHasP)) {
    const from = oldHasP ? 'PerspectiveCamera' : 'OrthographicCamera';
    const to = newHasP ? 'PerspectiveCamera' : 'OrthographicCamera';
    return {
      allowed: false,
      reason: `[camera-pin] Refused str_replace: this swaps ${from} → ${to} but the user's prompt did not mention any of {camera, perspective, view, zoom, angle, ortho}. Camera oscillation across edit turns was the second-largest source of correction loops in the 2026-05-03 trace; pin the camera you committed to in the Mechanic spec block. If the user explicitly asked to change the camera, ask them to re-state it with the term "camera". Otherwise, leave the camera class alone and edit the surrounding logic.`,
    };
  }
  // newStr introduces a camera class but oldStr had none — that's adding
  // the first camera, not swapping. Allow.
  return { allowed: true };
}

export interface CameraGuard {
  /** Returns null when the edit is allowed; returns a reason string
   *  when it must be refused. */
  check(oldStr: string, newStr: string): string | null;
}

/** Build a CameraGuard scoped to one generate run. The guard is only
 *  ENFORCING when both:
 *    1. the run is game-mode (camera classes only matter for games)
 *    2. the run is editing an existing artifact (history.length > 0)
 *  In every other case the guard returns null unconditionally so design-
 *  mode and first-shot game runs aren't penalised. */
export function createCameraGuard(opts: {
  gameMode: boolean;
  editMode: boolean;
  userPrompt: string;
}): CameraGuard {
  const enforcing = opts.gameMode && opts.editMode;
  const permits = userPromptPermitsCameraSwap(opts.userPrompt);
  return {
    check(oldStr, newStr) {
      if (!enforcing) return null;
      const decision = evaluateCameraSwap(oldStr, newStr, permits);
      return decision.allowed ? null : (decision.reason ?? '[camera-pin] refused');
    },
  };
}
