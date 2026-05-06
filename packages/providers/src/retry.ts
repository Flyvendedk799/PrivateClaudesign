/**
 * completeWithRetry — exponential backoff wrapper around `complete()`.
 *
 * PRINCIPLES §10 (errors loud): every retry attempt is surfaced via the
 * `onRetry` callback so the UI can show a status line. Silent retries are
 * forbidden — the user must see why the call took longer than expected.
 *
 * Retry policy (Tier 1, intentionally conservative):
 *   - max 3 attempts (1 initial + 2 retries by default)
 *   - exponential delay: baseDelayMs * 2^(attempt-1) with ±20% jitter
 *   - retry only on transient classes: 5xx, network/abort-unrelated, 429
 *   - 429 honours Retry-After header (seconds or HTTP-date) when present
 *   - any AbortSignal abort short-circuits immediately, no retry
 */

import {
  type ChatMessage,
  CodesignError,
  ERROR_CODES,
  type ModelRef,
  type WireApi,
} from '@open-codesign/shared';
import { extractHttpStatus, normalizeProviderError } from './errors';
import { looksLikeGatewayMissingMessagesApi } from './gateway-compat';
import { type GenerateOptions, type GenerateResult, complete } from './index';
import {
  bufferedRetryDelay,
  classifyError as classifyErrorPhase5,
  shouldRetryUntilCancelled,
} from './unbounded-retry';

export interface RetryReason {
  attempt: number;
  totalAttempts: number;
  delayMs: number;
  reason: string;
  retryAfterMs?: number;
}

export interface CompleteWithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (info: RetryReason) => void;
  logger?: { warn: (event: string, data?: Record<string, unknown>) => void };
  provider?: string;
  wire?: WireApi;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

/**
 * Status 529 = Anthropic capacity throttling. Overload windows last 5–30s, so
 * the default 3 attempts × 500ms exponential base (≈1.5–3.5s wall-clock) gives
 * up well before the dust settles. Bump to 5 attempts and a 1500ms minimum
 * spacing — total wall-clock ≈ 6–24s, which catches the typical window.
 */
const OVERLOAD_RETRY_BUDGET = 5;
const OVERLOAD_MIN_RETRY_AFTER_MS = 1500;

export interface RetryDecision {
  retry: boolean;
  reason: string;
  retryAfterMs?: number;
  /** Override the caller's `maxRetries` cap for this attempt. Used for
   *  overload-class errors where a longer retry budget is warranted. */
  retryBudget?: number;
}

const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

function classifyByStatus(status: number, err: unknown, wire?: WireApi): RetryDecision | undefined {
  if (status === 429) {
    const retryAfterMs = extractRetryAfterMs(err);
    const decision: RetryDecision = { retry: true, reason: 'rate-limited (429)' };
    if (retryAfterMs !== undefined) decision.retryAfterMs = retryAfterMs;
    return decision;
  }
  if (status >= 500 && status <= 599) {
    // Third-party Anthropic relays (sub2api, claude2api, anyrouter…) often
    // return 5xx + "not implemented" for POST /v1/messages even though their
    // /v1/models endpoint works. Retrying wastes 3 rounds of exponential
    // backoff on an endpoint that will never respond; short-circuit so the
    // user sees the actionable error immediately. Only applies to
    // anthropic-wire endpoints — OpenAI/Google wires can emit the same text
    // for unrelated reasons and should retry normally.
    if (wire === 'anthropic' && looksLikeGatewayMissingMessagesApi(err)) {
      return { retry: false, reason: 'gateway does not implement Messages API' };
    }
    if (status === 529) {
      // Capacity throttling — give it a longer budget and floor the spacing
      // so the 5 attempts span enough wall-clock to outlast a typical
      // overload window. Existing Retry-After header (if any) still wins
      // when it's longer than our floor.
      const headerHint = extractRetryAfterMs(err);
      const retryAfterMs = Math.max(OVERLOAD_MIN_RETRY_AFTER_MS, headerHint ?? 0);
      return {
        retry: true,
        reason: `server error (${status})`,
        retryAfterMs,
        retryBudget: OVERLOAD_RETRY_BUDGET,
      };
    }
    return { retry: true, reason: `server error (${status})` };
  }
  if (status >= 400 && status <= 499) {
    return { retry: false, reason: `client error (${status})` };
  }
  return undefined;
}

function classifyByNetwork(err: unknown): RetryDecision | undefined {
  if (err instanceof TypeError) return { retry: true, reason: 'network error' };
  if (!(err instanceof Error)) return undefined;
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code === 'string' && RETRYABLE_NET_CODES.has(code)) {
    return { retry: true, reason: `network error (${code})` };
  }
  return undefined;
}

export function classifyError(err: unknown, wire?: WireApi): RetryDecision {
  if (err instanceof Error && (err.name === 'AbortError' || err.message === 'aborted')) {
    return { retry: false, reason: 'aborted' };
  }
  const status = extractStatus(err);
  if (status !== undefined) {
    const byStatus = classifyByStatus(status, err, wire);
    if (byStatus) return byStatus;
  }
  const byNet = classifyByNetwork(err);
  if (byNet) return byNet;
  return { retry: false, reason: errorMessage(err) };
}

// Local alias kept so this file's call sites (`extractStatus(err)`) stay
// readable — the canonical implementation lives in errors.ts and is shared
// with normalizeProviderError + remapProviderError.
const extractStatus = extractHttpStatus;

function extractRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const headers =
    (err as { headers?: Record<string, string | string[] | undefined> }).headers ??
    (err as { response?: { headers?: Record<string, string | string[] | undefined> } }).response
      ?.headers;
  const direct = (err as { retryAfter?: unknown }).retryAfter;
  const raw =
    pickHeader(headers, 'retry-after') ??
    (typeof direct === 'string' || typeof direct === 'number' ? String(direct) : undefined);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // Empty / whitespace-only headers must not coerce to 0 via Number(''),
  // which would otherwise emit a zero-delay retry hint and defeat backoff.
  if (trimmed.length === 0) return undefined;
  // Numeric path first — explicit shape so '7' / '1.5' parse but a
  // Date-formatted header ('Wed, 21 Oct 2015 …') falls through to Date.parse.
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function pickHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) {
      if (Array.isArray(v)) return v[0];
      if (typeof v === 'string') return v;
    }
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function computeDelay(attempt: number, baseDelayMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  const base = baseDelayMs * 2 ** exponent;
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(base + jitter));
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type CompleteFn = (
  model: ModelRef,
  messages: ChatMessage[],
  opts: GenerateOptions,
) => Promise<GenerateResult>;

function buildRetryInfo(
  attempt: number,
  totalAttempts: number,
  decision: RetryDecision,
  baseDelayMs: number,
): RetryReason {
  const backoff = computeDelay(attempt, baseDelayMs);
  const delayMs =
    decision.retryAfterMs !== undefined ? Math.max(decision.retryAfterMs, backoff) : backoff;
  const info: RetryReason = { attempt, totalAttempts, delayMs, reason: decision.reason };
  if (decision.retryAfterMs !== undefined) info.retryAfterMs = decision.retryAfterMs;
  return info;
}

function shouldStop(decision: RetryDecision, attempt: number, maxRetries: number): boolean {
  // A per-decision retryBudget overrides the caller's cap so transient classes
  // with predictable recovery windows (529 overload) can ride a longer queue
  // without forcing every other call to take the same hit.
  const cap = Math.max(maxRetries, decision.retryBudget ?? 0);
  return !decision.retry || attempt >= cap;
}

export interface BackoffOptions {
  /** Total attempts (initial + retries). Default 3. */
  maxRetries?: number;
  /** Exponential-backoff base, ms. Default 500. */
  baseDelayMs?: number;
  /** Decide whether a given error is transient. Defaults to {@link classifyError}. */
  classify?: (err: unknown) => RetryDecision;
  /** Invoked immediately before each retry sleep. */
  onRetry?: (info: RetryReason) => void;
  /** Phase 5 / Integration D — unbounded retry mode. When true, transient
   *  classes (overload / rate-limit / 5xx / network) retry forever with
   *  capped exponential backoff (max 60 s between attempts) until the
   *  AbortSignal fires. The 10-attempt hard ceiling becomes 1000; the
   *  user is responsible for cancellation via the existing Stop button.
   *  Permanent errors (4xx other than 429, classifier rejected) bail
   *  immediately as before.
   *
   *  This implements the Phase 7 ambition guardrail #4 ("Never use a
   *  fixed retry budget against transient backend failure"). */
  unbounded?: boolean;
  /** Cap on the buffered retry delay between unbounded attempts. */
  unboundedCapMs?: number;
  /** Abort short-circuits both the in-flight call and the inter-retry sleep. */
  signal?: AbortSignal;
}

/**
 * Process-wide one-shot guard for the synthetic-overload dev knob. Cleared
 * once the synthetic error has been thrown so subsequent generations behave
 * normally — set the env var, restart the app, run one generation to verify
 * the retry path works end-to-end, then continue working.
 */
let syntheticOverloadArmed: boolean | undefined;

function shouldFireSyntheticOverload(): boolean {
  if (syntheticOverloadArmed === undefined) {
    syntheticOverloadArmed =
      typeof process !== 'undefined' &&
      process.env?.['OPEN_CODESIGN_DEV_FORCE_OVERLOAD_ONCE'] === '1';
  }
  if (!syntheticOverloadArmed) return false;
  syntheticOverloadArmed = false;
  return true;
}

/**
 * Test-only reset hook for the one-shot synthetic-overload guard. Production
 * callers don't need this — the env-var read latches once per process.
 */
export function resetSyntheticOverloadForTests(): void {
  syntheticOverloadArmed = undefined;
}

/**
 * Generic retry wrapper. `completeWithRetry` is a thin wrapper around this that
 * adds provider-error normalization + structured logging. Call this directly
 * when you need first-turn retry semantics around an arbitrary transient-prone
 * async op (e.g. `agent.prompt()` in the pi-agent-core path).
 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const classify = opts.classify ?? classifyError;
  const signal = opts.signal;
  const unbounded = opts.unbounded === true;
  const unboundedCapMs = opts.unboundedCapMs ?? 60_000;

  let lastError: unknown;
  // Bounded mode: hard ceiling 10 so a malicious/buggy classify cannot
  // return an unbounded retryBudget and pin the loop forever.
  // Unbounded mode (Phase 5 / Integration D): ceiling 1000, but
  // permanent errors bail immediately and AbortSignal short-circuits the
  // sleep — so in practice the loop only burns attempts on transient
  // classes the upstream is actively healing from.
  const ABSOLUTE_CEILING = unbounded ? 1000 : 10;
  for (let attempt = 1; attempt <= ABSOLUTE_CEILING; attempt++) {
    if (signal?.aborted) {
      throw new CodesignError('Generation aborted by user', ERROR_CODES.PROVIDER_ABORTED);
    }
    try {
      // Dev-only: force a synthetic overloaded_error on the very first attempt
      // so the retry path can be verified end-to-end without waiting for
      // Anthropic to actually be overloaded. Gated behind an env var, fires
      // once per process, then disarms. The body uses Anthropic's wire shape
      // so the same parseUpstreamErrorMessage → 529 → retry classification
      // chain is exercised.
      if (attempt === 1 && shouldFireSyntheticOverload()) {
        throw new CodesignError(
          '{"type":"error","error":{"type":"overloaded_error","message":"Synthetic overload (dev knob)"},"request_id":"req_synthetic_dev"}',
          ERROR_CODES.PROVIDER_ERROR,
        );
      }
      return await fn();
    } catch (err) {
      lastError = err;
      const decision = classify(err);
      if (decision.reason === 'aborted') {
        throw new CodesignError('Generation aborted by user', ERROR_CODES.PROVIDER_ABORTED, {
          cause: err,
        });
      }
      // Unbounded path: defer the stop decision to Phase 5 primitives.
      // Permanent errors still bail; transient classes keep retrying
      // with capped exponential backoff.
      if (unbounded) {
        if (!decision.retry) throw err;
        const status = extractStatus(err);
        const errorType = err instanceof Error ? extractAnthropicErrorType(err.message) : undefined;
        const messageStr = err instanceof Error ? err.message : '';
        const cls = classifyErrorPhase5({
          ...(typeof status === 'number' ? { status } : {}),
          ...(errorType !== undefined ? { errorType } : {}),
          message: messageStr,
        });
        if (!shouldRetryUntilCancelled(cls)) {
          // Phase 5 classifier disagrees — treat as permanent. (Auth-
          // expired falls through here too; the refresh queue handles
          // that path separately.)
          throw err;
        }
        const baseRaw =
          decision.retryAfterMs ??
          bufferedRetryDelay(attempt, {
            baseMs: baseDelayMs,
            capMs: unboundedCapMs,
          });
        const info: RetryReason = {
          attempt,
          totalAttempts: ABSOLUTE_CEILING,
          delayMs: baseRaw,
          reason: decision.reason,
        };
        if (decision.retryAfterMs !== undefined) info.retryAfterMs = decision.retryAfterMs;
        opts.onRetry?.(info);
        await sleepWithAbort(info.delayMs, signal);
        continue;
      }
      // Bounded path (legacy + tests).
      if (shouldStop(decision, attempt, maxRetries)) {
        throw err;
      }
      const cap = Math.max(maxRetries, decision.retryBudget ?? 0);
      const info = buildRetryInfo(attempt, cap, decision, baseDelayMs);
      opts.onRetry?.(info);
      await sleepWithAbort(info.delayMs, signal);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new CodesignError('withBackoff exhausted', ERROR_CODES.PROVIDER_RETRY_EXHAUSTED);
}

/** Sniff the Anthropic error-type tag from a JSON-shaped error message
 *  string. Used by the unbounded retry classifier to recognise
 *  `overloaded_error` even when the upstream returned a 200 with body
 *  carrying a JSON error envelope (some gateways do this). */
function extractAnthropicErrorType(message: string): string | undefined {
  const m = message.match(
    /"type"\s*:\s*"(error)"\s*,\s*"error"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/,
  );
  return m?.[2];
}

export async function completeWithRetry(
  model: ModelRef,
  messages: ChatMessage[],
  opts: GenerateOptions,
  retryOpts: CompleteWithRetryOptions = {},
  // Injected for tests; defaults to the real `complete`.
  _impl: CompleteFn = complete,
): Promise<GenerateResult> {
  const maxRetries = retryOpts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = retryOpts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const onRetry = retryOpts.onRetry;
  const logger = retryOpts.logger;
  const provider = retryOpts.provider ?? 'unknown';

  // Thin wrapper around withBackoff: folds provider-error normalization into
  // the classify/onRetry hooks so each attempt emits structured provider.error
  // logs and exhaustion surfaces provider.error.final.
  let attemptForLog = 0;
  const backoffOpts: BackoffOptions = {
    maxRetries,
    baseDelayMs,
    classify: (err) => {
      const decision = classifyError(err, retryOpts.wire);
      const retryCount = Math.max(0, attemptForLog - 1);
      const normalized = normalizeProviderError(err, provider, retryCount);
      if (shouldStop(decision, attemptForLog, maxRetries)) {
        logger?.warn('provider.error.final', normalized as unknown as Record<string, unknown>);
      } else {
        logger?.warn('provider.error', normalized as unknown as Record<string, unknown>);
      }
      return decision;
    },
    onRetry: (info) => {
      onRetry?.(info);
    },
  };
  if (opts.signal) backoffOpts.signal = opts.signal;
  return withBackoff(() => {
    attemptForLog += 1;
    return _impl(model, messages, opts);
  }, backoffOpts);
}
