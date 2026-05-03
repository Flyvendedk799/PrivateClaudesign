/**
 * Shared per-run counter for the `[edit-budget]` guardrail (game-mode
 * Sequence 3).
 *
 * The 2026-05-03 c44763af trace (and the earlier moj4w21j trace) showed
 * runs where the agent emitted ≥ 18 consecutive `str_replace` calls
 * against the same file region without a `verify_artifact` in between —
 * essentially redoing the same function 8 times because each str_replace
 * left the surrounding context drifted from the model's mental model.
 * This object is the connective tissue between `text_editor` (which
 * increments) and `verify_artifact` (which resets), so the budget is
 * naturally per-region: any successful verify clears the counter for
 * every path because the model has now confirmed the partial artifact
 * still renders, which is the honest "checkpoint" we want to reward.
 *
 * The threshold is intentionally low (5). Most well-formed runs touch
 * 1-3 regions per file before verifying; tripping at 5 catches the
 * thrash class without flagging legitimate work.
 */

const DEFAULT_THRESHOLD = 5;

export interface EditBudget {
  /** Returns the warning string when the path has now reached or
   *  exceeded the threshold. Caller appends it to the tool result so
   *  the model SEES the budget hint inside the same response. */
  recordEdit(path: string): string | null;
  /** Resets every path's counter. Called after a successful
   *  `verify_artifact` (or the run-ending `done`) so the agent only
   *  carries a thrash flag when it's still mid-thrash. */
  reset(): void;
  /** Read-only access for tests / telemetry. */
  countFor(path: string): number;
}

export function createEditBudget(threshold: number = DEFAULT_THRESHOLD): EditBudget {
  const counters = new Map<string, number>();
  return {
    recordEdit(path) {
      const next = (counters.get(path) ?? 0) + 1;
      counters.set(path, next);
      if (next < threshold) return null;
      return formatWarning(path, next, threshold);
    },
    reset() {
      counters.clear();
    },
    countFor(path) {
      return counters.get(path) ?? 0;
    },
  };
}

function formatWarning(path: string, count: number, threshold: number): string {
  return `\n\n[edit-budget] ${count} consecutive str_replace calls against ${path} without an intervening verify_artifact (threshold ${threshold}). STOP and rewrite the entire region with a single str_replace whose old_str is a unique comment anchor (e.g. \`// ── WAVE SYSTEM ─\`) bounding the whole block. See game-workflow.v1.txt §"Edit budget".`;
}
