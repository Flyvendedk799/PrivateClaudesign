import {
  type ThreeDAssetProvider,
  fakeThreeDAssetProvider,
  makeMeshyProvider,
  makeTripoProvider,
} from '@open-codesign/providers';
/**
 * may9 step 1 — resolve a configured 3D-asset provider into a wired
 * ThreeDAssetProvider closure that the agent's generate_3d_asset tool
 * can call.
 *
 * Mirrors the shape of image-generation-settings.ts: pull the
 * Settings UI's stored config, look up the BYOK secret in the
 * keychain, build the provider. Returns null when the user has not
 * configured a 3D provider — the tool simply isn't registered for
 * that run.
 */
import {
  CodesignError,
  type Config,
  ERROR_CODES,
  THREED_ASSET_SCHEMA_VERSION,
  type ThreeDAssetProviderId,
  ThreeDAssetProviderSchema,
  type ThreeDAssetSettings,
  ThreeDAssetSettingsSchema,
  hydrateConfig,
} from '@open-codesign/shared';
import { writeConfig } from './config';
import { ipcMain } from './electron-runtime';
import { buildSecretRef, decryptSecret } from './keychain';
import { getLogger } from './logger';
import { getCachedConfig, setCachedConfig } from './onboarding-ipc';

const log = getLogger('threed-asset');

export interface ResolvedThreeDAssetConfig {
  provider: ThreeDAssetProviderId;
  apiKey: string;
  baseUrl?: string | undefined;
}

export function resolveThreeDAssetConfig(cfg: Config): ResolvedThreeDAssetConfig | null {
  const settings: ThreeDAssetSettings | undefined = cfg.threeDAsset;
  if (settings === undefined || !settings.enabled) return null;
  const ref = settings.apiKey;
  if (ref === undefined) return null;
  let apiKey: string;
  try {
    apiKey = decryptSecret(ref.ciphertext);
  } catch {
    return null;
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  return {
    provider: settings.provider,
    apiKey,
    ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
  };
}

export function buildThreeDAssetProvider(cfg: ResolvedThreeDAssetConfig): ThreeDAssetProvider {
  if (cfg.provider === 'meshy') {
    return makeMeshyProvider({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
    });
  }
  if (cfg.provider === 'tripo') {
    return makeTripoProvider({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
    });
  }
  return fakeThreeDAssetProvider;
}

/** Test/headless path: no API key configured, return the
 *  deterministic fake so vitest + dev-without-key both work. */
export function buildFakeThreeDAssetProvider(): ThreeDAssetProvider {
  return fakeThreeDAssetProvider;
}

// ─── Settings view + IPC ─────────────────────────────────────────────────────

export interface ThreeDAssetSettingsView {
  enabled: boolean;
  provider: ThreeDAssetProviderId;
  baseUrl: string | null;
  hasKey: boolean;
  maskedKey: string | null;
}

interface ThreeDAssetUpdateInput {
  enabled?: boolean;
  provider?: ThreeDAssetProviderId;
  baseUrl?: string | null;
  apiKey?: string;
}

export function defaultThreeDAssetSettings(): ThreeDAssetSettings {
  return ThreeDAssetSettingsSchema.parse({
    schemaVersion: THREED_ASSET_SCHEMA_VERSION,
    enabled: false,
    provider: 'meshy',
  });
}

export function threeDAssetSettingsToView(
  settings: ThreeDAssetSettings | undefined,
): ThreeDAssetSettingsView {
  const parsed = ThreeDAssetSettingsSchema.parse(settings ?? defaultThreeDAssetSettings());
  return {
    enabled: parsed.enabled,
    provider: parsed.provider,
    baseUrl: parsed.baseUrl ?? null,
    hasKey: parsed.apiKey !== undefined,
    maskedKey: parsed.apiKey?.mask ?? null,
  };
}

function parseUpdate(raw: unknown): ThreeDAssetUpdateInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('threed-asset:v1:update expects an object', ERROR_CODES.IPC_BAD_INPUT);
  }
  const r = raw as Record<string, unknown>;
  const out: ThreeDAssetUpdateInput = {};
  if (typeof r['enabled'] === 'boolean') out.enabled = r['enabled'];
  if (typeof r['provider'] === 'string') {
    out.provider = ThreeDAssetProviderSchema.parse(r['provider']);
  }
  if (r['baseUrl'] === null) {
    out.baseUrl = null;
  } else if (typeof r['baseUrl'] === 'string') {
    const trimmed = r['baseUrl'].trim();
    out.baseUrl = trimmed.length === 0 ? null : trimmed;
  }
  if (typeof r['apiKey'] === 'string') out.apiKey = r['apiKey'];
  return out;
}

async function updateThreeDAssetSettings(
  patch: ThreeDAssetUpdateInput,
): Promise<ThreeDAssetSettingsView> {
  const cfg = getCachedConfig();
  if (cfg === null) {
    throw new CodesignError('No configuration found', ERROR_CODES.CONFIG_MISSING);
  }
  const current = ThreeDAssetSettingsSchema.parse(cfg.threeDAsset ?? defaultThreeDAssetSettings());
  let next: ThreeDAssetSettings = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.provider !== undefined) next.provider = patch.provider;
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl === null) {
      const { baseUrl: _removed, ...rest } = next;
      next = rest;
    } else {
      next.baseUrl = patch.baseUrl;
    }
  }
  if (patch.apiKey !== undefined) {
    const trimmed = patch.apiKey.trim();
    if (trimmed.length === 0) {
      const { apiKey: _removed, ...rest } = next;
      next = rest;
    } else {
      next.apiKey = buildSecretRef(trimmed);
    }
  }
  const parsed = ThreeDAssetSettingsSchema.parse(next);
  const config = hydrateConfig({
    version: 3,
    activeProvider: cfg.activeProvider,
    activeModel: cfg.activeModel,
    secrets: cfg.secrets,
    providers: cfg.providers,
    ...(cfg.designSystem !== undefined ? { designSystem: cfg.designSystem } : {}),
    ...(cfg.imageGeneration !== undefined ? { imageGeneration: cfg.imageGeneration } : {}),
    threeDAsset: parsed,
  });
  await writeConfig(config);
  setCachedConfig(config);
  log.info('settings.update.ok', {
    enabled: parsed.enabled,
    provider: parsed.provider,
    hasKey: parsed.apiKey !== undefined,
  });
  return threeDAssetSettingsToView(parsed);
}

export function registerThreeDAssetSettingsIpc(): void {
  ipcMain.handle('threed-asset:v1:get', async (): Promise<ThreeDAssetSettingsView> => {
    const cfg = getCachedConfig();
    return threeDAssetSettingsToView(cfg?.threeDAsset);
  });

  ipcMain.handle(
    'threed-asset:v1:update',
    async (_e, raw: unknown): Promise<ThreeDAssetSettingsView> => {
      return updateThreeDAssetSettings(parseUpdate(raw));
    },
  );
}
