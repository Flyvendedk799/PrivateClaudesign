import { Check, Loader2, X, XCircle } from 'lucide-react';
import { useCodesignStore } from '../../store';

/**
 * level-and-world-designer §Phase 8.2 — floating progress card for the
 * unified "Decompose game" orchestrator. Mounted at the App root so
 * the user can tab away from the Sprites/Animations/Levels/World view
 * and still see how far the decomposition has progressed.
 *
 * States:
 *   running   → spinner on the active phase, checkmarks on done ones
 *   completed → all checkmarks, "Dismiss" button
 *   failed    → red marker on the failed phase + retry/dismiss
 *   cancelled → strikethrough on remaining + dismiss
 */
export function DecomposeProgressCard() {
  const flow = useCodesignStore((s) => s.decomposeFlow);
  const cancel = useCodesignStore((s) => s.cancelDecomposeFlow);
  const dismiss = useCodesignStore((s) => s.dismissDecomposeFlow);

  if (flow === null) return null;

  const totalPhases = flow.phases.length;
  const completedCount = flow.phases.filter((p) => p.status === 'completed').length;
  const headline =
    flow.overallStatus === 'running'
      ? `Decomposing game · ${completedCount + 1}/${totalPhases}`
      : flow.overallStatus === 'completed'
        ? `Decomposition complete · ${totalPhases}/${totalPhases}`
        : flow.overallStatus === 'cancelled'
          ? `Decomposition cancelled · ${completedCount}/${totalPhases} kept`
          : `Decomposition failed at phase ${flow.currentPhaseIndex + 1}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed bottom-[var(--space-3)] right-[var(--space-3)] z-[1000] w-[320px] rounded-[var(--radius-md)] border border-[var(--color-border-muted)] bg-[var(--color-background)] p-[var(--space-3)] shadow-[0_8px_28px_rgba(0,0,0,0.4)]"
    >
      <div className="flex items-start justify-between gap-[var(--space-2)]">
        <div className="flex flex-col">
          <h3 className="text-[12px] font-medium text-[var(--color-text-primary)]">{headline}</h3>
          <span className="mt-[2px] text-[10px] text-[var(--color-text-muted)]">
            {flow.overallStatus === 'running'
              ? 'Runs through Sprites → Animations → Levels → World'
              : flow.overallStatus === 'failed'
                ? 'Earlier phases stay; restart to retry the failed one.'
                : flow.overallStatus === 'cancelled'
                  ? 'Earlier phases stay registered. Restart anytime.'
                  : null}
          </span>
        </div>
        {flow.overallStatus === 'running' ? (
          <button
            type="button"
            onClick={cancel}
            aria-label="Cancel decomposition"
            title="Cancel — earlier phases stay registered."
            className="rounded-[var(--radius-sm)] p-[var(--space-1)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="rounded-[var(--radius-sm)] p-[var(--space-1)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <ol className="mt-[var(--space-2)] flex flex-col gap-[2px]">
        {flow.phases.map((phase, i) => (
          <li
            key={phase.id}
            className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-sm)] px-[var(--space-1)] py-[2px]"
            data-testid={`decompose-phase-${phase.id}`}
          >
            <PhaseIcon status={phase.status} />
            <span
              className={`flex-1 text-[11px] ${
                phase.status === 'completed'
                  ? 'text-[var(--color-text-secondary)]'
                  : phase.status === 'running'
                    ? 'text-[var(--color-text-primary)]'
                    : phase.status === 'failed'
                      ? 'text-red-400'
                      : phase.status === 'skipped'
                        ? 'text-[var(--color-text-muted)] line-through'
                        : 'text-[var(--color-text-muted)]'
              }`}
            >
              {phase.label}
              {phase.status === 'failed' && phase.errorMessage !== undefined ? (
                <div
                  className="mt-[2px] truncate text-[10px] opacity-80"
                  title={phase.errorMessage}
                >
                  {phase.errorMessage}
                </div>
              ) : null}
            </span>
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {i + 1}/{totalPhases}
            </span>
          </li>
        ))}
      </ol>
      {flow.overallStatus === 'failed' ? (
        <div className="mt-[var(--space-2)] flex justify-end gap-[var(--space-2)]">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-2)] py-[2px] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PhaseIcon({
  status,
}: {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
}) {
  if (status === 'running') {
    return (
      <Loader2
        className="h-3.5 w-3.5 codesign-spin-once text-[var(--color-accent)]"
        aria-hidden="true"
      />
    );
  }
  if (status === 'completed') {
    return <Check className="h-3.5 w-3.5 text-[#7dffb1]" aria-hidden="true" />;
  }
  if (status === 'failed') {
    return <XCircle className="h-3.5 w-3.5 text-red-400" aria-hidden="true" />;
  }
  return (
    <div
      aria-hidden="true"
      className={`h-3.5 w-3.5 rounded-full border ${
        status === 'skipped'
          ? 'border-[var(--color-text-muted)]/30 bg-transparent'
          : 'border-[var(--color-border-muted)] bg-[var(--color-background-secondary)]'
      }`}
    />
  );
}
