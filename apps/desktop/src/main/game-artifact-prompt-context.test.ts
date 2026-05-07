import type { AnimationArtifactMetadata, SpriteArtifactMetadata } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { buildGameArtifactContextBlock } from './game-artifact-prompt-context';
import { createAnimationBinding, createGameArtifact } from './game-artifacts-db';
import { createDesign, initInMemoryDb } from './snapshots-db';

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

function setup() {
  const db = initInMemoryDb();
  const design = createDesign(db, 'fixture');
  const sprite = createGameArtifact(db, {
    designId: design.id,
    kind: 'sprite',
    name: 'Hero Knight',
    metadata: SPRITE_META,
    primaryFilePath: 'assets/sprites/hero-knight/sprite.png',
    fileRefs: [{ path: 'assets/sprites/hero-knight/sprite.png', role: 'texture' }],
  });
  const anim = createGameArtifact(db, {
    designId: design.id,
    kind: 'animation',
    name: 'Walk',
    metadata: ANIM_META,
    primaryFilePath: 'assets/animations/walk/clip.json',
    fileRefs: [{ path: 'assets/animations/walk/clip.json', role: 'animation' }],
  });
  createAnimationBinding(db, {
    designId: design.id,
    animationId: anim.id,
    spriteId: sprite.id,
  });
  return { db, designId: design.id, sprite, anim };
}

describe('buildGameArtifactContextBlock', () => {
  it('emits empty block when payload is undefined', () => {
    const { db, designId } = setup();
    const result = buildGameArtifactContextBlock(db, designId, undefined);
    expect(result.block).toBe('');
    expect(result.unresolvedAliases).toEqual([]);
  });

  it('expands selected sprite into a detailed section', () => {
    const { db, designId, sprite } = setup();
    const result = buildGameArtifactContextBlock(db, designId, {
      activeTab: 'sprites',
      selectedSpriteId: sprite.id,
      mentionedAliases: [],
    });
    expect(result.block).toContain('<game_artifact_context>');
    expect(result.block).toContain('active_tab: sprites');
    expect(result.block).toContain('selected_sprite:');
    expect(result.block).toContain('@sprite:hero-knight');
    expect(result.block).toContain('assets/sprites/hero-knight/sprite.png');
  });

  it('resolves explicit @sprite: aliases and surfaces unresolved aliases', () => {
    const { db, designId } = setup();
    const result = buildGameArtifactContextBlock(db, designId, {
      mentionedAliases: ['@sprite:hero-knight', '@sprite:does-not-exist'],
    });
    expect(result.block).toContain('@sprite:hero-knight => ga_sprite_');
    expect(result.block).toContain('@sprite:does-not-exist => UNRESOLVED');
    expect(result.unresolvedAliases).toEqual(['@sprite:does-not-exist']);
  });

  it('includes selected animation with bound_sprite_ids', () => {
    const { db, designId, anim, sprite } = setup();
    const result = buildGameArtifactContextBlock(db, designId, {
      activeTab: 'animations',
      selectedAnimationId: anim.id,
      animationTargetSpriteId: sprite.id,
      mentionedAliases: [],
    });
    expect(result.block).toContain('selected_animation:');
    expect(result.block).toContain(`bound_sprite_ids: [${sprite.id}]`);
  });
});
