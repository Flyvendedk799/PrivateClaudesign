import {
  type Config,
  type ProviderEntry,
  THREED_ASSET_SCHEMA_VERSION,
  hydrateConfig,
} from '@open-codesign/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultThreeDAssetSettings,
  resolveThreeDAssetConfig,
  threeDAssetSettingsToView,
} from './threed-asset-settings';

vi.mock('./onboarding-ipc', () => ({
  getCachedConfig: () => null,
  setCachedConfig: () => {},
}));

vi.mock('./keychain', () => ({
  buildSecretRef: (value: string) => ({ ciphertext: value, mask: '***' }),
  decryptSecret: (value: string) => value,
}));

vi.mock('./electron-runtime', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('./config', () => ({ writeConfig: vi.fn(async () => {}) }));

vi.mock('./logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function makeConfig(args: {
  enabled: boolean;
  withKey: boolean;
  baseUrl?: string;
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
    threeDAsset: {
      schemaVersion: THREED_ASSET_SCHEMA_VERSION,
      enabled: args.enabled,
      provider: 'meshy',
      ...(args.withKey ? { apiKey: { ciphertext: 'msy_test', mask: 'msy_••••' } } : {}),
      ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
    },
  });
}

describe('threed-asset settings — resolve', () => {
  it('returns null when disabled', () => {
    const cfg = makeConfig({ enabled: false, withKey: true });
    expect(resolveThreeDAssetConfig(cfg)).toBeNull();
  });

  it('returns null when enabled but no key configured', () => {
    const cfg = makeConfig({ enabled: true, withKey: false });
    expect(resolveThreeDAssetConfig(cfg)).toBeNull();
  });

  it('returns the resolved config when enabled + key present', () => {
    const cfg = makeConfig({ enabled: true, withKey: true });
    expect(resolveThreeDAssetConfig(cfg)).toEqual({ provider: 'meshy', apiKey: 'msy_test' });
  });

  it('threads baseUrl through when set', () => {
    const cfg = makeConfig({
      enabled: true,
      withKey: true,
      baseUrl: 'https://api.example.com',
    });
    expect(resolveThreeDAssetConfig(cfg)).toEqual({
      provider: 'meshy',
      apiKey: 'msy_test',
      baseUrl: 'https://api.example.com',
    });
  });
});

describe('threed-asset settings — view', () => {
  it('falls back to defaults when settings are absent', () => {
    const view = threeDAssetSettingsToView(undefined);
    expect(view).toEqual({
      enabled: false,
      provider: 'meshy',
      baseUrl: null,
      hasKey: false,
      maskedKey: null,
    });
  });

  it('exposes maskedKey + hasKey when a key is configured', () => {
    const cfg = makeConfig({ enabled: true, withKey: true });
    const view = threeDAssetSettingsToView(cfg.threeDAsset);
    expect(view.enabled).toBe(true);
    expect(view.hasKey).toBe(true);
    expect(view.maskedKey).toBe('msy_••••');
  });

  it('default settings are valid against the schema', () => {
    expect(defaultThreeDAssetSettings()).toMatchObject({
      schemaVersion: THREED_ASSET_SCHEMA_VERSION,
      enabled: false,
      provider: 'meshy',
    });
  });
});
