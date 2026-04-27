import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetInFlightForTests,
  parseRefreshResponse,
  refreshClaudeCodeToken,
  shouldRefresh,
} from './oauth-refresh';

const ENDPOINT = 'https://example.test/oauth/token';

describe('shouldRefresh', () => {
  it('returns false when there is no expiresAt', () => {
    expect(shouldRefresh(undefined)).toBe(false);
  });

  it('returns true when expiry is past', () => {
    expect(shouldRefresh(Date.now() - 1)).toBe(true);
  });

  it('returns true when within the 60s skew window', () => {
    expect(shouldRefresh(Date.now() + 1_000)).toBe(true);
  });

  it('returns false when comfortably in the future', () => {
    expect(shouldRefresh(Date.now() + 5 * 60 * 1000)).toBe(false);
  });
});

describe('parseRefreshResponse', () => {
  it('extracts access_token, expires_in (with safety skew), refresh_token', () => {
    const before = Date.now();
    const out = parseRefreshResponse(
      { access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600 },
      'old-refresh',
    );
    const after = Date.now();
    expect(out.accessToken).toBe('new-access');
    expect(out.refreshToken).toBe('rotated');
    // 3600s - 30s safety skew = 3570s.
    expect(out.expiresAt).toBeGreaterThanOrEqual(before + 3570 * 1000);
    expect(out.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it('falls back to the input refresh token when the server does not rotate', () => {
    const out = parseRefreshResponse({ access_token: 'a', expires_in: 60 }, 'fallback-refresh');
    expect(out.refreshToken).toBe('fallback-refresh');
  });

  it('throws CLAUDE_CODE_TOKEN_REFRESH_FAILED on missing access_token', () => {
    expect(() => parseRefreshResponse({ expires_in: 60 }, 'r')).toThrow(CodesignError);
  });

  it('throws when the response is not an object', () => {
    expect(() => parseRefreshResponse('hello', 'r')).toThrow(CodesignError);
  });
});

describe('refreshClaudeCodeToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetInFlightForTests();
  });

  it('hits the OAuth endpoint with grant_type=refresh_token + client_id', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'new', expires_in: 600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await refreshClaudeCodeToken({
      refreshToken: 'r1',
      clientId: 'cli-id',
      endpoint: ENDPOINT,
    });
    expect(out.accessToken).toBe('new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    if (!callArgs) throw new Error('no fetch call');
    const [url, init] = callArgs as unknown as [string, RequestInit | undefined];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['grant_type']).toBe('refresh_token');
    expect(body['refresh_token']).toBe('r1');
    expect(body['client_id']).toBe('cli-id');
  });

  it('throws CLAUDE_CODE_REIMPORT_REQUIRED on 401 (revoked token)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    const err = await refreshClaudeCodeToken({
      refreshToken: 'r2',
      clientId: 'c',
      endpoint: ENDPOINT,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesignError);
    expect((err as CodesignError).code).toBe(ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED);
  });

  it('throws CLAUDE_CODE_TOKEN_REFRESH_FAILED on 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );
    const err = await refreshClaudeCodeToken({
      refreshToken: 'r3',
      clientId: 'c',
      endpoint: ENDPOINT,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesignError);
    expect((err as CodesignError).code).toBe(ERROR_CODES.CLAUDE_CODE_TOKEN_REFRESH_FAILED);
  });

  it('throws CLAUDE_CODE_TOKEN_REFRESH_FAILED on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('econnrefused');
      }),
    );
    const err = await refreshClaudeCodeToken({
      refreshToken: 'r4',
      clientId: 'c',
      endpoint: ENDPOINT,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesignError);
    expect((err as CodesignError).code).toBe(ERROR_CODES.CLAUDE_CODE_TOKEN_REFRESH_FAILED);
  });

  it('two parallel callers with the same refresh token share one in-flight HTTP request', async () => {
    const fetchMock = vi.fn(async () => {
      // Slight delay so both callers actually overlap.
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ access_token: 'shared', expires_in: 60 }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([
      refreshClaudeCodeToken({ refreshToken: 'rp', clientId: 'c', endpoint: ENDPOINT }),
      refreshClaudeCodeToken({ refreshToken: 'rp', clientId: 'c', endpoint: ENDPOINT }),
    ]);
    expect(a.accessToken).toBe('shared');
    expect(b.accessToken).toBe('shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
