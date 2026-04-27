/**
 * Anthropic OAuth refresh helper for the Claude Code import path.
 *
 * Imported Claude Code identities expire on a short cadence (hours) — without
 * a refresh, the next generation fails with a 401. This module exchanges a
 * stored refresh token for a fresh access token via Anthropic's OAuth endpoint
 * and dedupes parallel requests so a burst of generations triggers one HTTP
 * call, not N. Long-lived API keys do NOT use this; gate calls on the
 * `requiresClaudeCodeIdentity` capability flag (or equivalently: provider id
 * === 'claude-code-imported').
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';

/** Default Anthropic OAuth token endpoint. Override via env for test
 *  environments or alternative gateways. */
const DEFAULT_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

export interface RefreshClaudeCodeTokenInput {
  refreshToken: string;
  clientId: string;
  /** Override the token endpoint. Honoured per-call so callers (and
   *  tests) can drive the request without env-var footprint. */
  endpoint?: string;
  signal?: AbortSignal;
}

export interface RefreshClaudeCodeTokenResult {
  accessToken: string;
  /** New refresh token rotated by the server, or the input refresh token
   *  if rotation is not in use. Persist either way. */
  refreshToken: string;
  /** Unix-ms timestamp at which the new access token expires. Computed
   *  from the response's `expires_in` (seconds) plus a small safety
   *  skew so we refresh slightly before the server-side cutover. */
  expiresAt: number;
}

/** A few seconds shaved off the server-reported expiry so we don't race
 *  the wall-clock against a cold cache. Same magnitude Claude Code itself
 *  uses internally. */
const EXPIRY_SAFETY_SKEW_SEC = 30;

/** Module-level in-flight cache so concurrent callers share one HTTP
 *  refresh request. Keyed by refresh-token hash so we don't keep the
 *  raw token in memory longer than necessary. */
const inFlight = new Map<string, Promise<RefreshClaudeCodeTokenResult>>();

function fingerprintRefresh(token: string): string {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Exchange `refreshToken` for a fresh `{ accessToken, refreshToken,
 * expiresAt }`. Throws `CodesignError` with
 * `CLAUDE_CODE_TOKEN_REFRESH_FAILED` for transient failures and with
 * `CLAUDE_CODE_REIMPORT_REQUIRED` for unrecoverable ones (revoked /
 * 4xx-class). Concurrent callers with the same refresh token share one
 * in-flight HTTP request.
 */
export async function refreshClaudeCodeToken(
  input: RefreshClaudeCodeTokenInput,
): Promise<RefreshClaudeCodeTokenResult> {
  const key = fingerprintRefresh(input.refreshToken);
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<RefreshClaudeCodeTokenResult> => {
    const endpoint = input.endpoint ?? DEFAULT_OAUTH_TOKEN_URL;
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: input.refreshToken,
          client_id: input.clientId,
        }),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    } catch (err) {
      throw new CodesignError(
        `OAuth refresh network failure: ${err instanceof Error ? err.message : String(err)}`,
        ERROR_CODES.CLAUDE_CODE_TOKEN_REFRESH_FAILED,
        { cause: err instanceof Error ? err : new Error(String(err)) },
      );
    }
    if (res.status === 400 || res.status === 401) {
      // Refresh token revoked, expired, or rejected by the server. Force
      // the user back through onboarding rather than retrying — re-trying
      // a revoked token is just noise.
      throw new CodesignError(
        `Refresh token rejected (HTTP ${res.status}); re-import required`,
        ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED,
      );
    }
    if (!res.ok) {
      throw new CodesignError(
        `OAuth refresh failed with HTTP ${res.status}`,
        ERROR_CODES.CLAUDE_CODE_TOKEN_REFRESH_FAILED,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new CodesignError(
        `OAuth refresh response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        ERROR_CODES.CLAUDE_CODE_TOKEN_REFRESH_FAILED,
        { cause: err instanceof Error ? err : new Error(String(err)) },
      );
    }
    return parseRefreshResponse(body, input.refreshToken);
  })();

  inFlight.set(key, promise);
  // Side-effect-only cleanup. .then(_, _) swallows both fulfillment and
  // rejection so we don't trigger an unhandled-rejection trace on the
  // cleanup branch — the original `promise` keeps its rejection for the
  // awaiting caller.
  const cleanup = () => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

export function parseRefreshResponse(
  raw: unknown,
  fallbackRefreshToken: string,
): RefreshClaudeCodeTokenResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(
      'OAuth refresh response must be a JSON object',
      ERROR_CODES.CLAUDE_CODE_TOKEN_REFRESH_FAILED,
    );
  }
  const r = raw as Record<string, unknown>;
  const accessToken = r['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new CodesignError(
      'OAuth refresh response missing access_token',
      ERROR_CODES.CLAUDE_CODE_TOKEN_REFRESH_FAILED,
    );
  }
  const expiresIn = r['expires_in'];
  const expiresInSec = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 60 * 60; // 1h default if absent
  const expiresAt = Date.now() + Math.max(0, expiresInSec - EXPIRY_SAFETY_SKEW_SEC) * 1000;
  const rotated = r['refresh_token'];
  const refreshToken =
    typeof rotated === 'string' && rotated.length > 0 ? rotated : fallbackRefreshToken;
  return { accessToken, refreshToken, expiresAt };
}

/** Whether a token with the given expiresAt timestamp should be refreshed
 *  proactively. Includes a small skew so the second-to-last request before
 *  expiry doesn't race the OAuth refresh against the LLM call. */
const REFRESH_SKEW_MS = 60 * 1000;
export function shouldRefresh(expiresAt: number | undefined, now: number = Date.now()): boolean {
  if (typeof expiresAt !== 'number') return false;
  return expiresAt - now <= REFRESH_SKEW_MS;
}

/** Test-only escape hatch — purges the in-flight cache between cases. */
export function _resetInFlightForTests(): void {
  inFlight.clear();
}
