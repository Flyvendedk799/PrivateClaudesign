import {
  type ThreeDAssetProvider,
  fakeThreeDAssetProvider,
  makeMeshyProvider,
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
import type { Config, ThreeDAssetProviderId, ThreeDAssetSettings } from '@open-codesign/shared';
import { decryptSecret } from './keychain';

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
  // Tripo adapter is a follow-up. For now fall back to fake so a user
  // who picks 'tripo' still gets a working tool path (returns the
  // empty-scene GLB) instead of a hard failure. Settings UI surfaces
  // "Tripo support coming soon" copy.
  return fakeThreeDAssetProvider;
}

/** Test/headless path: no API key configured, return the
 *  deterministic fake so vitest + dev-without-key both work. */
export function buildFakeThreeDAssetProvider(): ThreeDAssetProvider {
  return fakeThreeDAssetProvider;
}
