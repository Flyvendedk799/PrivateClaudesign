import { describe, expect, it } from 'vitest';
import { parseKeychainBlob, readClaudeCodeKeychainCredentials } from './claude-code-keychain';

describe('parseKeychainBlob', () => {
  it('extracts the canonical claudeAiOauth shape with refresh token, expiresAt, and clientId', () => {
    const out = parseKeychainBlob(
      {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-abc',
          refreshToken: 'sk-ant-ort01-def',
          expiresAt: 1735689600000,
          clientId: 'cli-id-123',
        },
      },
      {},
    );
    expect(out).toEqual({
      accessToken: 'sk-ant-oat01-abc',
      refreshToken: 'sk-ant-ort01-def',
      expiresAt: 1735689600000,
      oauthClientId: 'cli-id-123',
    });
  });

  it('also accepts a top-level shape (no claudeAiOauth wrapper)', () => {
    const out = parseKeychainBlob(
      {
        accessToken: 'sk-ant-oat01-abc',
        refreshToken: 'r',
      },
      {},
    );
    expect(out?.accessToken).toBe('sk-ant-oat01-abc');
    expect(out?.refreshToken).toBe('r');
  });

  it('returns null when accessToken is missing', () => {
    expect(parseKeychainBlob({ claudeAiOauth: { refreshToken: 'r' } }, {})).toBeNull();
  });

  it('returns null for non-objects', () => {
    expect(parseKeychainBlob('hello', {})).toBeNull();
    expect(parseKeychainBlob(null, {})).toBeNull();
  });

  it('falls back to the env client-id override when the blob omits one', () => {
    const out = parseKeychainBlob(
      { claudeAiOauth: { accessToken: 'a' } },
      { OPEN_CODESIGN_CLAUDE_OAUTH_CLIENT_ID: 'env-cli-id' },
    );
    expect(out?.oauthClientId).toBe('env-cli-id');
  });

  it('in-blob client-id wins over env override', () => {
    const out = parseKeychainBlob(
      { claudeAiOauth: { accessToken: 'a', clientId: 'in-blob' } },
      { OPEN_CODESIGN_CLAUDE_OAUTH_CLIENT_ID: 'env-cli-id' },
    );
    expect(out?.oauthClientId).toBe('in-blob');
  });

  it('drops refreshToken/expiresAt when malformed without losing accessToken', () => {
    const out = parseKeychainBlob(
      {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: '',
          expiresAt: -1,
        },
      },
      {},
    );
    expect(out?.accessToken).toBe('a');
    expect(out?.refreshToken).toBeUndefined();
    expect(out?.expiresAt).toBeUndefined();
  });
});

describe('readClaudeCodeKeychainCredentials', () => {
  it('returns null on non-Darwin platforms', async () => {
    expect(
      await readClaudeCodeKeychainCredentials({
        platform: 'linux',
        readFromKeychain: async () => '{"accessToken":"a"}',
      }),
    ).toBeNull();
  });

  it('returns null when the keychain reader returns null (entry missing)', async () => {
    expect(
      await readClaudeCodeKeychainCredentials({
        platform: 'darwin',
        readFromKeychain: async () => null,
      }),
    ).toBeNull();
  });

  it('returns null when the keychain reader throws', async () => {
    expect(
      await readClaudeCodeKeychainCredentials({
        platform: 'darwin',
        readFromKeychain: async () => {
          throw new Error('keychain locked');
        },
      }),
    ).toBeNull();
  });

  it('returns null when the blob is not JSON', async () => {
    expect(
      await readClaudeCodeKeychainCredentials({
        platform: 'darwin',
        readFromKeychain: async () => 'not json',
      }),
    ).toBeNull();
  });

  it('parses a valid blob from the injected reader', async () => {
    const out = await readClaudeCodeKeychainCredentials({
      platform: 'darwin',
      readFromKeychain: async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: 100,
          },
        }),
      env: {},
    });
    expect(out).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 100 });
  });
});
