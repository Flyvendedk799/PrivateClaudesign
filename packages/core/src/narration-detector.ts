/**
 * Sequence-4 (game-mode guardrails) — pure, testable detector for
 * inter-tool narration emitted by the agent during a single turn.
 *
 * The 2026-05-03 c44763af trace shipped ~30 banned narration phrases
 * ("Now let me…", "The linter is tripping…", "Now fix the closing
 * brace…") despite the system prompt's explicit anti-narration rule.
 * The renderer's P2.1 filter already hides these from the user's chat,
 * but the model still pays tokens to generate them. This detector lets
 * the agent loop log telemetry and steer the model after a second
 * offense without the rest of the agent loop having to track event
 * shape.
 *
 * Kept stateful on purpose so the agent loop can drive it from
 * pi-agent-core's event stream incrementally (one call per event)
 * instead of buffering a whole turn before scoring it.
 */

export interface NarrationDetectorOptions {
  /** Inclusive upper bound on text length to count as "narration".
   *  Mid-turn explanations or the final post-`done` deliverable summary
   *  are typically much longer (300–1500 chars in the production
   *  traces). 200 catches the transitional one-liners cleanly. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 200;

export interface NarrationTurnResult {
  /** The narration segments observed THIS turn — text accumulated
   *  between two tool_use blocks. */
  narrations: ReadonlyArray<string>;
  /** Cumulative offense count across the whole run, including this
   *  turn. Useful for threshold checks (steer after N). */
  totalOffenses: number;
}

export interface NarrationDetector {
  observeTextDelta(delta: string): void;
  observeToolStart(): void;
  /** Call when the assistant turn ends. Returns a snapshot describing
   *  any narration segments that landed this turn. After the call the
   *  per-turn buffers are zeroed but the run-total counter persists. */
  endTurn(): NarrationTurnResult;
  /** Read-only run-cumulative offense count. */
  totalOffenses(): number;
}

export function createNarrationDetector(options: NarrationDetectorOptions = {}): NarrationDetector {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let toolUsesSeen = 0;
  let currentText = '';
  let narrationsThisTurn: string[] = [];
  let runningTotal = 0;
  return {
    observeTextDelta(delta: string) {
      currentText += delta;
    },
    observeToolStart() {
      const text = currentText.trim();
      if (toolUsesSeen > 0 && text.length > 0 && text.length <= maxChars) {
        narrationsThisTurn.push(text);
      }
      currentText = '';
      toolUsesSeen += 1;
    },
    endTurn() {
      const narrations = narrationsThisTurn.slice();
      runningTotal += narrations.length;
      narrationsThisTurn = [];
      currentText = '';
      toolUsesSeen = 0;
      return { narrations, totalOffenses: runningTotal };
    },
    totalOffenses() {
      return runningTotal;
    },
  };
}
