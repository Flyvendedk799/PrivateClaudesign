/**
 * Best-effort macOS Keychain read for the Claude Code OAuth credential
 * blob. Used at import time to capture the refresh token + expiry so the
 * OAuth refresh helper (`@open-codesign/providers#refreshClaudeCodeToken`)
 * can keep an imported identity alive without re-onboarding.
 *
 * Limitations:
 * - Darwin only. Other platforms get `null` and silently fall back to the
 *   existing settings.json / shell-env path (no refresh).
 * - The blob format Claude Code writes is not officially documented. We
 *   accept anything with a `claudeAiOauth.accessToken` (or top-level
 *   `accessToken`) field; missing refresh-token / expiry / client-id
 *   fields just degrade gracefully — the access token still works until
 *   it expires, at which point the user is asked to re-import.
 * - The OAuth `clientId` Anthropic uses for Claude Code is embedded in
 *   the Claude Code binary, NOT in the keychain blob. Some forks store
 *   it alongside; we read the field if present, otherwise leave it
 *   undefined and let the user supply one via env (see
 *   `OPEN_CODESIGN_CLAUDE_OAUTH_CLIENT_ID`).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ClaudeCodeKeychainCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Unix-ms timestamp. */
  expiresAt?: number;
  oauthClientId?: string;
}

interface ReadOptions {
  /** Override the platform check for tests. */
  platform?: NodeJS.Platform;
  /** Override the env so tests can inject the client-id without touching
   *  process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test injection point — the actual `security` shell-out. Returns the
   *  raw blob string or null when the keychain entry is missing. */
  readFromKeychain?: () => Promise<string | null>;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

async function defaultReadFromKeychain(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    const trimmed = stdout.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    // 44 = "could not be found"; 51 = "interaction not allowed". Either
    // way, surface as null and let the caller fall back.
    return null;
  }
}

/** Pull Claude Code's credential blob from the macOS keychain and parse
 *  the OAuth fields we know how to handle. Returns null on any failure
 *  so callers can fall back without surfacing a stack trace. */
export async function readClaudeCodeKeychainCredentials(
  opts: ReadOptions = {},
): Promise<ClaudeCodeKeychainCredentials | null> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return null;

  const reader = opts.readFromKeychain ?? defaultReadFromKeychain;
  let raw: string | null;
  try {
    raw = await reader();
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseKeychainBlob(parsed, opts.env ?? process.env);
}

export function parseKeychainBlob(
  blob: unknown,
  env: NodeJS.ProcessEnv,
): ClaudeCodeKeychainCredentials | null {
  if (typeof blob !== 'object' || blob === null) return null;
  const root = blob as Record<string, unknown>;
  // Claude Code wraps under `claudeAiOauth`; we also accept a top-level
  // shape so a hand-edited blob still parses.
  const inner =
    typeof root['claudeAiOauth'] === 'object' && root['claudeAiOauth'] !== null
      ? (root['claudeAiOauth'] as Record<string, unknown>)
      : root;

  const accessToken = inner['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

  const out: ClaudeCodeKeychainCredentials = { accessToken };

  const refreshToken = inner['refreshToken'];
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    out.refreshToken = refreshToken;
  }

  const expiresAt = inner['expiresAt'];
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
    out.expiresAt = expiresAt;
  }

  // Prefer in-blob client_id when present; otherwise fall back to the
  // env override (advanced setup).
  const inBlobClientId = inner['clientId'] ?? inner['client_id'];
  const envClientId = env['OPEN_CODESIGN_CLAUDE_OAUTH_CLIENT_ID'];
  if (typeof inBlobClientId === 'string' && inBlobClientId.length > 0) {
    out.oauthClientId = inBlobClientId;
  } else if (typeof envClientId === 'string' && envClientId.length > 0) {
    out.oauthClientId = envClientId;
  }

  return out;
}
