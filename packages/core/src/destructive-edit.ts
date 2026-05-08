/**
 * may9 Phase 8b — destructive-edit advisory.
 *
 * Defect D5 from docs/may9.md §0b: the FPS Wave Defense holographic
 * HUD edit on 2026-05-08 (snapshot a3d4afd7) collapsed the artifact
 * source from 110 KB → 21 KB because the HUD div replaced the canvas
 * instead of overlaying it. The user reported "it doesnt show the
 * game now only the hud".
 *
 * The signature is objective: a single edit shrinks the source by
 * ≥40% AND the user prompt has no remove/strip/delete intent. The
 * `done` tool consumes this advisory and returns it before allowing
 * the snapshot to commit.
 */

/** Threshold above which a shrink is flagged. The FPS regression was
 *  ~80%. Stop at 40% so genuine refactors (deduplication, common-css
 *  extraction) that often shed 25–35% don't false-positive. */
export const DESTRUCTIVE_SHRINK_THRESHOLD = 0.4;

/** Words in the user prompt that legitimise a large shrink. Matched
 *  case-insensitively against the FULL user prompt (not the agent's
 *  rewriting of it). Adding to this list is fine; removing is a
 *  potential regression. */
const REMOVE_INTENT_KEYWORDS = [
  'remove',
  'delete',
  'strip',
  'cleanup',
  'clean up',
  'simplify',
  'shrink',
  'reduce',
  'minimize',
  'minimise',
  'pare down',
  'cut',
  'trim',
];

export interface DestructiveEditCheckInput {
  priorBytes: number;
  currentBytes: number;
  userPrompt: string | null | undefined;
}

export interface DestructiveEditAdvisory {
  triggered: boolean;
  shrinkRatio: number;
  reason: string;
}

/**
 * Returns whether a destructive-edit advisory should fire for the
 * given size delta and user prompt. The advisory is informational —
 * the model can override it by re-justifying — but the `done` tool
 * surfaces it so the user sees it before committing.
 */
export function checkDestructiveEdit(input: DestructiveEditCheckInput): DestructiveEditAdvisory {
  if (input.priorBytes <= 0) {
    return { triggered: false, shrinkRatio: 0, reason: 'no prior snapshot to compare' };
  }
  const shrinkRatio = (input.priorBytes - input.currentBytes) / input.priorBytes;
  if (shrinkRatio < DESTRUCTIVE_SHRINK_THRESHOLD) {
    return { triggered: false, shrinkRatio, reason: 'shrink under threshold' };
  }
  const promptLower = (input.userPrompt ?? '').toLowerCase();
  for (const kw of REMOVE_INTENT_KEYWORDS) {
    if (promptLower.includes(kw)) {
      return {
        triggered: false,
        shrinkRatio,
        reason: `shrink ≥ threshold (${(shrinkRatio * 100).toFixed(0)}%) but user prompt contains '${kw}'`,
      };
    }
  }
  return {
    triggered: true,
    shrinkRatio,
    reason: `Source shrank by ${(shrinkRatio * 100).toFixed(0)}% with no remove/strip/delete language in the user prompt — likely an accidental rewrite. Call view, verify the canvas still renders, and re-justify before done.`,
  };
}
