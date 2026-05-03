/**
 * Wires the `@open-codesign/providers#refreshClaudeCodeToken` helper into
 * the Electron main process: reads the cached `SecretRef` for the
 * `claude-code-imported` provider, decides whether to refresh, calls the
 * helper, and persists the new token back to `config.toml` + the cached
 * config so subsequent reads see the fresh value.
 *
 * Designed to run as a side-effect before `resolveApiKeyForActive` so the
 * existing key-resolution path stays unchanged on the happy path. A no-op
 * when:
 *   - the provider is not `claude-code-imported`
 *   - the secret has no expiresAt (long-lived API key path)
 *   - expiresAt is comfortably in the future (`shouldRefresh` returns false)
 *   - we don't have both a refreshToken AND an oauthClientId (refresh would
 *     fail at the API anyway; user keeps the static-token path until expiry,
 *     then sees the existing 401 surface).
 */

import { refreshClaudeCodeToken, shouldRefresh } from '@open-codesign/providers';
import { CodesignError, type Config, ERROR_CODES, hydrateConfig } from '@open-codesign/shared';
import { writeConfig } from './config';
import { buildOAuthSecretRef, decryptSecret } from './keychain';
import { getLogger } from './logger';
import { getCachedConfig, setCachedConfig } from './onboarding-ipc';

const log = getLogger('claude-code-token-refresh');

const CLAUDE_CODE_PROVIDER_ID = 'claude-code-imported';

/**
 * If the active provider is `claude-code-imported` and its access token
 * is at/near expiry, swap a fresh one in via the OAuth refresh endpoint
 * and persist the result. Throws `CLAUDE_CODE_REIMPORT_REQUIRED` when the
 * refresh token is rejected (terminal — UI prompts for re-import) and
 * `CLAUDE_CODE_TOKEN_REFRESH_FAILED` for transient failures (the next
 * call will retry on its own).
 *
 * Safe to call before every generation; the in-flight cache inside
 * `refreshClaudeCodeToken` collapses concurrent callers to one HTTP
 * request.
 */
export async function ensureFreshClaudeCodeToken(providerId: string): Promise<void> {
  if (providerId !== CLAUDE_CODE_PROVIDER_ID) return;
  const cfg = getCachedConfig();
  if (cfg === null) return;
  const secret = cfg.secrets[CLAUDE_CODE_PROVIDER_ID];
  if (secret === undefined) return;
  if (!shouldRefresh(secret.expiresAt)) return;

  // Need both a refresh token AND a client id to refresh. Without a client
  // id (the OAuth client embedded in Claude Code's binary, captured from
  // the keychain blob when present, or supplied via env override) the
  // refresh endpoint will reject.
  //
  // Two cases when these are missing:
  //   1. Token still valid (expiresAt is in the future, just inside the
  //      60s skew window) — log a warning and let the run proceed; the
  //      request will succeed and the user can re-import on a later run
  //      before the token actually expires.
  //   2. Token already at/past expiry — fail-fast with
  //      CLAUDE_CODE_REIMPORT_REQUIRED. Silent-skipping in this case
  //      sends the user into a guaranteed-401 generation that surfaces
  //      as a dead 2-row design stub (plan0305 P2.3 — recent traces
  //      showed 6/6 most recent failures matched this pattern).
  if (secret.refreshToken === undefined || secret.oauthClientId === undefined) {
    const expiresInMs = (secret.expiresAt ?? 0) - Date.now();
    const tokenAlreadyExpired = expiresInMs <= 0;
    if (tokenAlreadyExpired) {
      log.warn('refresh.skipped.fail_fast', {
        reason: 'expired_no_refresh_credentials',
        hasRefreshToken: secret.refreshToken !== undefined,
        hasClientId: secret.oauthClientId !== undefined,
        expiresInMs,
      });
      throw new CodesignError(
        'Claude Code token has expired and the local credential store does not have the refresh prerequisites required to renew it. Re-import from Claude Code in Settings.',
        ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED,
      );
    }
    log.warn('refresh.skipped', {
      reason: 'missing_refresh_or_client_id',
      hasRefreshToken: secret.refreshToken !== undefined,
      hasClientId: secret.oauthClientId !== undefined,
      expiresInMs,
    });
    return;
  }

  const refreshTokenPlain = decryptSecret(secret.refreshToken);

  log.info('refresh.start', { expiresInMs: (secret.expiresAt ?? 0) - Date.now() });
  const refreshed = await refreshClaudeCodeToken({
    refreshToken: refreshTokenPlain,
    clientId: secret.oauthClientId,
  });
  log.info('refresh.ok', { newExpiresInMs: refreshed.expiresAt - Date.now() });

  const updatedSecret = buildOAuthSecretRef({
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    oauthClientId: secret.oauthClientId,
  });
  const next: Config = hydrateConfig({
    version: 3,
    activeProvider: cfg.activeProvider,
    activeModel: cfg.activeModel,
    secrets: { ...cfg.secrets, [CLAUDE_CODE_PROVIDER_ID]: updatedSecret },
    providers: cfg.providers,
    ...(cfg.designSystem !== undefined ? { designSystem: cfg.designSystem } : {}),
    ...(cfg.imageGeneration !== undefined ? { imageGeneration: cfg.imageGeneration } : {}),
  });
  await writeConfig(next);
  setCachedConfig(next);
}

export { ERROR_CODES as ClaudeCodeRefreshErrorCodes };
