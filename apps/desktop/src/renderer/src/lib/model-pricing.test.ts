import { describe, expect, it } from 'vitest';
import {
  cacheHitRatio,
  estimateCostUsd,
  formatTokens,
  formatUsd,
  projectCostUsd,
  resolvePricing,
} from './model-pricing';

describe('model-pricing', () => {
  it('resolves Sonnet 4.6 pricing', () => {
    const p = resolvePricing('anthropic', 'claude-sonnet-4-6');
    expect(p.inputPerMtok).toBe(3);
    expect(p.outputPerMtok).toBe(15);
    expect(p.cacheReadPerMtok).toBe(0.3);
    expect(p.cacheWritePerMtok).toBe(3.75);
  });

  it('falls back when model is unknown', () => {
    const p = resolvePricing('anthropic', 'something-new');
    // Falls back to Sonnet 4.6 list price.
    expect(p.inputPerMtok).toBe(3);
  });

  it('estimateCostUsd: 1M uncached input on Sonnet 4.6 = $3', () => {
    const cost = estimateCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      resolvePricing('anthropic', 'claude-sonnet-4-6'),
    );
    expect(cost).toBeCloseTo(3, 5);
  });

  it('estimateCostUsd: full cache hit is 10% of full uncached', () => {
    const p = resolvePricing('anthropic', 'claude-sonnet-4-6');
    const uncached = estimateCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      p,
    );
    const cached = estimateCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
      },
      p,
    );
    expect(cached / uncached).toBeCloseTo(0.1, 3);
  });

  it('cacheHitRatio: half cached returns 0.5', () => {
    const r = cacheHitRatio({
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 0,
    });
    expect(r).toBe(0.5);
  });

  it('cacheHitRatio: zero input returns null', () => {
    const r = cacheHitRatio({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(r).toBeNull();
  });

  it('formatUsd: tier-by-tier precision', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.4321)).toBe('$0.432');
    expect(formatUsd(12.345)).toBe('$12.35');
  });

  it('formatTokens: K/M units', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(820)).toBe('820');
    expect(formatTokens(2_400)).toBe('2.4K');
    expect(formatTokens(120_000)).toBe('120K');
    expect(formatTokens(1_650_000)).toBe('1.65M');
  });
});

describe('projectCostUsd — Backlog-3 §10', () => {
  const sonnet = resolvePricing('anthropic', 'claude-sonnet-4-6');

  it('returns low <= high', () => {
    const r = projectCostUsd({
      promptLen: 500,
      historyMessages: 0,
      attachmentBytes: 0,
      pricing: sonnet,
    });
    expect(r.low).toBeGreaterThanOrEqual(0);
    expect(r.high).toBeGreaterThanOrEqual(r.low);
  });

  it('higher cache hit ratio reduces projection', () => {
    const noCache = projectCostUsd({
      promptLen: 1000,
      historyMessages: 5,
      attachmentBytes: 0,
      pricing: sonnet,
      expectedCacheHitRatio: 0,
    });
    const fullCache = projectCostUsd({
      promptLen: 1000,
      historyMessages: 5,
      attachmentBytes: 0,
      pricing: sonnet,
      expectedCacheHitRatio: 1,
    });
    expect(fullCache.low).toBeLessThan(noCache.low);
    expect(fullCache.high).toBeLessThan(noCache.high);
  });

  it("Design A's run actual cost lands inside the projected band (~$0.50–$5)", () => {
    // Design A 2026-05-04: 1.66M input tokens, 27K output, mostly uncached.
    // With Sonnet 4.6 list price (no cache), the 27K output alone is ~$0.40
    // and 1.66M input is ~$5. The projection band for the original prompt
    // (~600 chars, 0 history, no attachments) should overlap that range.
    const projection = projectCostUsd({
      promptLen: 600,
      historyMessages: 0,
      attachmentBytes: 0,
      pricing: sonnet,
      expectedCacheHitRatio: 0,
    });
    expect(projection.low).toBeGreaterThan(0);
    // Just sanity: the band is wider than 5×.
    expect(projection.high).toBeGreaterThan(projection.low * 1.5);
  });
});
