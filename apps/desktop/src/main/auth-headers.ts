/**
 * Shared auth header builders for anthropic / openai-like wires.
 *
 * Extracted from `connection-ipc.ts` so `onboarding-ipc.ts` can reuse the
 * same OAuth-aware logic without creating a circular import (connection-ipc
 * already imports from onboarding-ipc for cached config / key lookup).
 */

import { looksLikeClaudeOAuthToken, withClaudeCodeIdentity } from '@open-codesign/providers';
import type { SupportedOnboardingProvider, WireApi } from '@open-codesign/shared';

export function buildAuthHeadersForWire(
  wire: WireApi,
  apiKey: string,
  extraHeaders?: Record<string, string>,
  baseUrl?: string,
): Record<string, string> {
  if (apiKey.length === 0) {
    // Keyless provider (e.g. IP-whitelisted proxy) — skip auth, keep extras.
    const base = wire === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {};
    return withClaudeCodeIdentity(wire, baseUrl, { ...base, ...(extraHeaders ?? {}) }, apiKey);
  }
  const isOAuth = wire === 'anthropic' && looksLikeClaudeOAuthToken(apiKey);
  const authKey = isOAuth ? 'ant-api-placeholder' : apiKey;
  const base =
    wire === 'anthropic'
      ? isOAuth
        ? {
            authorization: `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
          }
        : {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          }
      : { authorization: `Bearer ${apiKey}` };
  return withClaudeCodeIdentity(
    wire,
    baseUrl,
    { ...base, ...(extraHeaders ?? {}) },
    isOAuth ? 'sk-ant-oat-forced' : authKey,
  );
}

export function buildAuthHeaders(
  provider: SupportedOnboardingProvider,
  apiKey: string,
  baseUrl?: string,
): Record<string, string> {
  if (provider === 'anthropic') {
    if (apiKey.length === 0) {
      // Keyless anthropic proxy — skip auth, match buildAuthHeadersForWire.
      return withClaudeCodeIdentity(
        'anthropic',
        baseUrl,
        {
          'anthropic-version': '2023-06-01',
        },
        apiKey,
      );
    }
    const isOAuth = looksLikeClaudeOAuthToken(apiKey);
    const base = isOAuth
      ? {
          authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        }
      : {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        };
    return withClaudeCodeIdentity(
      'anthropic',
      baseUrl,
      base,
      isOAuth ? 'sk-ant-oat-forced' : apiKey,
    );
  }
  return apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` };
}
