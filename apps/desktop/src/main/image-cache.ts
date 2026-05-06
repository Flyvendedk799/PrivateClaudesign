/**
 * Phase 1 — content-addressed image-asset cache.
 *
 * Keyed by a SHA-256 of the request shape that affects the bitmap output:
 * `{ provider, model, prompt, size, quality, outputFormat, aspectRatio }`.
 * Cache hit avoids a 20–60s round-trip to the bitmap provider AND the
 * associated $$$ — a meaningful UX win for design iteration where the
 * agent re-asks for the same hero image after a CSS-only refactor.
 *
 * Layout:
 *   ${userData}/image-cache/{hash}.json   — { mimeType, model, provider, revisedPrompt? }
 *   ${userData}/image-cache/{hash}.bin    — raw image bytes
 *
 * Schema-versioned via the metadata JSON so future shape changes can
 * migrate without nuking the cache.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_SCHEMA_VERSION = 1;

export interface CacheKeyInput {
  provider: string;
  model: string | undefined;
  prompt: string;
  size: string | undefined;
  quality: string | undefined;
  outputFormat: string | undefined;
  aspectRatio?: string | undefined;
}

export interface CachedImage {
  dataUrl: string;
  mimeType: string;
  model: string;
  provider: string;
  revisedPrompt?: string | undefined;
}

interface CacheMeta {
  schemaVersion: number;
  mimeType: string;
  model: string;
  provider: string;
  revisedPrompt?: string;
}

export function hashCacheKey(input: CacheKeyInput): string {
  const canonical = JSON.stringify({
    provider: input.provider,
    model: input.model ?? null,
    prompt: input.prompt,
    size: input.size ?? null,
    quality: input.quality ?? null,
    outputFormat: input.outputFormat ?? null,
    aspectRatio: input.aspectRatio ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function dataUrlToBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('image-cache: malformed dataUrl (no comma)');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

function bytesToDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

export interface ImageCache {
  get: (key: CacheKeyInput) => CachedImage | null;
  put: (key: CacheKeyInput, image: CachedImage) => void;
}

export function makeImageCache(userDataDir: string): ImageCache {
  const dir = join(userDataDir, 'image-cache');
  let dirEnsured = false;
  const ensureDir = (): void => {
    if (dirEnsured) return;
    mkdirSync(dir, { recursive: true });
    dirEnsured = true;
  };

  return {
    get(key) {
      const hash = hashCacheKey(key);
      const metaPath = join(dir, `${hash}.json`);
      const binPath = join(dir, `${hash}.bin`);
      if (!existsSync(metaPath) || !existsSync(binPath)) return null;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CacheMeta;
        if (meta.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
        const bytes = readFileSync(binPath);
        return {
          dataUrl: bytesToDataUrl(bytes, meta.mimeType),
          mimeType: meta.mimeType,
          model: meta.model,
          provider: meta.provider,
          ...(meta.revisedPrompt !== undefined ? { revisedPrompt: meta.revisedPrompt } : {}),
        };
      } catch {
        return null;
      }
    },
    put(key, image) {
      ensureDir();
      const hash = hashCacheKey(key);
      const metaPath = join(dir, `${hash}.json`);
      const binPath = join(dir, `${hash}.bin`);
      const meta: CacheMeta = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        mimeType: image.mimeType,
        model: image.model,
        provider: image.provider,
        ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
      };
      try {
        writeFileSync(binPath, dataUrlToBytes(image.dataUrl));
        writeFileSync(metaPath, JSON.stringify(meta));
      } catch {
        // Cache write is best-effort; never fail a successful generation.
      }
    },
  };
}
