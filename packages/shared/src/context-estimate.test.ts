/**
 * Integration G — `estimateContextUsedPct` is the missing input to
 * `shouldPauseForContinuation`'s `context_threshold` rule. Approximates
 * pi-agent-core's re-replay-on-every-turn behaviour from cumulative
 * byte counters the runtime tracks, so the threshold can fire on real
 * conditions instead of staying at 0.
 *
 * Pure function tests — bytes in, fraction out, no IO.
 */

import { describe, expect, it } from 'vitest';
import {
  type CumulativeContextBytes,
  MODEL_CONTEXT_WINDOWS,
  contextWindowFor,
  estimateContextUsedPct,
} from './pricing';

const zero: CumulativeContextBytes = {
  initialPromptBytes: 0,
  outputBytes: 0,
  toolResultBytes: 0,
};

describe('contextWindowFor (Integration G)', () => {
  it('returns the Sonnet-4-6 window (200k) for the canonical id', () => {
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(200_000);
  });

  it('returns 1M for the Sonnet-4-6 1M-context variant', () => {
    expect(contextWindowFor('claude-sonnet-4-6[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-4-7[1m]')).toBe(1_000_000);
  });

  it('falls back to 200k for unknown models', () => {
    expect(contextWindowFor('never-released-model')).toBe(200_000);
    expect(contextWindowFor('')).toBe(200_000);
    expect(contextWindowFor(null)).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
  });

  it('the lookup table is frozen', () => {
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate mutation test
      (MODEL_CONTEXT_WINDOWS as any)['claude-sonnet-4-6'] = 999;
    }).toThrow();
  });
});

describe('estimateContextUsedPct (Integration G)', () => {
  it('returns 0 for zero cumulative bytes', () => {
    expect(estimateContextUsedPct(zero, 'claude-sonnet-4-6')).toBe(0);
  });

  it('200k tokens of input on a 200k window reads as 1.0', () => {
    // 200_000 tokens × 4 chars/token = 800_000 bytes
    expect(
      estimateContextUsedPct(
        { initialPromptBytes: 800_000, outputBytes: 0, toolResultBytes: 0 },
        'claude-sonnet-4-6',
      ),
    ).toBeCloseTo(1, 4);
  });

  it('80k cumulative tokens on a 200k window reads as 0.4 — below the pause threshold', () => {
    // 80_000 × 4 = 320_000 bytes. Pause threshold is 0.8 — so 0.4 is well below.
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 320_000, outputBytes: 0, toolResultBytes: 0 },
      'claude-sonnet-4-6',
    );
    expect(pct).toBeCloseTo(0.4, 4);
    expect(pct).toBeLessThan(0.8);
  });

  it('160k cumulative tokens on a 200k window crosses the pause threshold (0.8)', () => {
    // 160_000 × 4 = 640_000 bytes
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 640_000, outputBytes: 0, toolResultBytes: 0 },
      'claude-sonnet-4-6',
    );
    expect(pct).toBeGreaterThanOrEqual(0.8);
  });

  it('sums all three byte sources', () => {
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 200_000, outputBytes: 200_000, toolResultBytes: 200_000 },
      'claude-sonnet-4-6',
    );
    // 600_000 bytes → 150_000 tokens / 200_000 window = 0.75
    expect(pct).toBeCloseTo(0.75, 4);
  });

  it('a 1M-context model has a higher headroom for the same byte count', () => {
    const bytes = { initialPromptBytes: 800_000, outputBytes: 0, toolResultBytes: 0 };
    const sonnet = estimateContextUsedPct(bytes, 'claude-sonnet-4-6');
    const sonnet1m = estimateContextUsedPct(bytes, 'claude-sonnet-4-6[1m]');
    expect(sonnet).toBeGreaterThan(sonnet1m);
    expect(sonnet1m).toBeCloseTo(0.2, 4);
  });

  it('clamps at 1.5 even for impossibly large estimates (defensive)', () => {
    const pct = estimateContextUsedPct(
      { initialPromptBytes: 1_000_000_000, outputBytes: 0, toolResultBytes: 0 },
      'claude-sonnet-4-6',
    );
    expect(pct).toBe(1.5);
  });

  it('rejects negative inputs (treated as zero)', () => {
    expect(
      estimateContextUsedPct(
        { initialPromptBytes: -100, outputBytes: -100, toolResultBytes: 0 },
        'claude-sonnet-4-6',
      ),
    ).toBe(0);
  });

  it('FPS-run shape (mouf8wgh-nazlpq): real data → expected pct', () => {
    // Real run had 3.25M input tokens cumulative at end. That's WAY past
    // 200k — the model was using the 1M-context variant. Estimator
    // should reflect that: 3.25M / 1M = ~3.25 → clamped to 1.5.
    // For Sonnet 200k it'd be 16.25 → clamped to 1.5 too.
    const FPS_INPUT_BYTES = 3_254_173 * 4; // 3.25M tokens
    const pctSonnet = estimateContextUsedPct(
      { initialPromptBytes: FPS_INPUT_BYTES, outputBytes: 0, toolResultBytes: 0 },
      'claude-sonnet-4-6',
    );
    expect(pctSonnet).toBe(1.5); // clamped
    const pct1m = estimateContextUsedPct(
      { initialPromptBytes: FPS_INPUT_BYTES, outputBytes: 0, toolResultBytes: 0 },
      'claude-sonnet-4-6[1m]',
    );
    expect(pct1m).toBeGreaterThan(1.0); // way over the 1M window
  });
});
