import { describe, expect, it } from 'vitest';
import { findInFlightDuplicate, generateDedupKey, hashContentKey } from './generate-dedup';

describe('generateDedupKey', () => {
  it('uses designId, prompt, and attachments to disambiguate', () => {
    const a = generateDedupKey({ designId: 'd1', prompt: 'hi', attachments: [] });
    const b = generateDedupKey({ designId: 'd1', prompt: 'hi', attachments: [] });
    expect(a).toBe(b);
  });

  it('different designs do not collide on the same prompt', () => {
    const a = generateDedupKey({ designId: 'd1', prompt: 'hi', attachments: [] });
    const b = generateDedupKey({ designId: 'd2', prompt: 'hi', attachments: [] });
    expect(a).not.toBe(b);
  });

  it('omitted designId falls back to a stable sentinel', () => {
    const a = generateDedupKey({ prompt: 'hi', attachments: [] });
    const b = generateDedupKey({ designId: undefined, prompt: 'hi', attachments: [] });
    expect(a).toBe(b);
  });

  it('attachment list ordering matters (no normalization)', () => {
    const a = generateDedupKey({ prompt: 'p', attachments: [{ name: 'a' }, { name: 'b' }] });
    const b = generateDedupKey({ prompt: 'p', attachments: [{ name: 'b' }, { name: 'a' }] });
    expect(a).not.toBe(b);
  });
});

describe('hashContentKey', () => {
  it('is deterministic for the same input', () => {
    expect(hashContentKey('abc')).toBe(hashContentKey('abc'));
  });

  it('returns short hex output (no prompt text leaks into logs)', () => {
    const hash = hashContentKey('a very long prompt with lots of detail in it');
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash.length).toBeLessThanOrEqual(8);
  });
});

describe('findInFlightDuplicate', () => {
  it('returns undefined when no in-flight match exists', () => {
    expect(
      findInFlightDuplicate({
        generationId: 'gen-new',
        contentKey: 'k',
        inFlightById: new Map(),
        inFlightContentToId: new Map(),
      }),
    ).toBeUndefined();
  });

  it('matches by generationId first (a duplicate IPC of the same submit)', () => {
    const promise = Promise.resolve('result');
    expect(
      findInFlightDuplicate({
        generationId: 'gen-1',
        contentKey: 'unrelated',
        inFlightById: new Map([['gen-1', promise]]),
        inFlightContentToId: new Map(),
      }),
    ).toBe(promise);
  });

  it('falls back to content key (double-click with distinct generationIds)', () => {
    const promise = Promise.resolve('result');
    expect(
      findInFlightDuplicate({
        generationId: 'gen-second-click',
        contentKey: 'k',
        inFlightById: new Map([['gen-first-click', promise]]),
        inFlightContentToId: new Map([['k', 'gen-first-click']]),
      }),
    ).toBe(promise);
  });

  it('does NOT match its own generationId via content key (would loop)', () => {
    const promise = Promise.resolve('result');
    // generationId 'gen-1' both has its own entry AND points at itself in
    // the content map (the registered case). Looking up the same id should
    // hit the by-id path, not the content-fallback self-loop.
    expect(
      findInFlightDuplicate({
        generationId: 'gen-1',
        contentKey: 'k',
        inFlightById: new Map([['gen-1', promise]]),
        inFlightContentToId: new Map([['k', 'gen-1']]),
      }),
    ).toBe(promise);
  });

  it('returns undefined when content map points at a stale id no longer in the by-id map', () => {
    expect(
      findInFlightDuplicate({
        generationId: 'gen-new',
        contentKey: 'k',
        inFlightById: new Map(),
        inFlightContentToId: new Map([['k', 'gen-cleared']]),
      }),
    ).toBeUndefined();
  });
});
