/**
 * may9 Phase 13 follow-up #30 — escalation-hint selector.
 *
 * Defect D10 from the FPS Wave Defense run: the user organically
 * escalated sonnet → opus mid-run after consecutive failures. Implied
 * cost jumped from $1.40/run (sonnet) to $10.81/run (opus) — ~8×
 * cost-per-run with no UI affordance to inform the choice.
 *
 * This selector takes the design's chat history + the currently-active
 * model and returns either null (no hint) or a structured suggestion
 * the renderer's EscalationHint component renders. The renderer then
 * decides whether to show + handle the click; this module stays pure
 * so the rule lives in one place + is unit-testable without a DOM.
 *
 * The threshold is "≥ 2 consecutive failures on the current model
 * within the last 5 minutes" — small enough to fire on real distress
 * without spamming the user on a single hiccup.
 */

export type EscalationKind = 'overloaded' | 'failed';

export interface EscalationSignal {
  modelId: string;
  /** ISO timestamp the failure was recorded. */
  at: string;
  kind: EscalationKind;
}

export interface EscalationHint {
  /** The model the user is on now. Surfaced in the message body. */
  fromModel: string;
  /** The model the hint suggests escalating to. */
  toModel: string;
  /** Number of consecutive failures on `fromModel` that triggered the
   *  hint. Surfaced in the message body. */
  consecutiveFailures: number;
  /** Free-form cost note (e.g. "≈8× more per run"). The renderer
   *  decides how prominent to make this. */
  costNote: string;
}

/** Default threshold: ≥ 2 consecutive failures within the last
 *  5 minutes triggers the hint. */
export const ESCALATION_MIN_FAILURES = 2;
export const ESCALATION_WINDOW_MS = 5 * 60 * 1000;

/** Map of "if you're on X, suggest Y" promotions. The model IDs are
 *  the user-facing strings produced by the rendererAccess + the
 *  recordRunUsage write path; mismatches fall through harmlessly. */
const ESCALATION_TARGETS: Readonly<Record<string, { to: string; cost: string }>> = {
  'claude-haiku-4-5-20251001': {
    to: 'claude-sonnet-4-6',
    cost: '≈3-4× more per run',
  },
  'claude-haiku-4-5': {
    to: 'claude-sonnet-4-6',
    cost: '≈3-4× more per run',
  },
  'claude-sonnet-4-6': {
    to: 'claude-opus-4-7',
    cost: '≈8× more per run (FPS baseline: sonnet $1.40/run, opus $10.81/run)',
  },
  'claude-sonnet-4-5': {
    to: 'claude-opus-4-7',
    cost: '≈8× more per run',
  },
  // Opus -> nothing higher; the selector returns null.
};

/** Compute an escalation hint, or null when no escalation makes sense.
 *
 *  @param signals  Recent failure signals across all models (the
 *                  caller filters chat_messages or run_usage rows
 *                  into this shape).
 *  @param currentModel  The model that would be used for the NEXT
 *                  turn — the renderer's `active.model.modelId` value.
 *  @param now      Current timestamp (defaults to Date.now() — pass
 *                  explicitly in tests for determinism).
 */
export function selectEscalationHint(
  signals: ReadonlyArray<EscalationSignal>,
  currentModel: string,
  now: number = Date.now(),
): EscalationHint | null {
  const target = ESCALATION_TARGETS[currentModel];
  if (target === undefined) return null; // Already at the top of the ladder, or unknown model.

  // Filter to signals on the CURRENT model within the window.
  const cutoff = now - ESCALATION_WINDOW_MS;
  const matching = signals.filter((s) => {
    if (s.modelId !== currentModel) return false;
    const t = Date.parse(s.at);
    if (Number.isNaN(t)) return false;
    return t >= cutoff;
  });

  // Walk the matching signals from most-recent backwards. We want
  // CONSECUTIVE failures — once we see a model switch in the source
  // signal stream OR the time window ends, we stop counting. Since
  // the input is per-model already we just need to count up to the
  // threshold.
  if (matching.length < ESCALATION_MIN_FAILURES) return null;

  return {
    fromModel: currentModel,
    toModel: target.to,
    consecutiveFailures: matching.length,
    costNote: target.cost,
  };
}
