/**
 * may9 Phase 13 follow-up #30 — EscalationHint UI.
 *
 * Pure presentational component. Drops a small non-modal banner above
 * the chat input when the selectEscalationHint helper returns a hint.
 * Informational-only in v1: clicking "Open settings" jumps to the
 * model picker; the auto-switch + one-shot override is a separate
 * follow-up so we don't risk surprise model swaps.
 */
import type { EscalationHint as EscalationHintData } from '@open-codesign/shared';

export interface EscalationHintProps {
  hint: EscalationHintData;
  /** Click handler for the "Open model settings" affordance. The
   *  store action navigates to the settings dialog with the model
   *  picker pre-focused. */
  onOpenSettings: () => void;
  /** Optional dismiss handler. When provided the banner shows an X;
   *  when undefined the banner persists until the underlying signals
   *  age out. */
  onDismiss?: () => void;
}

export function EscalationHint({ hint, onOpenSettings, onDismiss }: EscalationHintProps) {
  const fromShort = hint.fromModel.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const toShort = hint.toModel.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return (
    <div
      role="status"
      data-testid="escalation-hint"
      className="rounded-[var(--radius-md)] border border-[var(--color-warning,_theme(colors.amber.500))] bg-[var(--color-surface)] px-[var(--space-3)] py-[var(--space-2)] text-[12.5px] text-[var(--color-text-primary)]"
    >
      <div className="flex items-start gap-[var(--space-2)]">
        <div className="flex-1">
          <span className="font-semibold">{hint.consecutiveFailures} consecutive failures on </span>
          <code className="rounded-[var(--radius-sm)] bg-[var(--color-background-secondary)] px-1 text-[11.5px]">
            {fromShort}
          </code>
          <span> in the last 5 minutes. Consider switching to </span>
          <code className="rounded-[var(--radius-sm)] bg-[var(--color-background-secondary)] px-1 text-[11.5px]">
            {toShort}
          </code>
          <span className="ml-1 text-[var(--color-text-muted)]">— {hint.costNote}</span>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-background-secondary)] px-[var(--space-2)] py-[1px] hover:bg-[var(--color-background-tertiary)]"
        >
          Open settings
        </button>
        {onDismiss !== undefined ? (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-[var(--space-2)] py-[1px] hover:bg-[var(--color-background-tertiary)]"
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}
