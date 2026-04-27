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
import { type Config, ERROR_CODES, hydrateConfig } from '@open-codesign/shared';
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
  // refresh endpoint will reject. Skip silently — the user keeps the
  // existing static-token behavior until expiry surfaces a 401.
  if (secret.refreshToken === undefined || secret.oauthClientId === undefined) {
    log.warn('refresh.skipped', {
      reason: 'missing_refresh_or_client_id',
      hasRefreshToken: secret.refreshToken !== undefined,
      hasClientId: secret.oauthClientId !== undefined,
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
