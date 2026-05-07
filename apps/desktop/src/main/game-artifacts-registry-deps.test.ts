import type { AnimationArtifactMetadata, SpriteArtifactMetadata } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { listGameArtifacts } from './game-artifacts-db';
import { buildArtifactRegistryDeps } from './game-artifacts-registry-deps';
import { createDesign, initInMemoryDb, listDesignFiles } from './snapshots-db';

const SPRITE_META: SpriteArtifactMetadata = {
  version: 1,
  kind: 'sprite',
  visualType: '2d-sprite',
  tags: [],
  frameCount: 1,
};
const ANIM_META: AnimationArtifactMetadata = {
  version: 1,
  kind: 'animation',
  animationType: 'frame-sequence',
  durationMs: 800,
  loop: true,
  tags: [],
  requiredTags: [],
  channels: [],
};

describe('buildArtifactRegistryDeps — agent tool wiring', () => {
  it('round-trips a list → create → bind → validate flow', async () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const deps = buildArtifactRegistryDeps(db, design.id);

    expect((await deps.list({})).length).toBe(0);

    const sprite = await deps.create({
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
    });
    expect(sprite.kind).toBe('sprite');
    expect(sprite.alias).toBe('@sprite:hero');

    const anim = await deps.create({
      kind: 'animation',
      name: 'Walk',
      metadata: ANIM_META,
    });

    // Pre-bind, validate flags the unbound animation as an error.
    let report = await deps.validate();
    expect(report.issues.some((i) => i.severity === 'error')).toBe(true);

    const bound = await deps.bindAnimation({
      animationId: anim.id,
      spriteId: sprite.id,
    });
    expect(bound.spriteId).toBe(sprite.id);

    // After binding, no errors remain (warnings about missing files persist).
    report = await deps.validate();
    expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);

    // The registry file is regenerated on each mutation.
    const registry = listDesignFiles(db, design.id).find(
      (f) => f.path === 'assets/artifacts.registry.json',
    );
    expect(registry).toBeDefined();
    const parsed = JSON.parse(registry?.content ?? '{}');
    expect(parsed.animations[0].boundSpriteIds).toContain(sprite.id);
  });

  it('inspect returns full metadata + file refs', async () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const deps = buildArtifactRegistryDeps(db, design.id);
    const sprite = await deps.create({
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      primaryFilePath: 'assets/sprites/hero/sprite.png',
      fileRefs: [{ path: 'assets/sprites/hero/sprite.png', role: 'texture' }],
    });
    const detail = await deps.inspect(sprite.id);
    expect(detail).not.toBeNull();
    expect(detail?.files).toHaveLength(1);
    expect(detail?.metadata['kind']).toBe('sprite');
  });

  it('resolveRef resolves @sprite:slug aliases and falls back to name match', async () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const deps = buildArtifactRegistryDeps(db, design.id);
    await deps.create({
      kind: 'sprite',
      name: 'Hero Knight',
      metadata: SPRITE_META,
    });
    const byAlias = await deps.resolveRef('@sprite:hero-knight');
    expect(byAlias?.name).toBe('Hero Knight');
    const byName = await deps.resolveRef('Hero Knight');
    expect(byName?.id).toBe(byAlias?.id);
    const missing = await deps.resolveRef('nope');
    expect(missing).toBeNull();
  });

  it('update preserves slug + alias on rename', async () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const deps = buildArtifactRegistryDeps(db, design.id);
    const sprite = await deps.create({
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
    });
    const renamed = await deps.update({
      artifactId: sprite.id,
      name: 'Hero Knight',
    });
    expect(renamed.name).toBe('Hero Knight');
    expect(renamed.slug).toBe(sprite.slug);
    expect(renamed.alias).toBe(sprite.alias);
  });
});
