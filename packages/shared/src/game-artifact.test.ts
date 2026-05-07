import { describe, expect, it } from 'vitest';
import {
  AnimationArtifactMetadata,
  GameArtifactMetadata,
  SpriteArtifactMetadata,
  aliasForArtifact,
  extractArtifactAliases,
  parseArtifactAlias,
  slugifyArtifactName,
} from './game-artifact';

describe('slugifyArtifactName', () => {
  it('trims, lowercases and hyphenates whitespace', () => {
    expect(slugifyArtifactName('  Hero Knight  ')).toBe('hero-knight');
    expect(slugifyArtifactName('Heavy Attack 02')).toBe('heavy-attack-02');
  });

  it('falls back to "artifact" on empty / numeric-only input', () => {
    expect(slugifyArtifactName('')).toBe('artifact');
    expect(slugifyArtifactName('   ')).toBe('artifact');
    expect(slugifyArtifactName('42')).toBe('artifact-42');
  });
});

describe('parseArtifactAlias / aliasForArtifact', () => {
  it('round-trips sprite and animation aliases', () => {
    expect(aliasForArtifact('sprite', 'hero-knight')).toBe('@sprite:hero-knight');
    expect(parseArtifactAlias('@sprite:hero-knight')).toEqual({
      kind: 'sprite',
      slug: 'hero-knight',
    });
    expect(parseArtifactAlias('@animation:run-cycle-2')).toEqual({
      kind: 'animation',
      slug: 'run-cycle-2',
    });
  });

  it('returns null for non-aliases', () => {
    expect(parseArtifactAlias('@sprite:')).toBeNull();
    expect(parseArtifactAlias('plain text')).toBeNull();
    expect(parseArtifactAlias('@foo:bar')).toBeNull();
  });
});

describe('extractArtifactAliases', () => {
  it('pulls aliases from prose, dedups, preserves order', () => {
    const out = extractArtifactAliases(
      'Apply @animation:walk to @sprite:mage and also @sprite:mage and @animation:walk again.',
    );
    expect(out).toEqual([
      { kind: 'animation', slug: 'walk' },
      { kind: 'sprite', slug: 'mage' },
    ]);
  });

  it('returns empty array when no aliases', () => {
    expect(extractArtifactAliases('make this sprite bulkier')).toEqual([]);
  });
});

describe('SpriteArtifactMetadata', () => {
  it('parses a minimal sprite metadata object', () => {
    const parsed = SpriteArtifactMetadata.parse({
      version: 1,
      kind: 'sprite',
      visualType: '2d-sprite',
      tags: [],
      frameCount: 1,
    });
    expect(parsed.kind).toBe('sprite');
    expect(parsed.visualType).toBe('2d-sprite');
  });

  it('rejects animation kind on a sprite schema', () => {
    expect(() =>
      SpriteArtifactMetadata.parse({
        version: 1,
        kind: 'animation',
        visualType: '2d-sprite',
      }),
    ).toThrow();
  });
});

describe('AnimationArtifactMetadata', () => {
  it('parses a minimal animation metadata object', () => {
    const parsed = AnimationArtifactMetadata.parse({
      version: 1,
      kind: 'animation',
      animationType: 'frame-sequence',
      durationMs: 800,
      loop: true,
    });
    expect(parsed.animationType).toBe('frame-sequence');
    expect(parsed.durationMs).toBe(800);
  });

  it('rejects non-positive durations', () => {
    expect(() =>
      AnimationArtifactMetadata.parse({
        version: 1,
        kind: 'animation',
        animationType: 'frame-sequence',
        durationMs: 0,
      }),
    ).toThrow();
  });
});

describe('GameArtifactMetadata discriminated union', () => {
  it('routes sprite metadata to the sprite schema', () => {
    const parsed = GameArtifactMetadata.parse({
      version: 1,
      kind: 'sprite',
      visualType: 'model-3d',
      tags: ['humanoid'],
    });
    expect(parsed.kind).toBe('sprite');
  });

  it('routes animation metadata to the animation schema', () => {
    const parsed = GameArtifactMetadata.parse({
      version: 1,
      kind: 'animation',
      animationType: 'skeletal',
      durationMs: 1500,
      loop: false,
    });
    expect(parsed.kind).toBe('animation');
  });
});
