import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Config,
  type ProviderEntry,
  STEAM_SCHEMA_VERSION,
  hydrateConfig,
} from '@open-codesign/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _internal,
  resolveSteamConfig,
  steamSettingsToView,
  uploadBuildToSteam,
} from './steam-settings';

vi.mock('./onboarding-ipc', () => ({
  getCachedConfig: () => null,
  setCachedConfig: () => {},
}));

vi.mock('./keychain', () => ({
  buildSecretRef: (value: string) => ({ ciphertext: value, mask: 'st_••••' }),
  decryptSecret: (value: string) => value,
}));

vi.mock('./electron-runtime', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('./config', () => ({ writeConfig: vi.fn(async () => {}) }));

vi.mock('./logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// findSteamCmd hits the real filesystem; stub it via a path override.
vi.mock('./steam-discovery', () => ({
  findSteamCmd: () => ({ ok: false, reason: 'missing' }),
}));

function makeConfig(args: {
  enabled: boolean;
  withCreds: boolean;
  steamcmdPath?: string;
}): Config {
  const providers: Record<string, ProviderEntry> = {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      builtin: true,
      wire: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.4',
    },
  };
  return hydrateConfig({
    version: 3,
    activeProvider: 'openai',
    activeModel: 'gpt-5.4',
    providers,
    secrets: {},
    steam: {
      schemaVersion: STEAM_SCHEMA_VERSION,
      enabled: args.enabled,
      ...(args.withCreds
        ? {
            username: 'gabe',
            password: { ciphertext: 's3cret', mask: 's3****' },
            appId: 480,
            depotId: 481,
          }
        : {}),
      ...(args.steamcmdPath !== undefined ? { steamcmdPath: args.steamcmdPath } : {}),
    },
  });
}

describe('steam-settings — view', () => {
  it('falls back to defaults when settings absent', () => {
    const view = steamSettingsToView(undefined);
    expect(view).toMatchObject({
      enabled: false,
      username: null,
      hasPassword: false,
      appId: null,
      depotId: null,
    });
  });

  it('exposes hasPassword + maskedPassword without leaking ciphertext', () => {
    const cfg = makeConfig({ enabled: true, withCreds: true });
    const view = steamSettingsToView(cfg.steam);
    expect(view.hasPassword).toBe(true);
    expect(view.passwordMask).toBe('s3****');
    expect(view.username).toBe('gabe');
    expect(view.appId).toBe(480);
  });
});

describe('resolveSteamConfig', () => {
  it('returns null when disabled', () => {
    const cfg = makeConfig({ enabled: false, withCreds: true, steamcmdPath: '/bin/steamcmd' });
    expect(resolveSteamConfig(cfg)).toBeNull();
  });

  it('returns null when credentials are incomplete', () => {
    const cfg = makeConfig({ enabled: true, withCreds: false, steamcmdPath: '/bin/steamcmd' });
    expect(resolveSteamConfig(cfg)).toBeNull();
  });

  it('returns null when steamcmd is not configured + not detected', () => {
    const cfg = makeConfig({ enabled: true, withCreds: true });
    expect(resolveSteamConfig(cfg)).toBeNull();
  });

  it('resolves fully when enabled + credentials + steamcmdPath present', () => {
    const cfg = makeConfig({
      enabled: true,
      withCreds: true,
      steamcmdPath: '/opt/homebrew/bin/steamcmd',
    });
    const resolved = resolveSteamConfig(cfg);
    expect(resolved).not.toBeNull();
    expect(resolved?.username).toBe('gabe');
    expect(resolved?.password).toBe('s3cret');
    expect(resolved?.appId).toBe(480);
    expect(resolved?.depotId).toBe(481);
    expect(resolved?.steamcmdPath).toBe('/opt/homebrew/bin/steamcmd');
  });
});

describe('uploadBuildToSteam — happy path with stub steamcmd', () => {
  let workDir = '';
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'steam-test-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('passes login + run_app_build args, parses BuildID, scrubs SteamGuard', async () => {
    let capturedArgs: string[] = [];
    let capturedBin = '';
    const result = await uploadBuildToSteam(
      {
        enabled: true,
        username: 'gabe',
        password: 's3cret',
        appId: 480,
        depotId: 481,
        steamcmdPath: '/opt/homebrew/bin/steamcmd',
        buildDescription: 'test',
      },
      { contentRoot: '/tmp/build-output' },
      {
        runSteamCmd: async (bin, args, onLine) => {
          capturedBin = bin;
          capturedArgs = args;
          onLine('Logged in OK');
          onLine('Steam Guard code: ABC123');
          onLine('Successfully finished AppBuild for AppID 480');
          onLine('BuildID 999777');
          return { exitCode: 0 };
        },
        stagingDirBase: workDir,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.buildId).toBe('999777');
    expect(capturedBin).toBe('/opt/homebrew/bin/steamcmd');
    expect(capturedArgs[0]).toBe('+login');
    expect(capturedArgs[1]).toBe('gabe');
    expect(capturedArgs[2]).toBe('s3cret');
    expect(capturedArgs).toContain('+run_app_build');
    expect(capturedArgs[capturedArgs.length - 1]).toBe('+quit');
    expect(result.log).toContain('Steam Guard code: [scrubbed]');
    expect(result.log).not.toContain('ABC123');
  });

  it('reports failure when steamcmd exits non-zero', async () => {
    const result = await uploadBuildToSteam(
      {
        enabled: true,
        username: 'gabe',
        password: 's3cret',
        appId: 480,
        depotId: 481,
        steamcmdPath: '/opt/homebrew/bin/steamcmd',
        buildDescription: 'test',
      },
      { contentRoot: '/tmp/build-output' },
      {
        runSteamCmd: async (_bin, _args, onLine) => {
          onLine('FAILED login: rate limited');
          return { exitCode: 5 };
        },
        stagingDirBase: workDir,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.log).toContain('rate limited');
  });

  it('threads SteamGuard code into args when provided', async () => {
    let capturedArgs: string[] = [];
    await uploadBuildToSteam(
      {
        enabled: true,
        username: 'gabe',
        password: 's3cret',
        appId: 480,
        depotId: 481,
        steamcmdPath: '/bin/steamcmd',
        buildDescription: 'test',
      },
      { contentRoot: '/tmp/x', steamGuardCode: 'AB12CD' },
      {
        runSteamCmd: async (_bin, args, onLine) => {
          capturedArgs = args;
          onLine('Successfully finished AppBuild');
          return { exitCode: 0 };
        },
        stagingDirBase: workDir,
      },
    );
    // login user pass GUARD_CODE then +run_app_build
    expect(capturedArgs[1]).toBe('gabe');
    expect(capturedArgs[2]).toBe('s3cret');
    expect(capturedArgs[3]).toBe('AB12CD');
    expect(capturedArgs[4]).toBe('+run_app_build');
  });
});

describe('VDF generation', () => {
  it('app VDF references the depot', () => {
    const vdf = _internal.buildAppVdf({
      appId: 480,
      depotId: 481,
      depotConfigPath: '/tmp/depot_481.vdf',
      description: 'test build',
    });
    expect(vdf).toContain('"appid" "480"');
    expect(vdf).toContain('"481" "/tmp/depot_481.vdf"');
    expect(vdf).toContain('"desc" "test build"');
  });

  it('depot VDF declares the depot ID', () => {
    const vdf = _internal.buildDepotVdf({ depotId: 481 });
    expect(vdf).toContain('"DepotID" "481"');
    expect(vdf).toContain('"FileMapping"');
  });
});
