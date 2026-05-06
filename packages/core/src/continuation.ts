/**
 * Phase 4 — first-class continuation. Long runs pause cleanly instead of
 * truncating; the user (or the auto-continue toggle) clicks "Continue" and
 * the agent picks up with the same plan, state, and decision context.
 *
 * Two pure primitives drive the runtime:
 *
 *   shouldPauseForContinuation — given the current run state, returns
 *     'pause' / 'continue' plus the reason. Each threshold is documented
 *     and individually testable; the function never caps the model — it
 *     suggests a clean cut point. The runtime is responsible for honoring
 *     the suggestion at the next safe boundary (between turns, never
 *     mid-tool-execution).
 *
 *   buildContinuationPrompt — reconstructs the next-chunk prompt from
 *     the latest set_todos snapshot + a 400-token decision recap + the
 *     current filesystem state. Cache-aligned (the surrounding system
 *     prompt is unchanged), so resumption costs ~one full-context input
 *     not a transcript replay.
 *
 * Per the Phase 7 ambition guardrails: the function NEVER caps thinking,
 * NEVER restricts output, NEVER imposes a fixed turn budget. It only
 * marks safe pause points so the renderer can honor them.
 */

export type ContinuationReason =
  | 'context_threshold'
  | 'output_budget'
  | 'wall_clock'
  | 'model_requested'
  | 'manual';

export interface ContinuationDecision {
  pause: boolean;
  reason?: ContinuationReason;
}

export interface ContinuationState {
  /** Fraction of the model's context window currently consumed (0–1). */
  contextUsedPct: number;
  /** Output tokens emitted so far this run. */
  outputTokens: number;
  /** Wall-clock since run start (ms). */
  wallClockMs: number;
  /** True if the model called the `pause_for_continuation` tool. */
  modelEmittedPause: boolean;
  /** True if the user clicked "Pause & continue" in the UI. */
  userRequestedPause?: boolean;
}

/** Documented thresholds. Tuned to "give the model headroom" — none of
 *  these is a hard cap. The runtime can override by waiting for a safer
 *  boundary, but should respect the suggestion at the next opportunity. */
export const CONTINUATION_THRESHOLDS = Object.freeze({
  /** Pause when the model has consumed > 80% of its context window.
   *  Leaves enough room for the recap + tool definitions in the
   *  continuation turn without immediately re-tripping. */
  contextUsedPct: 0.8,
  /** Pause if the run produces > 50,000 output tokens — protects the
   *  per-chunk cache and the user's perception of progress (a single
   *  agent turn that long usually batched many independent sub-tasks). */
  outputTokens: 50_000,
  /** Pause at 10 min wall-clock — by then the user has lost focus and
   *  will appreciate a checkpoint. */
  wallClockMs: 10 * 60 * 1000,
});

/** Pure function — given run state, returns the pause decision.
 *  Priority order: model_requested ≫ user-requested ≫ thresholds. The
 *  first matching rule wins. */
export function shouldPauseForContinuation(state: ContinuationState): ContinuationDecision {
  if (state.modelEmittedPause) return { pause: true, reason: 'model_requested' };
  if (state.userRequestedPause === true) return { pause: true, reason: 'manual' };
  if (state.contextUsedPct >= CONTINUATION_THRESHOLDS.contextUsedPct) {
    return { pause: true, reason: 'context_threshold' };
  }
  if (state.outputTokens >= CONTINUATION_THRESHOLDS.outputTokens) {
    return { pause: true, reason: 'output_budget' };
  }
  if (state.wallClockMs >= CONTINUATION_THRESHOLDS.wallClockMs) {
    return { pause: true, reason: 'wall_clock' };
  }
  return { pause: false };
}

export interface TodoSnapshot {
  items: ReadonlyArray<{ text: string; checked: boolean }>;
}

export interface ContinuationPromptInput {
  /** Latest set_todos snapshot. Embedded verbatim so the agent picks up
   *  the same plan. May be null when the run never emitted a plan. */
  todos: TodoSnapshot | null;
  /** ≤400-token "what was decided + what is next" recap, written by the
   *  runtime at the cut point. Free-form text. */
  decisionRecap: string;
  /** Snapshot of the filesystem at pause time — path → byte size. The
   *  recap references files by path; the agent re-discovers content via
   *  the existing `view` tool, so we don't embed bytes here (that would
   *  blow the cache budget). */
  fsState: ReadonlyArray<{ path: string; bytes: number }>;
  /** The original user prompt for this run. The continuation turn re-
   *  references it so the agent stays on-brief. */
  originalUserPrompt: string;
}

/** Pure, byte-stable prompt reconstruction. Snapshot-tested so a future
 *  edit doesn't quietly shift the cache shape. */
export function buildContinuationPrompt(input: ContinuationPromptInput): string {
  const lines: string[] = [];
  lines.push('# Continuation');
  lines.push('');
  lines.push(
    'You are continuing a previously-paused run. The plan, decisions, and ' +
      'filesystem state at the pause point are below. Pick up from where you left ' +
      'off — do NOT restart the planning phase or re-emit the original todos. ' +
      'Mark items off as you complete them and call `done` when finished.',
  );
  lines.push('');
  lines.push('## Original brief');
  lines.push(input.originalUserPrompt.trim());
  lines.push('');
  if (input.todos !== null && input.todos.items.length > 0) {
    lines.push('## Plan (latest set_todos snapshot)');
    for (const item of input.todos.items) {
      const mark = item.checked ? '[x]' : '[ ]';
      lines.push(`- ${mark} ${item.text}`);
    }
    lines.push('');
  }
  lines.push('## What was decided + what is next');
  lines.push(input.decisionRecap.trim());
  lines.push('');
  if (input.fsState.length > 0) {
    lines.push('## Filesystem state at pause point');
    for (const f of input.fsState) {
      lines.push(`- \`${f.path}\` (${f.bytes} bytes)`);
    }
    lines.push('');
  }
  lines.push('Continue.');
  return lines.join('\n');
}
