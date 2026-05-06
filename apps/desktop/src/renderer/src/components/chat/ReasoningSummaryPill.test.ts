/**
 * Phase 2 — `formatReasoningPillLabel` is a pure formatter for the rolled-up
 * thinking burst. The pill must read at a glance: "Reasoned for 12s · 1.4k
 * tokens — patch index.html". When the rollup didn't capture a toolName
 * (rare — the burst was followed by user-visible text instead) the tail
 * is omitted, never replaced with a placeholder.
 */

import type { ChatReasoningSummaryPayload } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { formatReasoningPillLabel } from './ReasoningSummaryPill';

const base: ChatReasoningSummaryPayload = {
  fullText: 'thinking…',
  durationMs: 12_400,
  tokenEstimate: 1400,
  finalisedAt: '2026-05-06T19:14:22.000Z',
};

describe('formatReasoningPillLabel (Phase 2)', () => {
  it('formats seconds rounded to nearest, kilo-tokens with one decimal', () => {
    expect(formatReasoningPillLabel({ ...base, toolName: 'str_replace_based_edit_tool' })).toBe(
      'Reasoned for 12s · 1.4k tokens — str_replace_based_edit_tool',
    );
  });

  it('floors at 1s for any sub-1s burst (zero is misleading)', () => {
    expect(formatReasoningPillLabel({ ...base, durationMs: 200, tokenEstimate: 30 })).toBe(
      'Reasoned for 1s · 30 tokens',
    );
  });

  it('emits raw token count under 1000 (no .0k suffix)', () => {
    expect(formatReasoningPillLabel({ ...base, tokenEstimate: 750 })).toBe(
      'Reasoned for 12s · 750 tokens',
    );
  });

  it('omits the toolName tail entirely when not provided (no placeholder)', () => {
    const out = formatReasoningPillLabel(base);
    expect(out).toBe('Reasoned for 12s · 1.4k tokens');
    expect(out).not.toContain('—');
  });

  it('omits the toolName tail when toolName is empty string', () => {
    expect(formatReasoningPillLabel({ ...base, toolName: '' })).toBe(
      'Reasoned for 12s · 1.4k tokens',
    );
  });
});
