/**
 * Phase 4 — local model pricing table for live cost display.
 *
 * BYOK / no-telemetry constraint: pricing lookups MUST be local. We never
 * fetch prices at runtime. The table is versioned with `schemaVersion` so
 * future Changesets can ship updates without breaking older installs that
 * fall back to the bundled snapshot.
 *
 * Cost is computed renderer-side from `usage` deltas the main process
 * already aggregates. The provider-reported `costUsd` (when present in the
 * pi-ai usage envelope) is authoritative for end-of-run totals; this table
 * powers the *live* in-flight estimate while the run is mid-stream.
 *
 * Numbers are USD per 1M tokens (Anthropic / OpenAI list prices). Cache
 * read = 10% of input, cache write = 125% of input on Anthropic — matches
 * the published rate card so cache-hit ratio actually reflects savings.
 */

export const PRICING_SCHEMA_VERSION = 1;

export interface ModelPricing {
  /** USD per million uncached input tokens. */
  inputPerMtok: number;
  /** USD per million cache-read input tokens (typically 0.10×input). */
  cacheReadPerMtok: number;
  /** USD per million cache-creation input tokens (typically 1.25×input). */
  cacheWritePerMtok: number;
  /** USD per million output tokens. */
  outputPerMtok: number;
}

const ANTHROPIC: Record<string, ModelPricing> = {
  // Sonnet 4.6 — primary model in today's runs.
  'claude-sonnet-4-6': {
    inputPerMtok: 3,
    cacheReadPerMtok: 0.3,
    cacheWritePerMtok: 3.75,
    outputPerMtok: 15,
  },
  'claude-sonnet-4-5': {
    inputPerMtok: 3,
    cacheReadPerMtok: 0.3,
    cacheWritePerMtok: 3.75,
    outputPerMtok: 15,
  },
  'claude-opus-4-7': {
    inputPerMtok: 15,
    cacheReadPerMtok: 1.5,
    cacheWritePerMtok: 18.75,
    outputPerMtok: 75,
  },
  'claude-opus-4-6': {
    inputPerMtok: 15,
    cacheReadPerMtok: 1.5,
    cacheWritePerMtok: 18.75,
    outputPerMtok: 75,
  },
  'claude-haiku-4-5': {
    inputPerMtok: 1,
    cacheReadPerMtok: 0.1,
    cacheWritePerMtok: 1.25,
    outputPerMtok: 5,
  },
};

const OPENAI: Record<string, ModelPricing> = {
  'gpt-5': {
    inputPerMtok: 2,
    cacheReadPerMtok: 0.5,
    cacheWritePerMtok: 2,
    outputPerMtok: 8,
  },
  'gpt-4o': {
    inputPerMtok: 2.5,
    cacheReadPerMtok: 1.25,
    cacheWritePerMtok: 2.5,
    outputPerMtok: 10,
  },
};

/** Resolve a (provider, modelId) to its pricing. Falls back to a
 *  conservative Sonnet-class price when unknown so the UI still shows a
 *  number — consistent with "best-effort live estimate" framing. */
export function resolvePricing(provider: string | null, modelId: string | null): ModelPricing {
  if (provider !== null && modelId !== null) {
    if (provider.startsWith('anthropic') || provider === 'anthropic') {
      const hit = ANTHROPIC[modelId];
      if (hit) return hit;
    }
    if (provider === 'openai' || provider.startsWith('openai')) {
      const hit = OPENAI[modelId];
      if (hit) return hit;
    }
  }
  const fallback = ANTHROPIC['claude-sonnet-4-6'];
  if (fallback === undefined) throw new Error('claude-sonnet-4-6 pricing missing');
  return fallback;
}

export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Compute USD cost from a usage snapshot.
 *  inputTokens already includes cached + cache-creation; we split it into
 *  the three buckets and price each. */
export function estimateCostUsd(usage: UsageForCost, pricing: ModelPricing): number {
  const cacheRead = Math.max(0, usage.cachedInputTokens);
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens);
  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const outputs = Math.max(0, usage.outputTokens);
  const cost =
    (uncachedInput * pricing.inputPerMtok +
      cacheRead * pricing.cacheReadPerMtok +
      cacheWrite * pricing.cacheWritePerMtok +
      outputs * pricing.outputPerMtok) /
    1_000_000;
  return cost;
}

/** Cache-hit ratio of input tokens served from the cache.
 *  Returns null when there are no input tokens (avoids 0/0). */
export function cacheHitRatio(usage: UsageForCost): number | null {
  if (usage.inputTokens <= 0) return null;
  return Math.max(0, Math.min(1, usage.cachedInputTokens / usage.inputTokens));
}

/** Format a USD cost with sensible precision for in-UI display.
 *  Sub-cent → 4 decimals; sub-dollar → 3; ≥$1 → 2. */
export function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Format a token count with K/M units so the status bar stays compact. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Backlog-3 §10 — pre-flight cost projection. Heuristic based on the
 * 2026-05-04 traces (Design A: 1.66M input tokens, ~5% output ratio
 * for design runs; Design B: 727K input). Returns a (low, high) band
 * so the UI doesn't oversell precision. Inputs:
 *   - promptLen: characters of the user prompt
 *   - historyMessages: number of prior chat messages going into history
 *   - attachmentBytes: total bytes of attached images/files
 *   - pricing: from resolvePricing()
 *   - expectedCacheHitRatio: 0..1; defaults to 0.5 (post-Phase-1 typical)
 */
export function projectCostUsd(args: {
  promptLen: number;
  historyMessages: number;
  attachmentBytes: number;
  pricing: ModelPricing;
  expectedCacheHitRatio?: number;
}): { low: number; high: number } {
  const ratio = Math.max(0, Math.min(1, args.expectedCacheHitRatio ?? 0.5));
  // Heuristic input estimate: prompt × 2.5 (system prompt + tool schemas
  // + the prompt itself amortized) + history × 500 + attachments × 0.3
  // (image attachments are ~0.3 tokens/byte after vision encoding).
  const baseInput = args.promptLen * 2.5 + args.historyMessages * 500 + args.attachmentBytes * 0.3;
  const expectedInputLow = baseInput;
  const expectedInputHigh = baseInput * 3; // multi-turn tool runs balloon input
  // Output ratio observed: ~5% for design runs, ~2% for bug-fix runs.
  const expectedOutputLow = baseInput * 0.02;
  const expectedOutputHigh = baseInput * 0.08;
  const cachedLow = expectedInputLow * ratio;
  const cachedHigh = expectedInputHigh * ratio;
  const uncachedLow = expectedInputLow - cachedLow;
  const uncachedHigh = expectedInputHigh - cachedHigh;
  const low =
    (uncachedLow * args.pricing.inputPerMtok +
      cachedLow * args.pricing.cacheReadPerMtok +
      expectedOutputLow * args.pricing.outputPerMtok) /
    1_000_000;
  const high =
    (uncachedHigh * args.pricing.inputPerMtok +
      cachedHigh * args.pricing.cacheReadPerMtok +
      expectedOutputHigh * args.pricing.outputPerMtok) /
    1_000_000;
  return { low: Math.max(0, low), high: Math.max(low, high) };
}
