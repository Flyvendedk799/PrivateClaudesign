/**
 * Phase 3 — `computeImpliedCost` is the budget UI's source of truth for
 * subscription-provider runs (where the provider returns costUsd=0). The
 * formula must be byte-stable across releases so daily-usage charts don't
 * silently shift.
 */

import { describe, expect, it } from 'vitest';
import { ANTHROPIC_PRICING, type UsageTokens, computeImpliedCost } from './pricing';

const FPS_RUN: UsageTokens = {
  // 2026-05-06 design ba2adf62 generation_id mouf8wgh-nazlpq — the actual
  // 18.8-min run that drove the user's "started from scratch" complaint.
  // Real measured token shape from run_usage.
  inputTokens: 3_254_173,
  cachedInputTokens: 2_503_195,
  cacheCreationInputTokens: 0,
  outputTokens: 67_811,
};

describe('computeImpliedCost (Phase 3)', () => {
  it('charges fresh input + cached input + output at the model-specific rates', () => {
    // 1M fresh input + 1M output for Sonnet-4-6 → $3 + $15 = $18.
    const cost = computeImpliedCost(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 1_000_000,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(18, 6);
  });

  it('cached input billed at the cached rate, not the fresh rate', () => {
    // 1M tokens, ALL cached, no output — Sonnet cached = $0.30/M.
    const cost = computeImpliedCost(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it('cache-creation tokens billed at the (higher) creation rate', () => {
    // 1M tokens, ALL cache-creation — Sonnet creation = $3.75/M.
    const cost = computeImpliedCost(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
        outputTokens: 0,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(3.75, 6);
  });

  it('FPS-run shape (mouf8wgh-nazlpq) on Sonnet-4-6 lands a sensible implied cost', () => {
    // 3.25M input (2.50M cached + 0.75M fresh), 67.8K output.
    // fresh: 0.75M * $3 = $2.253; cached: 2.50M * $0.30 = $0.751;
    // output: 67.8K * $15/M = $1.017. Total ≈ $4.02.
    const cost = computeImpliedCost(FPS_RUN, 'claude-sonnet-4-6');
    expect(cost).toBeGreaterThan(3.5);
    expect(cost).toBeLessThan(4.5);
  });

  it('Opus is ~5× Sonnet on equivalent token shapes', () => {
    const sonnet = computeImpliedCost(FPS_RUN, 'claude-sonnet-4-6');
    const opus = computeImpliedCost(FPS_RUN, 'claude-opus-4-7');
    expect(opus / sonnet).toBeGreaterThan(4);
    expect(opus / sonnet).toBeLessThan(6);
  });

  it('unknown model falls back to Sonnet-4-6 pricing (sane ballpark, never $0)', () => {
    const cost = computeImpliedCost(FPS_RUN, 'never-shipped-model-id');
    expect(cost).toBeGreaterThan(0);
    const sonnet = computeImpliedCost(FPS_RUN, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(sonnet, 6);
  });

  it('null / undefined modelId defaults to Sonnet-4-6 rather than $0', () => {
    expect(computeImpliedCost(FPS_RUN, null)).toBeGreaterThan(0);
    expect(computeImpliedCost(FPS_RUN, undefined)).toBeGreaterThan(0);
  });

  it('zero-token usage returns exactly $0', () => {
    expect(
      computeImpliedCost(
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
        'claude-sonnet-4-6',
      ),
    ).toBe(0);
  });

  it('the pricing table is frozen so accidental mutation throws', () => {
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate mutation test
      (ANTHROPIC_PRICING as any)['claude-sonnet-4-6'].inputPerMillion = 999;
    }).toThrow();
  });
});
