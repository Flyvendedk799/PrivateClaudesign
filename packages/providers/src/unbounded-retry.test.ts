/**
 * Phase 5 — unbounded retry primitives. The Anthropic overload from
 * 2026-05-06 17:25 lasted long enough to defeat the existing 5-attempt
 * fixed budget; the user retried 6 times by hand. These primitives,
 * combined with a cancellable toast in the renderer, ensure the run
 * silently rides out backend degradation up to user-cancellation.
 */

import { describe, expect, it } from 'vitest';
import { bufferedRetryDelay, classifyError, shouldRetryUntilCancelled } from './unbounded-retry';

const seededRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
};

describe('bufferedRetryDelay (Phase 5)', () => {
  it('returns 0 for attempt=0 (the initial try has no wait)', () => {
    expect(bufferedRetryDelay(0)).toBe(0);
  });

  it('exponentially backs off until hitting the cap', () => {
    // Use a fixed midpoint random for stability (jitter = 1.0)
    const r = () => 0.5;
    expect(bufferedRetryDelay(1, { random: r, baseMs: 1000, capMs: 60_000 })).toBe(1000);
    expect(bufferedRetryDelay(2, { random: r, baseMs: 1000, capMs: 60_000 })).toBe(2000);
    expect(bufferedRetryDelay(3, { random: r, baseMs: 1000, capMs: 60_000 })).toBe(4000);
    expect(bufferedRetryDelay(4, { random: r, baseMs: 1000, capMs: 60_000 })).toBe(8000);
  });

  it('caps the delay so we never hammer past the user-cancellable window', () => {
    const r = () => 0.5;
    // Attempt 20 raw is 1024 * baseMs = 1.05M ms; cap at 60s.
    const d = bufferedRetryDelay(20, { random: r, baseMs: 1000, capMs: 60_000 });
    expect(d).toBe(60_000);
  });

  it('jitter spans ±20% of the capped value (deterministic with seed)', () => {
    const r = seededRandom(1);
    const samples = [];
    for (let i = 0; i < 100; i += 1) {
      samples.push(bufferedRetryDelay(5, { random: r, baseMs: 1000, capMs: 60_000 }));
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    // 1000 * 16 = 16000 capped at 60000 → 16000. ±20% → [12800, 19200).
    expect(min).toBeGreaterThanOrEqual(Math.round(16000 * 0.8));
    expect(max).toBeLessThan(Math.round(16000 * 1.2));
  });
});

describe('classifyError (Phase 5)', () => {
  it('overloaded_error → transient_overload', () => {
    expect(classifyError({ status: 529, errorType: 'overloaded_error' })).toBe(
      'transient_overload',
    );
    // Some upstream chains map overload to errorType only.
    expect(classifyError({ errorType: 'overloaded_error' })).toBe('transient_overload');
  });

  it('429 → transient_rate_limit', () => {
    expect(classifyError({ status: 429 })).toBe('transient_rate_limit');
  });

  it('500–599 (excluding overload) → transient_5xx', () => {
    expect(classifyError({ status: 502 })).toBe('transient_5xx');
    expect(classifyError({ status: 503 })).toBe('transient_5xx');
    expect(classifyError({ status: 504 })).toBe('transient_5xx');
  });

  it('network failure → transient_network', () => {
    expect(classifyError({ networkFailure: true })).toBe('transient_network');
  });

  it('401 with "expired" / "refresh" → auth_expired (refresh path, not retry)', () => {
    expect(classifyError({ status: 401, message: 'token expired' })).toBe('auth_expired');
    expect(classifyError({ status: 401, message: 'cannot refresh credentials' })).toBe(
      'auth_expired',
    );
    expect(classifyError({ status: 401, errorType: 'authentication_error' })).toBe('auth_expired');
  });

  it('plain 401 → permanent (no retry)', () => {
    expect(classifyError({ status: 401, message: 'invalid api key' })).toBe('permanent');
  });

  it('403 / 4xx-other → permanent', () => {
    expect(classifyError({ status: 403 })).toBe('permanent');
    expect(classifyError({ status: 400 })).toBe('permanent');
    expect(classifyError({ status: 422 })).toBe('permanent');
  });
});

describe('shouldRetryUntilCancelled (Phase 5)', () => {
  it('every transient class retries forever (cancellable, capped backoff)', () => {
    expect(shouldRetryUntilCancelled('transient_overload')).toBe(true);
    expect(shouldRetryUntilCancelled('transient_rate_limit')).toBe(true);
    expect(shouldRetryUntilCancelled('transient_5xx')).toBe(true);
    expect(shouldRetryUntilCancelled('transient_network')).toBe(true);
  });

  it('permanent never retries', () => {
    expect(shouldRetryUntilCancelled('permanent')).toBe(false);
  });

  it('auth_expired does NOT retry inline — the refresh queue handles it', () => {
    expect(shouldRetryUntilCancelled('auth_expired')).toBe(false);
  });
});
