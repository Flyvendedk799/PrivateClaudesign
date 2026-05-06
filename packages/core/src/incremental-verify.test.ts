/**
 * Phase 4 — verify_artifact content-hash memoization.
 *
 * The cache MUST never serve a stale result (different bits → different
 * key → cache miss → fresh parse). Same bits → instant return. This is
 * the "make verification cheap enough to keep on by default" line from
 * the plan — verification stays mandatory at every batch boundary, but
 * a no-op verify costs ~0 ms instead of ~600 ms.
 */

import { describe, expect, it } from 'vitest';
import { VerifyResultCache, hashContent, verifyCacheKey } from './incremental-verify';

describe('hashContent (Phase 4)', () => {
  it('is deterministic — same input produces same hash', () => {
    expect(hashContent('hello world')).toBe(hashContent('hello world'));
  });

  it('disambiguates empty vs single-character vs whitespace', () => {
    const h0 = hashContent('');
    const h1 = hashContent(' ');
    const h2 = hashContent('a');
    expect(new Set([h0, h1, h2]).size).toBe(3);
  });

  it('encodes length so similar small strings cannot collide on the int hash alone', () => {
    // djb2 alone has known collisions on small adjacent inputs; the
    // length suffix breaks them.
    const a = hashContent('aa');
    const b = hashContent('aaa');
    expect(a).not.toBe(b);
  });

  it('produces a printable, key-safe string', () => {
    const h = hashContent('the quick brown fox jumps over the lazy dog');
    expect(typeof h).toBe('string');
    expect(h).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('VerifyResultCache (Phase 4)', () => {
  it('hit on identical key returns the prior value', () => {
    const cache = new VerifyResultCache<{ status: string }>();
    const key = { path: 'index.html', contentHash: hashContent('<html/>'), artifactType: null };
    cache.set(key, { status: 'ok' });
    expect(cache.get(key)).toEqual({ status: 'ok' });
  });

  it('miss on different content hash (the file changed)', () => {
    const cache = new VerifyResultCache<{ status: string }>();
    cache.set(
      { path: 'index.html', contentHash: hashContent('<html/>'), artifactType: 'design' },
      { status: 'ok' },
    );
    expect(
      cache.get({
        path: 'index.html',
        contentHash: hashContent('<html><body/></html>'),
        artifactType: 'design',
      }),
    ).toBeUndefined();
  });

  it('miss on different path even with same hash (different file)', () => {
    const cache = new VerifyResultCache<{ status: string }>();
    const hash = hashContent('<html/>');
    cache.set({ path: 'a.html', contentHash: hash, artifactType: null }, { status: 'ok' });
    expect(cache.get({ path: 'b.html', contentHash: hash, artifactType: null })).toBeUndefined();
  });

  it('miss on different artifactType (game vs design lint differ)', () => {
    const cache = new VerifyResultCache<{ status: string }>();
    const hash = hashContent('<html/>');
    cache.set({ path: 'index.html', contentHash: hash, artifactType: 'design' }, { status: 'ok' });
    expect(
      cache.get({ path: 'index.html', contentHash: hash, artifactType: 'game' }),
    ).toBeUndefined();
  });

  it('LRU evicts the oldest entry past maxEntries', () => {
    const cache = new VerifyResultCache<number>(3);
    const k = (i: number) => ({
      path: `f${i}.html`,
      contentHash: 'h',
      artifactType: null,
    });
    cache.set(k(1), 1);
    cache.set(k(2), 2);
    cache.set(k(3), 3);
    cache.set(k(4), 4);
    expect(cache.get(k(1))).toBeUndefined();
    expect(cache.get(k(4))).toBe(4);
    expect(cache.size()).toBe(3);
  });

  it('access promotes LRU position (oldest evicted = least-recently-used, not least-recently-set)', () => {
    const cache = new VerifyResultCache<number>(2);
    const k = (i: number) => ({
      path: `f${i}.html`,
      contentHash: 'h',
      artifactType: null,
    });
    cache.set(k(1), 1);
    cache.set(k(2), 2);
    // Touch 1 — now 2 is the oldest.
    expect(cache.get(k(1))).toBe(1);
    cache.set(k(3), 3); // evicts 2
    expect(cache.get(k(2))).toBeUndefined();
    expect(cache.get(k(1))).toBe(1);
    expect(cache.get(k(3))).toBe(3);
  });

  it('clear empties the cache', () => {
    const cache = new VerifyResultCache<number>();
    cache.set({ path: 'a', contentHash: 'h', artifactType: null }, 1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('verifyCacheKey (Phase 4)', () => {
  it('produces stable, deterministic strings', () => {
    const k = { path: 'index.html', contentHash: 'abc', artifactType: 'design' as const };
    expect(verifyCacheKey(k)).toBe(verifyCacheKey(k));
  });

  it('encodes a null artifactType as a placeholder so it never silently merges with named types', () => {
    const noType = verifyCacheKey({
      path: 'index.html',
      contentHash: 'abc',
      artifactType: null,
    });
    const designType = verifyCacheKey({
      path: 'index.html',
      contentHash: 'abc',
      artifactType: 'design',
    });
    expect(noType).not.toBe(designType);
  });
});
