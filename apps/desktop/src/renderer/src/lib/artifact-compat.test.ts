import type {
  AnimationArtifactMetadata,
  GameArtifact,
  SpriteArtifactMetadata,
} from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { classifyAnimationCompat } from './artifact-compat';

const SPRITE_2D: SpriteArtifactMetadata = {
  version: 1,
  kind: 'sprite',
  visualType: '2d-sprite',
  tags: [],
  frameCount: 4,
};
const SPRITE_3D: SpriteArtifactMetadata = {
  version: 1,
  kind: 'sprite',
  visualType: 'model-3d',
  tags: [],
  frameCount: 1,
  skeleton: { rigId: 'humanoid', boneNames: ['root'], restPoseHash: 'abc' },
};
const ANIM_FRAME: AnimationArtifactMetadata = {
  version: 1,
  kind: 'animation',
  animationType: 'frame-sequence',
  durationMs: 800,
  loop: true,
  tags: [],
  requiredTags: [],
  channels: [],
};
const ANIM_SKELETAL: AnimationArtifactMetadata = {
  version: 1,
  kind: 'animation',
  animationType: 'skeletal',
  durationMs: 1500,
  loop: true,
  requiredRigHash: 'abc',
  tags: [],
  requiredTags: [],
  channels: [],
};

function makeSprite(meta: SpriteArtifactMetadata, files = 1): GameArtifact {
  return {
    schemaVersion: 1,
    id: 's',
    designId: 'd',
    kind: 'sprite',
    name: 'Hero',
    slug: 'hero',
    promptAlias: '@sprite:hero',
    status: 'ready',
    engine: null,
    primaryFilePath: null,
    previewFilePath: null,
    thumbnailPath: null,
    metadata: meta,
    provenance: { source: 'agent' },
    files: Array.from({ length: files }).map((_, i) => ({
      id: `f${i}`,
      artifactId: 's',
      designId: 'd',
      path: `assets/sprites/hero/${i}.png`,
      role: 'texture',
      createdAt: '2026-05-06T00:00:00Z',
    })),
    createdAt: '2026-05-06T00:00:00Z',
    updatedAt: '2026-05-06T00:00:00Z',
  };
}

function makeAnim(meta: AnimationArtifactMetadata, files = 1): GameArtifact {
  return {
    schemaVersion: 1,
    id: 'a',
    designId: 'd',
    kind: 'animation',
    name: 'Walk',
    slug: 'walk',
    promptAlias: '@animation:walk',
    status: 'ready',
    engine: null,
    primaryFilePath: null,
    previewFilePath: null,
    thumbnailPath: null,
    metadata: meta,
    provenance: { source: 'agent' },
    files: Array.from({ length: files }).map((_, i) => ({
      id: `f${i}`,
      artifactId: 'a',
      designId: 'd',
      path: `assets/animations/walk/${i}.json`,
      role: 'animation',
      createdAt: '2026-05-06T00:00:00Z',
    })),
    createdAt: '2026-05-06T00:00:00Z',
    updatedAt: '2026-05-06T00:00:00Z',
  };
}

describe('classifyAnimationCompat', () => {
  it('matching rig hash → compatible', () => {
    expect(classifyAnimationCompat(makeAnim(ANIM_SKELETAL), makeSprite(SPRITE_3D))).toBe(
      'compatible',
    );
  });

  it('mismatched rig hash → needs_retarget', () => {
    expect(
      classifyAnimationCompat(
        makeAnim({ ...ANIM_SKELETAL, requiredRigHash: 'xyz' }),
        makeSprite(SPRITE_3D),
      ),
    ).toBe('needs_retarget');
  });

  it('frame sequence on 2D sprite → compatible', () => {
    expect(classifyAnimationCompat(makeAnim(ANIM_FRAME), makeSprite(SPRITE_2D))).toBe('compatible');
  });

  it('frame sequence on 3D model → needs_retarget', () => {
    expect(classifyAnimationCompat(makeAnim(ANIM_FRAME), makeSprite(SPRITE_3D))).toBe(
      'needs_retarget',
    );
  });

  it('missing files → broken', () => {
    expect(classifyAnimationCompat(makeAnim(ANIM_FRAME, 0), makeSprite(SPRITE_2D))).toBe('broken');
  });
});
