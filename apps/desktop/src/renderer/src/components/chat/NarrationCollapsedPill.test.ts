/**
 * Plan 2026-05-08 P4 — `formatNarrationPillLabel` is the pure label
 * formatter for the collapse-don't-drop pill. The label must read at a
 * glance ("inter-tool note · 47 chars") so the user can decide whether
 * to expand without parsing the original prose. Pluralisation matters
 * (1 char vs 2 chars) because typo-rate "1 chars" reads as broken UI.
 */

import { describe, expect, it } from 'vitest';
import { formatNarrationPillLabel } from './NarrationCollapsedPill';

describe('formatNarrationPillLabel (plan 2026-05-08 P4)', () => {
  it('formats the standard short narration with plural', () => {
    expect(formatNarrationPillLabel('Now adding the keyframes CSS and first components:')).toBe(
      'inter-tool note · 50 chars',
    );
  });

  it('uses singular for exactly one character', () => {
    expect(formatNarrationPillLabel('a')).toBe('inter-tool note · 1 char');
  });

  it('uses plural for zero characters (edge case — should never happen)', () => {
    expect(formatNarrationPillLabel('')).toBe('inter-tool note · 0 chars');
  });

  it('uses plural for two characters', () => {
    expect(formatNarrationPillLabel('ok')).toBe('inter-tool note · 2 chars');
  });

  it('counts unicode characters by JS .length (UTF-16 code units, matches DOM)', () => {
    // 'café' is 4 code units; the user sees 4 visible glyphs. Surrogate
    // pairs (emoji etc.) would diverge but inter-tool narration is
    // English text in practice — match what `text.length` shows.
    expect(formatNarrationPillLabel('café')).toBe('inter-tool note · 4 chars');
  });
});
