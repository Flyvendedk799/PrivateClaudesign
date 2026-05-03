import { type ChatMessage, CodesignError, type ModelRef } from '@open-codesign/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, GenerateResult } from './index';
import {
  type RetryReason,
  classifyError,
  completeWithRetry,
  resetSyntheticOverloadForTests,
  withBackoff,
} from './retry';

const MODEL: ModelRef = { provider: 'anthropic', modelId: 'claude-sonnet-4-6' };
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const OPTS: GenerateOptions = { apiKey: 'test-key' };

const ok: GenerateResult = {
  content: 'hello',
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
};

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

describe('classifyError', () => {
  it('marks 5xx as retryable', () => {
    expect(classifyError(new HttpError('boom', 503))).toMatchObject({ retry: true });
  });
  it('does not retry 5xx when body says Messages API is not implemented on anthropic wire', () => {
    const d = classifyError(new HttpError('500 not implemented', 500), 'anthropic');
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/gateway does not implement Messages API/);
  });
  it('still retries 5xx "not implemented" on openai-chat wire (not a gateway-compat issue)', () => {
    const d = classifyError(new HttpError('500 not implemented', 500), 'openai-chat');
    expect(d.retry).toBe(true);
    expect(d.reason).toMatch(/server error/);
  });
  it('still retries 5xx "not implemented" when wire is unknown (safer default)', () => {
    const d = classifyError(new HttpError('500 not implemented', 500));
    expect(d.retry).toBe(true);
  });
  it('marks 4xx (non-429) as non-retryable', () => {
    expect(classifyError(new HttpError('bad', 400))).toMatchObject({ retry: false });
  });
  it('marks 429 as retryable and parses retry-after seconds', () => {
    const d = classifyError(new HttpError('slow', 429, { 'retry-after': '7' }));
    expect(d.retry).toBe(true);
    expect(d.retryAfterMs).toBe(7000);
  });
  it('treats empty retry-after as no hint (not 0ms)', () => {
    const d = classifyError(new HttpError('slow', 429, { 'retry-after': '' }));
    expect(d.retry).toBe(true);
    expect(d.retryAfterMs).toBeUndefined();
  });
  it('treats whitespace-only retry-after as no hint', () => {
    const d = classifyError(new HttpError('slow', 429, { 'retry-after': '   ' }));
    expect(d.retry).toBe(true);
    expect(d.retryAfterMs).toBeUndefined();
  });
  it('parses HTTP-date retry-after to a delay relative to now', () => {
    const future = new Date(Date.now() + 2_000).toUTCString();
    const d = classifyError(new HttpError('slow', 429, { 'retry-after': future }));
    expect(d.retry).toBe(true);
    expect(d.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(d.retryAfterMs).toBeLessThanOrEqual(2_500);
  });
  it('marks AbortError as not retryable', () => {
    const err = new DOMException('Aborted', 'AbortError');
    expect(classifyError(err)).toMatchObject({ retry: false, reason: 'aborted' });
  });
  it('marks TypeError (fetch failure) as retryable', () => {
    expect(classifyError(new TypeError('fetch failed'))).toMatchObject({ retry: true });
  });

  it('retries CodesignError carrying an Anthropic overloaded_error JSON body', () => {
    // pi-ai surfaces upstream stream errors as a CodesignError whose message
    // is the raw Anthropic JSON body — no `status` property. The classifier
    // recovers status from `error.type` so 529 retries instead of failing
    // fast on the first attempt.
    const body =
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_xyz"}';
    const err = new CodesignError(body, 'PROVIDER_ERROR');
    const decision = classifyError(err);
    expect(decision.retry).toBe(true);
    expect(decision.reason).toMatch(/server error \(529\)/);
  });

  it('retries CodesignError carrying an Anthropic rate_limit_error JSON body', () => {
    const body = '{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}';
    const err = new CodesignError(body, 'PROVIDER_ERROR');
    const decision = classifyError(err);
    expect(decision.retry).toBe(true);
    expect(decision.reason).toMatch(/rate-limited \(429\)/);
  });

  it('does not retry CodesignError carrying an authentication_error JSON body', () => {
    const body = '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}';
    const err = new CodesignError(body, 'PROVIDER_ERROR');
    expect(classifyError(err).retry).toBe(false);
  });

  it('returns a 5-attempt retryBudget and a 1500ms floor for 529', () => {
    const decision = classifyError(new HttpError('overloaded', 529));
    expect(decision.retry).toBe(true);
    expect(decision.retryBudget).toBe(5);
    expect(decision.retryAfterMs).toBe(1500);
  });

  it('does not bump the retryBudget for non-529 5xx', () => {
    const decision = classifyError(new HttpError('boom', 503));
    expect(decision.retry).toBe(true);
    expect(decision.retryBudget).toBeUndefined();
  });
});

describe('completeWithRetry', () => {
  it('returns the result on first-try success', async () => {
    const impl = vi.fn().mockResolvedValueOnce(ok);
    const out = await completeWithRetry(MODEL, MESSAGES, OPTS, {}, impl);
    expect(out).toEqual(ok);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 then succeeds, surfacing each attempt via onRetry', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('boom', 503))
      .mockResolvedValueOnce(ok);
    const onRetry = vi.fn<(info: RetryReason) => void>();
    const out = await completeWithRetry(MODEL, MESSAGES, OPTS, { baseDelayMs: 1, onRetry }, impl);
    expect(out).toEqual(ok);
    expect(impl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0].reason).toMatch(/server error/);
  });

  it('throws after exhausting retries', async () => {
    const impl = vi.fn().mockRejectedValue(new HttpError('still down', 500));
    await expect(
      completeWithRetry(MODEL, MESSAGES, OPTS, { baseDelayMs: 1, maxRetries: 3 }, impl),
    ).rejects.toThrow(/still down/);
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('does not retry on a 401 client error', async () => {
    const impl = vi.fn().mockRejectedValue(new HttpError('unauthorized', 401));
    await expect(
      completeWithRetry(MODEL, MESSAGES, OPTS, { baseDelayMs: 1 }, impl),
    ).rejects.toThrow(/unauthorized/);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on 429 (delay is at least retryAfterMs)', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('slow', 429, { 'retry-after': '0.05' }))
      .mockResolvedValueOnce(ok);
    const onRetry = vi.fn<(info: RetryReason) => void>();
    const out = await completeWithRetry(MODEL, MESSAGES, OPTS, { baseDelayMs: 1, onRetry }, impl);
    expect(out).toEqual(ok);
    const info = onRetry.mock.calls[0]?.[0];
    expect(info?.retryAfterMs).toBe(50);
    expect(info?.delayMs).toBeGreaterThanOrEqual(50);
  });

  it('aborts immediately when signal is already aborted', async () => {
    const impl = vi.fn().mockResolvedValue(ok);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      completeWithRetry(MODEL, MESSAGES, { ...OPTS, signal: ctrl.signal }, {}, impl),
    ).rejects.toBeInstanceOf(CodesignError);
    expect(impl).not.toHaveBeenCalled();
  });

  it('aborts mid-backoff when signal fires during retry sleep', async () => {
    const impl = vi.fn().mockRejectedValue(new HttpError('boom', 503));
    const ctrl = new AbortController();
    const promise = completeWithRetry(
      MODEL,
      MESSAGES,
      { ...OPTS, signal: ctrl.signal },
      { baseDelayMs: 5_000, maxRetries: 5 },
      impl,
    );
    setTimeout(() => ctrl.abort(), 10);
    await expect(promise).rejects.toThrow();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('emits provider.error on each retried attempt with incrementing retry_count', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('boom', 500))
      .mockRejectedValueOnce(new HttpError('boom', 500))
      .mockResolvedValueOnce(ok);
    const logger = { warn: vi.fn() };
    await completeWithRetry(
      MODEL,
      MESSAGES,
      OPTS,
      { baseDelayMs: 1, maxRetries: 5, logger, provider: 'anthropic' },
      impl,
    );
    const retryCalls = logger.warn.mock.calls.filter((c) => c[0] === 'provider.error');
    expect(retryCalls.length).toBe(2);
    expect(retryCalls[0]?.[1]).toMatchObject({ upstream_status: 500, retry_count: 0 });
    expect(retryCalls[1]?.[1]).toMatchObject({ upstream_status: 500, retry_count: 1 });
  });

  it('emits provider.error.final on retry exhaustion', async () => {
    const impl = vi.fn().mockRejectedValue(new HttpError('still down', 500));
    const logger = { warn: vi.fn() };
    await expect(
      completeWithRetry(MODEL, MESSAGES, OPTS, { baseDelayMs: 1, maxRetries: 3, logger }, impl),
    ).rejects.toThrow(/still down/);
    const lastCall = logger.warn.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('provider.error.final');
    expect(lastCall?.[1]).toMatchObject({ upstream_status: 500, retry_count: 2 });
  });

  it('works without a logger (logger is optional)', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('boom', 503))
      .mockResolvedValueOnce(ok);
    const out = await completeWithRetry(MODEL, MESSAGES, OPTS, { baseDelayMs: 1 }, impl);
    expect(out).toEqual(ok);
  });

  it('passes provider name through to the normalized payload', async () => {
    const impl = vi.fn().mockRejectedValue(new HttpError('bad', 401));
    const logger = { warn: vi.fn() };
    await expect(
      completeWithRetry(
        MODEL,
        MESSAGES,
        OPTS,
        { baseDelayMs: 1, logger, provider: 'anthropic' },
        impl,
      ),
    ).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'provider.error.final',
      expect.objectContaining({ upstream_provider: 'anthropic' }),
    );
  });

  it('captures upstream_request_id from response headers', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('throttled', 429, { 'x-request-id': 'req_test' }))
      .mockResolvedValueOnce(ok);
    const logger = { warn: vi.fn() };
    await completeWithRetry(
      MODEL,
      MESSAGES,
      OPTS,
      { baseDelayMs: 1, logger, provider: 'openai' },
      impl,
    );
    const firstCall = logger.warn.mock.calls.find((c) => c[0] === 'provider.error');
    expect(firstCall?.[1]).toMatchObject({ upstream_request_id: 'req_test' });
  });
});

describe('withBackoff', () => {
  it('returns the result on first-try success without invoking onRetry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValueOnce('ok');
    const out = await withBackoff(fn, { baseDelayMs: 1, onRetry });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries on 503 then succeeds and surfaces each attempt via onRetry', async () => {
    const onRetry = vi.fn<(info: RetryReason) => void>();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('boom', 503))
      .mockResolvedValueOnce('ok');
    const out = await withBackoff(fn, { baseDelayMs: 1, onRetry });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0].reason).toMatch(/server error/);
  });

  it('retries on 429 and honours Retry-After (delay is at least retryAfterMs)', async () => {
    const onRetry = vi.fn<(info: RetryReason) => void>();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError('slow', 429, { 'retry-after': '0.05' }))
      .mockResolvedValueOnce('ok');
    await withBackoff(fn, { baseDelayMs: 1, onRetry });
    const info = onRetry.mock.calls[0]?.[0];
    expect(info?.retryAfterMs).toBe(50);
    expect(info?.delayMs).toBeGreaterThanOrEqual(50);
  });

  it('does not retry on a 4xx client error', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('unauthorized', 401));
    await expect(withBackoff(fn, { baseDelayMs: 1 })).rejects.toThrow(/unauthorized/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts maxRetries and rethrows the last error', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new HttpError('still down', 500));
    await expect(withBackoff(fn, { baseDelayMs: 1, maxRetries: 3, onRetry })).rejects.toThrow(
      /still down/,
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('extends retries to 5 for 529 even when caller passes maxRetries: 3', async () => {
    // 529 = capacity throttling. The classifier returns retryBudget: 5,
    // overriding the caller's smaller cap so overload windows that outlast
    // the default budget still resolve cleanly. Uses fake timers because the
    // 529 floor adds a 1500ms minimum between attempts.
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new HttpError('overloaded', 529))
        .mockRejectedValueOnce(new HttpError('overloaded', 529))
        .mockRejectedValueOnce(new HttpError('overloaded', 529))
        .mockRejectedValueOnce(new HttpError('overloaded', 529))
        .mockResolvedValueOnce('ok');
      const promise = withBackoff(fn, { baseDelayMs: 1, maxRetries: 3 });
      await vi.runAllTimersAsync();
      expect(await promise).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts immediately when signal is already aborted', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(withBackoff(fn, { signal: ctrl.signal })).rejects.toBeInstanceOf(CodesignError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts mid-backoff when signal fires during retry sleep', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError('boom', 503));
    const ctrl = new AbortController();
    const promise = withBackoff(fn, {
      baseDelayMs: 5_000,
      maxRetries: 5,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 10);
    await expect(promise).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses a custom classify override when provided', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('weird'));
    const classify = vi.fn(() => ({ retry: false as const, reason: 'never-retry' }));
    await expect(withBackoff(fn, { baseDelayMs: 1, classify })).rejects.toThrow(/weird/);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('OPEN_CODESIGN_DEV_FORCE_OVERLOAD_ONCE dev knob', () => {
  afterEach(() => {
    // The production check uses `process.env['…'] === '1'`, so assigning
    // `undefined` does NOT restore the "not set" state (it leaves the key
    // present with the literal string 'undefined'). Use `delete` here.
    // biome-ignore lint/performance/noDelete: see comment above
    delete process.env['OPEN_CODESIGN_DEV_FORCE_OVERLOAD_ONCE'];
    resetSyntheticOverloadForTests();
  });

  it('throws a synthetic overloaded_error on the first attempt and lets the second succeed', async () => {
    process.env['OPEN_CODESIGN_DEV_FORCE_OVERLOAD_ONCE'] = '1';
    resetSyntheticOverloadForTests();

    const fn = vi.fn().mockResolvedValue('ok');
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn<(info: RetryReason) => void>();
      const promise = withBackoff(fn, { baseDelayMs: 1, onRetry });
      await vi.runAllTimersAsync();
      expect(await promise).toBe('ok');
      // First attempt is the synthetic — fn never runs. Second attempt is the
      // real call which resolves successfully.
      expect(fn).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
      // Verify the synthetic actually exercised the 529 retry path, not some
      // generic transient class.
      expect(onRetry.mock.calls[0]?.[0].reason).toMatch(/server error \(529\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms after firing once: a second withBackoff call runs fn immediately', async () => {
    process.env['OPEN_CODESIGN_DEV_FORCE_OVERLOAD_ONCE'] = '1';
    resetSyntheticOverloadForTests();

    vi.useFakeTimers();
    try {
      const firstFn = vi.fn().mockResolvedValue('first');
      const firstPromise = withBackoff(firstFn, { baseDelayMs: 1 });
      await vi.runAllTimersAsync();
      await firstPromise;
      expect(firstFn).toHaveBeenCalledTimes(1);

      // Second call: synthetic already consumed, fn runs on attempt 1.
      const secondFn = vi.fn().mockResolvedValue('second');
      const secondPromise = withBackoff(secondFn, { baseDelayMs: 1 });
      await vi.runAllTimersAsync();
      expect(await secondPromise).toBe('second');
      expect(secondFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op when the env var is not set', async () => {
    resetSyntheticOverloadForTests();

    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withBackoff(fn, { baseDelayMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
