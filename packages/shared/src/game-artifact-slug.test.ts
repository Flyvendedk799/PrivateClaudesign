/**
 * may9 Phase 15 — strict slug validator tests.
 *
 * The IPC boundary calls isValidSlug before persisting an artifact;
 * the slugifier above is permissive but the IPC must reject inputs
 * that collide with reserved names or break our path conventions.
 */
import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, isValidSlug } from './game-artifact';

describe('isValidSlug', () => {
  it('accepts a normal slug', () => {
    expect(isValidSlug('hero-knight').ok).toBe(true);
    expect(isValidSlug('run-cycle-01').ok).toBe(true);
    expect(isValidSlug('boss_fight').ok).toBe(true);
  });

  it('rejects empty / non-string', () => {
    expect(isValidSlug('').ok).toBe(false);
    expect(isValidSlug(null).ok).toBe(false);
    expect(isValidSlug(undefined).ok).toBe(false);
  });

  it('rejects when over 64 chars', () => {
    const long = 'a'.repeat(65);
    expect(isValidSlug(long).ok).toBe(false);
    expect(isValidSlug(long).reason).toContain('64');
  });

  it('rejects when leading character is not a lowercase letter', () => {
    expect(isValidSlug('1hero').ok).toBe(false);
    expect(isValidSlug('-hero').ok).toBe(false);
    expect(isValidSlug('_hero').ok).toBe(false);
    expect(isValidSlug('Hero').ok).toBe(false); // uppercase
  });

  it('rejects when characters outside the allowed set appear', () => {
    expect(isValidSlug('hero/knight').ok).toBe(false);
    expect(isValidSlug('hero knight').ok).toBe(false);
    expect(isValidSlug('hero.knight').ok).toBe(false);
    expect(isValidSlug('hero@knight').ok).toBe(false);
  });

  it('rejects reserved slugs (case-insensitive)', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(isValidSlug(reserved).ok).toBe(false);
      expect(isValidSlug(reserved.toUpperCase()).ok).toBe(false);
    }
  });

  it('accepts the longest valid slug (64 chars)', () => {
    const ok = `a${'b'.repeat(63)}`;
    expect(ok.length).toBe(64);
    expect(isValidSlug(ok).ok).toBe(true);
  });
});
