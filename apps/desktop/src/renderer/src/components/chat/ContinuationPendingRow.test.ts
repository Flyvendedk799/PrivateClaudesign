/**
 * Phase 4 — `formatContinuationLabel` is a pure formatter for the
 * Run-paused row's metadata strip. The label must read at a glance:
 * "Context window 80% full · 12m 0s · 50,000 output tokens". One label
 * per documented pause reason; tokens render with a thousands separator.
 */

import type { ChatContinuationPendingPayload } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { formatContinuationLabel } from './ContinuationPendingRow';

const base: ChatContinuationPendingPayload = {
  reason: 'context_threshold',
  decisionRecap: '',
  outputTokens: 50_000,
  contextUsedPct: 0.8,
  wallClockMs: 720_000, // 12 min
};

describe('formatContinuationLabel (Phase 4)', () => {
  it('renders context_threshold reason with mm:ss-style time and grouped tokens', () => {
    expect(formatContinuationLabel(base)).toBe(
      'Context window 80% full · 12m 0s · 50,000 output tokens',
    );
  });

  it('seconds-only when under a minute', () => {
    expect(formatContinuationLabel({ ...base, wallClockMs: 32_000 })).toContain('32s');
    expect(formatContinuationLabel({ ...base, wallClockMs: 32_000 })).not.toContain('m');
  });

  it('every reason has a friendly label', () => {
    const reasons: ChatContinuationPendingPayload['reason'][] = [
      'context_threshold',
      'output_budget',
      'wall_clock',
      'model_requested',
      'manual',
      'unplanned_abort',
    ];
    for (const reason of reasons) {
      const out = formatContinuationLabel({ ...base, reason });
      expect(out, `reason "${reason}" should produce a non-empty label`).not.toBe('');
      expect(out).not.toMatch(/^\s*·/);
    }
  });

  it('floors at 1s for sub-second pauses (zero is misleading)', () => {
    expect(formatContinuationLabel({ ...base, wallClockMs: 200 })).toContain('1s');
  });
});
