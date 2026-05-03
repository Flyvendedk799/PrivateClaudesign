/**
 * Sequence-7 (game-mode guardrails) — compute a 3-line "what changed"
 * summary between two artifact snapshots and surface it next to the
 * `artifact_delivered` row in the chat.
 *
 * Pure regex/textual analysis — no AST. The 2026-05-03 c44763af trace
 * regressed the camera type SIX times across consecutive edits because
 * neither the user nor the agent ever saw a "what just changed"
 * summary; the user had to play the game to discover the camera had
 * silently flipped. Showing the camera/sign/system delta in-line in
 * the chat means the user can spot the regression as soon as the
 * snapshot lands.
 *
 * Lives in `@open-codesign/shared` so both the renderer (where the
 * chat is drawn) and the host (where the snapshot is committed) can
 * compute it from the same code path.
 */

export interface SnapshotDiffOptions {
  /** Cap on the number of lines surfaced. Defaults to 3 — the chat
   *  surface stays terse; a longer diff drowns the deliverable
   *  summary the agent already wrote. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 3;

const CAMERA_RE = /(Perspective|Orthographic)Camera/g;

/** Light bag-of-system probe — every match represents a "feature" the
 *  agent named in the source. Showing additions / removals between
 *  snapshots gives the user a one-line read on what mechanic landed. */
const SYSTEM_NAME_RES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcombo\w*\b/i, label: 'combo system' },
  { pattern: /\bhitstop\b|\bhit-?stop\b|\bhit-?stun\b|\bstagger\b/i, label: 'hitstop' },
  { pattern: /\bscreenShake\b|camera\.shake/i, label: 'screen shake' },
  { pattern: /\breticle\b|crosshair/i, label: 'aim reticle' },
  { pattern: /aimLine|aim-?line/i, label: 'aim line' },
  { pattern: /\bparticle\w*\b/i, label: 'particles' },
  { pattern: /spawnImpactFlash|hit-?flash/i, label: 'hit flash' },
  {
    pattern: /\barms?\.(left|right)|leftArm|rightArm|leftFist|rightFist/i,
    label: 'two-handed limbs',
  },
  { pattern: /\bjab\b/i, label: 'jab' },
  { pattern: /\bcross\b(?!\.)/i, label: 'cross attack' },
  { pattern: /\bhook\b/i, label: 'hook attack' },
  { pattern: /multiplier/i, label: 'multiplier' },
  { pattern: /OrbitControls|FollowCam|followCam|cameraTarget/i, label: 'follow camera' },
];

const SIGN_FLIP_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  flippedPattern: RegExp;
  label: string;
}> = [
  {
    pattern: /rotation\.y\s*=\s*-\s*playerAngle/i,
    flippedPattern: /rotation\.y\s*=\s*(?!-)\s*playerAngle/i,
    label: '`rotation.y = playerAngle` (sign fixed)',
  },
];

function listCameras(source: string): string[] {
  const matches = source.match(CAMERA_RE) ?? [];
  return Array.from(new Set(matches));
}

function listSystems(source: string): string[] {
  const found: string[] = [];
  for (const { pattern, label } of SYSTEM_NAME_RES) {
    if (pattern.test(source)) found.push(label);
  }
  return found;
}

/** Returns up to `maxLines` short strings describing the deltas
 *  between `prev` and `next`. Empty array when the artifacts are
 *  byte-identical or the change is too small to summarise. */
export function summarizeSnapshotDiff(
  prev: string | null | undefined,
  next: string,
  options: SnapshotDiffOptions = {},
): string[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (prev === null || prev === undefined || prev.length === 0) {
    const cams = listCameras(next);
    const lines: string[] = [];
    if (cams.length > 0) lines.push(`camera: ${cams.join(' + ')}`);
    const systems = listSystems(next);
    if (systems.length > 0) lines.push(`+${systems.slice(0, 4).join(' / +')}`);
    return lines.slice(0, maxLines);
  }
  if (prev === next) return [];

  const lines: string[] = [];

  const camPrev = listCameras(prev);
  const camNext = listCameras(next);
  const camsAdded = camNext.filter((c) => !camPrev.includes(c));
  const camsRemoved = camPrev.filter((c) => !camNext.includes(c));
  if (camsAdded.length > 0 && camsRemoved.length > 0) {
    lines.push(`camera: ${camsRemoved.join(' + ')} → ${camsAdded.join(' + ')}`);
  } else if (camsAdded.length > 0) {
    lines.push(`+camera: ${camsAdded.join(' + ')}`);
  } else if (camsRemoved.length > 0) {
    lines.push(`-camera: ${camsRemoved.join(' + ')}`);
  }

  for (const { pattern, flippedPattern, label } of SIGN_FLIP_PATTERNS) {
    if (pattern.test(prev) && !pattern.test(next) && flippedPattern.test(next)) {
      lines.push(label);
    }
  }

  const sysPrev = new Set(listSystems(prev));
  const sysNext = new Set(listSystems(next));
  const added = Array.from(sysNext).filter((s) => !sysPrev.has(s));
  const removed = Array.from(sysPrev).filter((s) => !sysNext.has(s));
  const systemSegments: string[] = [];
  if (added.length > 0) systemSegments.push(added.map((a) => `+${a}`).join(' / '));
  if (removed.length > 0) systemSegments.push(removed.map((r) => `-${r}`).join(' / '));
  if (systemSegments.length > 0) {
    lines.push(systemSegments.join(' / '));
  }

  if (lines.length === 0) {
    const delta = next.length - prev.length;
    const sign = delta >= 0 ? '+' : '-';
    const magnitude = Math.abs(delta);
    if (magnitude >= 80) {
      lines.push(`${sign}${magnitude} bytes (no top-level system change detected)`);
    }
  }

  return lines.slice(0, maxLines);
}
