/**
 * Phase 4 — first-class continuation row. The runtime (or model) decided
 * the run should pause cleanly instead of truncating; the row carries
 * the decision recap, latest todo snapshot ref, and the threshold that
 * tripped. Renders as a non-modal Continue / View-recap panel.
 *
 * Per the Phase 7 ambition guardrails, "Continue" must NEVER cap the
 * model — it resumes the same run with full context fidelity. The
 * actual run-resumption IPC lands in the runtime wiring task; this
 * component declares the contract.
 */

import type { ChatContinuationPendingPayload } from '@open-codesign/shared';
import { Pause, PlayCircle } from 'lucide-react';
import { useState } from 'react';

const REASON_LABEL: Record<ChatContinuationPendingPayload['reason'], string> = {
  context_threshold: 'Context window 80% full',
  output_budget: 'Output token budget reached',
  wall_clock: 'Wall-clock 10 min',
  model_requested: 'Model requested pause',
  manual: 'You paused the run',
};

export function formatContinuationLabel(payload: ChatContinuationPendingPayload): string {
  const reason = REASON_LABEL[payload.reason] ?? 'Paused';
  const seconds = Math.max(1, Math.round(payload.wallClockMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const secondsTail = seconds % 60;
  const time = minutes > 0 ? `${minutes}m ${secondsTail}s` : `${secondsTail}s`;
  return `${reason} · ${time} · ${payload.outputTokens.toLocaleString()} output tokens`;
}

export function ContinuationPendingRow({
  payload,
  onContinue,
}: {
  payload: ChatContinuationPendingPayload;
  /** Called when the user clicks "Continue". The runtime is responsible
   *  for resumption — this component just signals intent. */
  onContinue?: () => void;
}) {
  const [recapExpanded, setRecapExpanded] = useState(false);
  const label = formatContinuationLabel(payload);
  return (
    <div
      data-testid="continuation-pending"
      data-reason={payload.reason}
      className="rounded-[var(--radius-md)] border border-[var(--color-accent)]/40 bg-[var(--color-surface)] px-[var(--space-3)] py-[var(--space-2)]"
    >
      <div className="flex items-center gap-[var(--space-2)] text-[12.5px] text-[var(--color-text-primary)]">
        <Pause className="w-[14px] h-[14px] shrink-0 text-[var(--color-accent)]" aria-hidden />
        <span className="font-medium">Run paused</span>
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{label}</span>
      </div>
      {payload.decisionRecap.length > 0 ? (
        <div className="mt-[var(--space-1)]">
          <button
            type="button"
            data-testid="continuation-recap-toggle"
            onClick={() => setRecapExpanded((v) => !v)}
            aria-expanded={recapExpanded ? 'true' : 'false'}
            className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] underline"
          >
            {recapExpanded ? 'Hide recap' : 'Show recap'}
          </button>
          {recapExpanded ? (
            <div className="mt-[var(--space-1)] text-[12px] leading-[1.55] text-[var(--color-text-secondary)] whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto">
              {payload.decisionRecap}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-2)]">
        <button
          type="button"
          data-testid="continuation-continue-button"
          onClick={onContinue}
          className="inline-flex items-center gap-[6px] rounded-[var(--radius-sm)] bg-[var(--color-accent)] text-[var(--color-on-accent,white)] px-[var(--space-3)] py-[3px] text-[11.5px] font-medium hover:opacity-90"
        >
          <PlayCircle className="w-[14px] h-[14px]" aria-hidden />
          Continue
        </button>
      </div>
    </div>
  );
}
