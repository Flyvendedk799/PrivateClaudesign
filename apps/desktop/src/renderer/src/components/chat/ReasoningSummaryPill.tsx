/**
 * Phase 2 — collapsible reasoning rollup. The agent stream rolls up each
 * thinking burst into a `reasoning_summary` chat row at the moment the
 * model transitions to a tool/text/agent-end signal; this component
 * renders the row as a compact pill ("Reasoned for 12s · 1.4k tokens —
 * patch index.html") that expands to the full thinking text on click.
 *
 * Survives reload (the row is on disk), unlike the ephemeral
 * `streamingThinking` panel which only exists during the active stream.
 */

import type { ChatReasoningSummaryPayload } from '@open-codesign/shared';
import { Brain } from 'lucide-react';
import { useState } from 'react';

export function formatReasoningPillLabel(payload: ChatReasoningSummaryPayload): string {
  const seconds = Math.max(1, Math.round(payload.durationMs / 1000));
  const tokens = payload.tokenEstimate;
  const tokenStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  const tail = payload.toolName && payload.toolName.length > 0 ? ` — ${payload.toolName}` : '';
  return `Reasoned for ${seconds}s · ${tokenStr} tokens${tail}`;
}

export function ReasoningSummaryPill({ payload }: { payload: ChatReasoningSummaryPayload }) {
  const [expanded, setExpanded] = useState(false);
  const label = formatReasoningPillLabel(payload);
  return (
    <div
      data-testid="reasoning-summary-pill"
      data-expanded={expanded ? 'true' : 'false'}
      className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-background-secondary)]/60 px-[var(--space-3)] py-[var(--space-1)]"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded ? 'true' : 'false'}
        className="w-full flex items-center gap-[var(--space-2)] text-left text-[12px] italic text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        <Brain className="w-[12px] h-[12px] shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide opacity-70 not-italic">
          {expanded ? 'collapse' : 'expand'}
        </span>
      </button>
      {expanded ? (
        <div className="mt-[var(--space-2)] text-[12px] italic leading-[1.55] text-[var(--color-text-muted)] whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
          {payload.fullText}
        </div>
      ) : null}
    </div>
  );
}
