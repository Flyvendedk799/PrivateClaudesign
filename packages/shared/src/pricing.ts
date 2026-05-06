/**
 * Phase 3 — Anthropic pricing table for the implied-cost metric.
 *
 * Why this exists: when a user imports their Claude Code subscription
 * (provider == 'claude-code-imported'), the marginal *cash* cost of a
 * run is $0 — but the budget UI needs to show a meaningful number so
 * users can compare run cost across providers and stay calibrated.
 * The implied cost is what an API user would have paid at standard
 * Anthropic prices for the same token counts.
 *
 * Per the Phase 7 ambition guardrails: we never relabel `cost_usd` to
 * make a UI work. Subscription users see two numbers — actual ($0) and
 * implied (this calculation), each labelled clearly.
 *
 * Prices are USD per million tokens. Source: anthropic.com/pricing as
 * of 2026-05. The default for unrecognised models conservatively maps
 * to Sonnet-4-6 (mid-tier). Update the table when new families ship.
 */

export interface ModelPricingEntry {
  /** USD per 1M tokens for fresh (uncached) input. */
  inputPerMillion: number;
  /** USD per 1M tokens for cached input (cache hits). */
  cachedInputPerMillion: number;
  /** USD per 1M tokens for cache creation (the surcharge for the first
   *  time a context block is cached). */
  cacheCreationPerMillion: number;
  /** USD per 1M tokens for assistant output. */
  outputPerMillion: number;
}

function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'object' && v !== null) deepFreeze(v as Record<string, unknown>);
  }
  return Object.freeze(obj);
}

/** Pricing keyed by `modelId` (the canonical id used everywhere in
 *  this codebase: 'claude-sonnet-4-6', 'claude-opus-4-7', etc.).
 *  Deep-frozen so accidental mutation of nested entries throws. */
export const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricingEntry>> = deepFreeze({
  // Sonnet family
  'claude-sonnet-4-6': {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
    outputPerMillion: 15.0,
  },
  'claude-sonnet-4-5': {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
    outputPerMillion: 15.0,
  },
  // Opus family — top-tier reasoning, ~5× Sonnet pricing.
  'claude-opus-4-7': {
    inputPerMillion: 15.0,
    cachedInputPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
    outputPerMillion: 75.0,
  },
  'claude-opus-4-6': {
    inputPerMillion: 15.0,
    cachedInputPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
    outputPerMillion: 75.0,
  },
  // Haiku family — fast & cheap.
  'claude-haiku-4-5': {
    inputPerMillion: 0.8,
    cachedInputPerMillion: 0.08,
    cacheCreationPerMillion: 1.0,
    outputPerMillion: 4.0,
  },
});

/** Token-usage shape consumed by `computeImpliedCost`. Matches the columns
 *  on `run_usage` so callers can pass the row directly. */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Phase 4 / Integration G — context-window sizes per model id, in
 *  tokens. The continuation threshold check (`shouldPauseForContinuation`'s
 *  `context_threshold` rule) divides estimated cumulative input tokens
 *  by this window to compute `contextUsedPct`. Conservative default
 *  (200k = Sonnet) for unknown models so a missing pricing entry never
 *  silently disables the threshold. */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  // Sonnet — 200k standard, 1M with the 1M-context beta
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-6[1m]': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  // Opus — 200k standard, 1M with the 1M-context beta
  'claude-opus-4-7': 200_000,
  'claude-opus-4-7[1m]': 1_000_000,
  'claude-opus-4-6': 200_000,
  // Haiku — 200k
  'claude-haiku-4-5': 200_000,
});

/** Lookup the context window for a model id. Falls back to 200k —
 *  the Sonnet/Opus/Haiku default — for unknown models so the
 *  threshold check stays meaningful even on custom models we
 *  haven't catalogued. */
export function contextWindowFor(modelId: string | null | undefined): number {
  const id = modelId ?? '';
  return MODEL_CONTEXT_WINDOWS[id] ?? 200_000;
}

/** Cumulative byte counters the runtime accumulates per-generation
 *  to feed the context-used estimator. Each field grows monotonically
 *  during a run; the estimator divides by 4 to convert bytes → tokens
 *  (the standard ballpark). Tracked separately so a single field's
 *  growth is debuggable in isolation. */
export interface CumulativeContextBytes {
  /** Initial system prompt + user prompt + replayed history at run
   *  start. Snapshot ONCE at chunk_start. */
  initialPromptBytes: number;
  /** Sum of assistant-text streamed via text_delta events. Becomes
   *  next-turn input when pi-agent-core builds the next request. */
  outputBytes: number;
  /** Sum of tool_execution_end result bytes. Tool results land in the
   *  conversation history and become next-turn input. */
  toolResultBytes: number;
}

/** Estimate `contextUsedPct` (0–1) from cumulative byte counts and
 *  a model id. The estimator approximates pi-agent-core's
 *  re-replay-on-every-turn behaviour: at turn N the input ≈
 *  initial + every prior assistant turn + every prior tool result.
 *  All of those have linear running sums.
 *
 *  Bytes-to-tokens uses the standard 4 chars/token ballpark. Returns
 *  a value clamped to [0, 1.5] so a runaway estimate never reads as
 *  negative or absurd; the caller treats > 0.8 as "pause".
 *  Pure function — safe to memoise / test. */
export function estimateContextUsedPct(
  bytes: CumulativeContextBytes,
  modelId: string | null | undefined,
): number {
  const window = contextWindowFor(modelId);
  if (window <= 0) return 0;
  const totalBytes =
    Math.max(0, bytes.initialPromptBytes) +
    Math.max(0, bytes.outputBytes) +
    Math.max(0, bytes.toolResultBytes);
  const tokens = Math.ceil(totalBytes / 4);
  const pct = tokens / window;
  if (!Number.isFinite(pct) || pct < 0) return 0;
  return Math.min(pct, 1.5);
}

/** Compute implied USD cost from token counts and a model id. Falls back
 *  to Sonnet-4-6 pricing for unrecognised models — that's the median tier
 *  and produces a sane "ballpark" rather than $0 (silent zero would
 *  mislead the budget UI). Pure function — safe to memoise / test.
 *
 *  Cached-input tokens are billed at the cached rate, not the full rate.
 *  Cache-creation tokens are billed at the cache-creation rate (which is
 *  higher than fresh input for some providers). The remaining
 *  `inputTokens - cachedInputTokens - cacheCreationInputTokens` is fresh
 *  input billed at the standard rate. */
export function computeImpliedCost(usage: UsageTokens, modelId: string | null | undefined): number {
  const id = modelId ?? '';
  const entry = ANTHROPIC_PRICING[id] ?? ANTHROPIC_PRICING['claude-sonnet-4-6'];
  if (!entry) return 0;
  const cached = Math.max(0, usage.cachedInputTokens);
  const created = Math.max(0, usage.cacheCreationInputTokens);
  const totalIn = Math.max(0, usage.inputTokens);
  const fresh = Math.max(0, totalIn - cached - created);
  const out = Math.max(0, usage.outputTokens);
  const M = 1_000_000;
  return (
    (fresh * entry.inputPerMillion) / M +
    (cached * entry.cachedInputPerMillion) / M +
    (created * entry.cacheCreationPerMillion) / M +
    (out * entry.outputPerMillion) / M
  );
}
