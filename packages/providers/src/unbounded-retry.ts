/**
 * Phase 5 — unbounded-with-cap retry primitives. Anthropic overloads can
 * last 20+ minutes; the existing 5-attempt retry budget runs out long
 * before the backend recovers, leaving the user to retry by hand. The
 * Phase 7 ambition guardrails forbid fixed retry budgets for transient
 * backend failures: retry until the backend recovers OR the user cancels.
 *
 * This module exposes the *primitives* — pure functions for delay
 * scheduling and retry classification — so the retry path can be tested
 * deterministically. The runtime composes these inside the existing
 * provider abstraction.
 */

/** Capped exponential backoff with deterministic jitter. Returns ms to
 *  wait before attempt `n` (n=0 is the initial attempt and returns 0).
 *
 *  - baseMs: initial step (default 2000)
 *  - capMs : never wait longer than this between attempts (default 60000)
 *
 *  Jitter is ±20% drawn from a deterministic stream so tests are
 *  reproducible. The `random` parameter accepts a [0,1) generator —
 *  Math.random in production, a seeded RNG in tests. */
export function bufferedRetryDelay(
  attempt: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  if (attempt <= 0) return 0;
  const baseMs = options.baseMs ?? 2_000;
  const capMs = options.capMs ?? 60_000;
  const random = options.random ?? Math.random;
  // Exponential: base * 2^(n-1), capped.
  const raw = baseMs * 2 ** (attempt - 1);
  const capped = Math.min(raw, capMs);
  // Jitter ±20% — multiply by [0.8, 1.2).
  const jitter = 0.8 + random() * 0.4;
  return Math.round(capped * jitter);
}

/** Classify an error for unbounded retry. Transient classes retry
 *  forever (paired with capped backoff so we never hammer); permanent
 *  classes (4xx auth, malformed request) bail immediately. */
export type RetryClass =
  | 'transient_overload' // 529 overloaded_error, 503 service_unavailable
  | 'transient_rate_limit' // 429 rate_limit_error
  | 'transient_5xx' // any non-overload 5xx
  | 'transient_network' // ECONNRESET, ETIMEDOUT, fetch network errors
  | 'auth_expired' // 401 + indicators of OAuth expiry → token refresh path
  | 'permanent'; // 4xx (auth-permanent, validation), unknown

export interface ClassifyInput {
  status?: number;
  errorType?: string;
  message?: string;
  /** True when the error is a network-layer abort that wasn't caused by
   *  the user's AbortSignal. */
  networkFailure?: boolean;
}

export function classifyError(input: ClassifyInput): RetryClass {
  const { status, errorType, message, networkFailure } = input;
  const msg = (message ?? '').toLowerCase();
  // Token expiry — a 401 with a credential-store hint or the Anthropic
  // "Claude Code token has expired" pattern.
  if (
    status === 401 &&
    (msg.includes('expired') || msg.includes('refresh') || errorType === 'authentication_error')
  ) {
    return 'auth_expired';
  }
  if (status === 401) return 'permanent';
  if (status === 403) return 'permanent';
  if (status === 429) return 'transient_rate_limit';
  if (status === 529 || errorType === 'overloaded_error') return 'transient_overload';
  if (status !== undefined && status >= 500 && status < 600) return 'transient_5xx';
  if (networkFailure === true) return 'transient_network';
  // 4xx other than 401/403/429 → bad request shape, no retry.
  if (status !== undefined && status >= 400 && status < 500) return 'permanent';
  return 'permanent';
}

/** Decide whether to retry given the classification. Transient classes
 *  retry until cancelled (no fixed cap); permanent and auth_expired
 *  (which has its own refresh path) bail. */
export function shouldRetryUntilCancelled(cls: RetryClass): boolean {
  return (
    cls === 'transient_overload' ||
    cls === 'transient_rate_limit' ||
    cls === 'transient_5xx' ||
    cls === 'transient_network'
  );
}
