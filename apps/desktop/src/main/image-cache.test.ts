import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CacheKeyInput, hashCacheKey, makeImageCache } from './image-cache';

const SAMPLE_KEY: CacheKeyInput = {
  provider: 'openai',
  model: 'gpt-image-1',
  prompt: 'a window cleaning hero, golden hour',
  size: '1536x1024',
  quality: 'high',
  outputFormat: 'png',
  aspectRatio: '16:9',
};

// Tiny 1x1 PNG transparent pixel.
const SAMPLE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('image-cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'open-codesign-image-cache-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashCacheKey is deterministic and key-sensitive', () => {
    const a = hashCacheKey(SAMPLE_KEY);
    const b = hashCacheKey({ ...SAMPLE_KEY });
    expect(a).toBe(b);
    const c = hashCacheKey({ ...SAMPLE_KEY, prompt: 'different' });
    expect(c).not.toBe(a);
  });

  it('returns null on miss', () => {
    const cache = makeImageCache(dir);
    expect(cache.get(SAMPLE_KEY)).toBeNull();
  });

  it('roundtrips a put/get', () => {
    const cache = makeImageCache(dir);
    cache.put(SAMPLE_KEY, {
      dataUrl: SAMPLE_DATA_URL,
      mimeType: 'image/png',
      model: 'gpt-image-1',
      provider: 'openai',
    });
    const hit = cache.get(SAMPLE_KEY);
    expect(hit).not.toBeNull();
    expect(hit?.mimeType).toBe('image/png');
    expect(hit?.dataUrl).toBe(SAMPLE_DATA_URL);
    expect(hit?.model).toBe('gpt-image-1');
    expect(hit?.provider).toBe('openai');
  });

  it('writes both meta and bin files to disk', () => {
    const cache = makeImageCache(dir);
    cache.put(SAMPLE_KEY, {
      dataUrl: SAMPLE_DATA_URL,
      mimeType: 'image/png',
      model: 'gpt-image-1',
      provider: 'openai',
    });
    const hash = hashCacheKey(SAMPLE_KEY);
    expect(existsSync(join(dir, 'image-cache', `${hash}.json`))).toBe(true);
    expect(existsSync(join(dir, 'image-cache', `${hash}.bin`))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, 'image-cache', `${hash}.json`), 'utf8')) as {
      schemaVersion: number;
    };
    expect(meta.schemaVersion).toBe(1);
  });

  it('preserves revisedPrompt across roundtrip', () => {
    const cache = makeImageCache(dir);
    cache.put(SAMPLE_KEY, {
      dataUrl: SAMPLE_DATA_URL,
      mimeType: 'image/png',
      model: 'gpt-image-1',
      provider: 'openai',
      revisedPrompt: 'a window cleaning hero with sunlit glass, golden hour',
    });
    const hit = cache.get(SAMPLE_KEY);
    expect(hit?.revisedPrompt).toBe('a window cleaning hero with sunlit glass, golden hour');
  });

  it('different prompts produce independent entries', () => {
    const cache = makeImageCache(dir);
    cache.put(SAMPLE_KEY, {
      dataUrl: SAMPLE_DATA_URL,
      mimeType: 'image/png',
      model: 'gpt-image-1',
      provider: 'openai',
    });
    expect(cache.get({ ...SAMPLE_KEY, prompt: 'totally different' })).toBeNull();
  });
});
