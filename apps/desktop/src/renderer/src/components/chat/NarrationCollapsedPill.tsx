/**
 * Plan 2026-05-08 P4 — collapse-don't-drop for inter-tool narration.
 *
 * Background. The 2026-05-03 narration filter (plan0305 P2.1) recognised
 * "Now adding…" / "Let me try…" assistant_text rows sandwiched between
 * tool_calls and dropped them from the rendered chat. The drop kept the
 * viewport clean, but threw away signal a power user occasionally wants
 * to inspect ("what was the model thinking when it called tool N+1?").
 *
 * This component replaces the drop with a tiny disclosure pill: one line
 * of muted text ("inter-tool note · 47 chars") that reveals the original
 * prose on click. The chat reads exactly the same in the default state;
 * the difference only shows up when a curious user starts clicking.
 *
 * Mirrors the existing `TodoSnapshotCollapsed` pattern (same useState,
 * same aria-expanded, same expand/collapse caption) so the chat has one
 * consistent disclosure language for "info hidden by default."
 */

import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

/** Pure label formatter — exported for test ergonomics. */
export function formatNarrationPillLabel(text: string): string {
  const len = text.length;
  return `inter-tool note · ${len} char${len === 1 ? '' : 's'}`;
}

export function NarrationCollapsedPill({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const label = formatNarrationPillLabel(text);
  return (
    <div
      data-testid="narration-collapsed-pill"
      data-expanded={expanded ? 'true' : 'false'}
      className="rounded-[var(--radius-sm)] px-[var(--space-2)] py-[2px]"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded ? 'true' : 'false'}
        className="w-full flex items-center gap-[var(--space-2)] text-left text-[11px] italic text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        <ChevronRight
          className={`w-[10px] h-[10px] shrink-0 transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
          aria-hidden
        />
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide opacity-70 not-italic">
          {expanded ? 'collapse' : 'expand'}
        </span>
      </button>
      {expanded ? (
        <div
          data-testid="narration-collapsed-pill-body"
          className="mt-[var(--space-1)] ml-[16px] text-[11px] italic leading-[1.55] text-[var(--color-text-muted)] whitespace-pre-wrap break-words max-h-[160px] overflow-y-auto"
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}
