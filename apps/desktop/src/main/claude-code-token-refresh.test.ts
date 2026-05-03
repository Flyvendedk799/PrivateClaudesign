import type { Config, SecretRef } from '@open-codesign/shared';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron BEFORE importing the module under test (the module imports
// onboarding-ipc which imports electron).
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    decryptString: vi.fn(),
  },
}));
vi.mock('electron-log/main', () => ({
  default: {
    scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    transports: {
      file: { resolvePathFn: null, maxSize: 0, format: '' },
      console: { level: 'info', format: '' },
    },
    errorHandler: { startCatching: vi.fn() },
    eventLogger: { startLogging: vi.fn() },
    info: vi.fn(),
  },
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}));

const refreshMock = vi.fn();
vi.mock('@open-codesign/providers', async () => {
  const actual = await vi.importActual<typeof import('@open-codesign/providers')>(
    '@open-codesign/providers',
  );
  return {
    ...actual,
    refreshClaudeCodeToken: (...args: unknown[]) => refreshMock(...args),
  };
});

const writeConfigMock = vi.fn<(cfg: Config) => Promise<void>>(async () => {});
vi.mock('./config', () => ({
  configDir: () => '/tmp/test',
  defaultConfigDir: () => '/tmp/test',
  readConfig: vi.fn(async () => null),
  writeConfig: (cfg: Config) => writeConfigMock(cfg),
}));

vi.mock('./keychain', async () => {
  const actual = await vi.importActual<typeof import('./keychain')>('./keychain');
  return {
    ...actual,
    decryptSecret: (s: string) => s.replace('plain:', ''),
    encryptSecret: (s: string) => `plain:${s}`,
  };
});

const cachedConfigRef: { current: Config | null } = { current: null };
vi.mock('./onboarding-ipc', () => ({
  getCachedConfig: () => cachedConfigRef.current,
  setCachedConfig: (next: Config) => {
    cachedConfigRef.current = next;
  },
}));

import { ensureFreshClaudeCodeToken } from './claude-code-token-refresh';

function makeSecret(overrides: Partial<SecretRef> = {}): SecretRef {
  return {
    ciphertext: 'plain:sk-ant-oat01-current',
    mask: 'sk-a***rrent',
    ...overrides,
  };
}

function makeConfig(secret: SecretRef): Config {
  return {
    schemaVersion: 3,
    activeProvider: 'claude-code-imported',
    activeModel: 'claude-sonnet-4-6',
    secrets: { 'claude-code-imported': secret },
    providers: {},
  } as unknown as Config;
}

describe('ensureFreshClaudeCodeToken', () => {
  beforeEach(() => {
    refreshMock.mockReset();
    writeConfigMock.mockReset();
    writeConfigMock.mockImplementation(async () => {});
    cachedConfigRef.current = null;
  });
  afterEach(() => {
    cachedConfigRef.current = null;
  });

  it('no-op when provider is not claude-code-imported', async () => {
    cachedConfigRef.current = makeConfig(makeSecret({ expiresAt: Date.now() - 1 }));
    await ensureFreshClaudeCodeToken('anthropic');
    expect(refreshMock).not.toHaveBeenCalled();
    expect(writeConfigMock).not.toHaveBeenCalled();
  });

  it('no-op when there is no expiresAt (long-lived API key)', async () => {
    cachedConfigRef.current = makeConfig(
      makeSecret({ refreshToken: 'plain:r', oauthClientId: 'c' }),
    );
    await ensureFreshClaudeCodeToken('claude-code-imported');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('no-op when expiresAt is comfortably in the future', async () => {
    cachedConfigRef.current = makeConfig(
      makeSecret({
        expiresAt: Date.now() + 5 * 60 * 1000,
        refreshToken: 'plain:r',
        oauthClientId: 'c',
      }),
    );
    await ensureFreshClaudeCodeToken('claude-code-imported');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('throws CLAUDE_CODE_REIMPORT_REQUIRED when token is past expiry and refresh prerequisites are missing (plan0305 P2.3)', async () => {
    cachedConfigRef.current = makeConfig(makeSecret({ expiresAt: Date.now() - 1 }));
    const err = await ensureFreshClaudeCodeToken('claude-code-imported').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesignError);
    expect((err as CodesignError).code).toBe(ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(writeConfigMock).not.toHaveBeenCalled();
  });

  it('logs a warning and proceeds when token is still valid but refresh prerequisites are missing (plan0305 P2.3)', async () => {
    // Inside the 60s skew window so shouldRefresh() fires, but expiresAt is
    // still in the future — we'd rather let this request succeed than
    // fail-fast on a token that hasn't actually expired yet.
    cachedConfigRef.current = makeConfig(makeSecret({ expiresAt: Date.now() + 30 * 1000 }));
    await expect(ensureFreshClaudeCodeToken('claude-code-imported')).resolves.toBeUndefined();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(writeConfigMock).not.toHaveBeenCalled();
  });

  it('refreshes and persists when expiresAt has passed and we have refresh+client', async () => {
    cachedConfigRef.current = makeConfig(
      makeSecret({
        expiresAt: Date.now() - 1,
        refreshToken: 'plain:r-old',
        oauthClientId: 'cli-id',
      }),
    );
    refreshMock.mockResolvedValueOnce({
      accessToken: 'sk-ant-oat01-new',
      refreshToken: 'r-rotated',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    await ensureFreshClaudeCodeToken('claude-code-imported');
    expect(refreshMock).toHaveBeenCalledWith({
      refreshToken: 'r-old',
      clientId: 'cli-id',
    });
    expect(writeConfigMock).toHaveBeenCalledTimes(1);
    const written = writeConfigMock.mock.calls[0]?.[0] as Config;
    const next = written.secrets['claude-code-imported'];
    expect(next?.ciphertext).toBe('plain:sk-ant-oat01-new');
    expect(next?.refreshToken).toBe('plain:r-rotated');
    expect(next?.oauthClientId).toBe('cli-id');
    // Cached config also got updated for the next caller.
    expect(cachedConfigRef.current?.secrets['claude-code-imported']?.ciphertext).toBe(
      'plain:sk-ant-oat01-new',
    );
  });

  it('propagates CLAUDE_CODE_REIMPORT_REQUIRED on terminal refresh failure', async () => {
    cachedConfigRef.current = makeConfig(
      makeSecret({
        expiresAt: Date.now() - 1,
        refreshToken: 'plain:r',
        oauthClientId: 'c',
      }),
    );
    refreshMock.mockRejectedValueOnce(
      new CodesignError('revoked', ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED),
    );
    const err = await ensureFreshClaudeCodeToken('claude-code-imported').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesignError);
    expect((err as CodesignError).code).toBe(ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED);
    // Did NOT persist a half-baked config on failure.
    expect(writeConfigMock).not.toHaveBeenCalled();
  });
});
