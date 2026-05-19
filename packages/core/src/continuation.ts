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
   *  continuation turn without immediately re-tripping. Context pressure
   *  alone is noisy on short runs, so it must also have meaningful run
   *  progress before we cut. */
  contextUsedPct: 0.8,
  /** Minimum emitted output before a context-pressure cut is useful. */
  contextMinOutputTokens: 10_000,
  /** Minimum wall-clock before a context-pressure cut is useful. */
  contextMinWallClockMs: 5 * 60 * 1000,
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
  const hasEnoughProgressForContextPause =
    state.outputTokens >= CONTINUATION_THRESHOLDS.contextMinOutputTokens ||
    state.wallClockMs >= CONTINUATION_THRESHOLDS.contextMinWallClockMs;
  if (
    state.contextUsedPct >= CONTINUATION_THRESHOLDS.contextUsedPct &&
    hasEnoughProgressForContextPause
  ) {
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

function extractOriginalBriefFromContinuationPrompt(text: string): string | null {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith('# Continuation')) return null;
  const marker = '\n## Original brief\n';
  const markerIdx = normalized.indexOf(marker);
  if (markerIdx === -1) return null;
  const rest = normalized.slice(markerIdx + marker.length).trim();
  if (rest.startsWith('# Continuation')) return rest;
  const nextHeadingIdx = rest.search(/\n## [^\n]+/);
  return (nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx)).trim();
}

const PAUSE_BOILERPLATE_RX =
  /(?:^|\n\n)— (?:Run paused|Paused) after \d+s[\s\S]*?(?:pick up where I left off|do more)\. —/g;

export function stripContinuationPauseBoilerplate(text: string): string {
  return text
    .replace(PAUSE_BOILERPLATE_RX, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeContinuationOriginalPrompt(text: string): string {
  let current = text.trim();
  for (let i = 0; i < 5; i += 1) {
    const extracted = extractOriginalBriefFromContinuationPrompt(current);
    if (extracted === null || extracted.length === 0 || extracted === current) break;
    current = extracted;
  }
  return current;
}

/** Pure, byte-stable prompt reconstruction. Snapshot-tested so a future
 *  edit doesn't quietly shift the cache shape. */
export function buildContinuationPrompt(input: ContinuationPromptInput): string {
  const originalUserPrompt = normalizeContinuationOriginalPrompt(input.originalUserPrompt);
  const decisionRecap = stripContinuationPauseBoilerplate(input.decisionRecap);
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
  lines.push(originalUserPrompt);
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
  lines.push(
    decisionRecap.length > 0
      ? decisionRecap
      : 'The previous run paused before writing a useful recap; inspect the current files and continue the unfinished work.',
  );
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
