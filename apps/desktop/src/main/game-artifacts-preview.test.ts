import type { AnimationArtifactMetadata, SpriteArtifactMetadata } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { createAnimationBinding, createGameArtifact } from './game-artifacts-db';
import {
  buildAnimationPreviewManifest,
  buildSpritePreviewManifest,
} from './game-artifacts-preview';
import { makeGameFilesSynthesizer } from './game-files-synthesize';
import { createDesign, createSnapshot, initInMemoryDb } from './snapshots-db';

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
  // Pin the engine via a snapshot so getEnginePin returns 'three'.
  createSnapshot(db, {
    designId: design.id,
    type: 'initial',
    artifactType: 'game',
    artifactSource: '',
    prompt: null,
    parentId: null,
    engine: 'three',
  });
  const sprite = createGameArtifact(db, {
    designId: design.id,
    kind: 'sprite',
    name: 'Hero',
    metadata: SPRITE_META,
    primaryFilePath: 'assets/sprites/hero/sprite.png',
    fileRefs: [{ path: 'assets/sprites/hero/sprite.png', role: 'texture' }],
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
  return { db, designId: design.id, spriteId: sprite.id, animationId: anim.id };
}

describe('buildSpritePreviewManifest', () => {
  it('returns a manifest with file URLs anchored at game-files://', () => {
    const { db, designId, spriteId } = setup();
    const manifest = buildSpritePreviewManifest(db, designId, spriteId);
    expect(manifest).not.toBeNull();
    expect(manifest?.engine).toBe('three');
    expect(manifest?.sprite?.files[0]?.url).toBe(
      `game-files://designs/${designId}/assets/sprites/hero/sprite.png`,
    );
  });

  it('returns null for an unknown artifact', () => {
    const { db, designId } = setup();
    expect(buildSpritePreviewManifest(db, designId, 'does-not-exist')).toBeNull();
  });
});

describe('buildAnimationPreviewManifest', () => {
  it('returns the bound sprite + animation pair with binding status', () => {
    const { db, designId, animationId, spriteId } = setup();
    const manifest = buildAnimationPreviewManifest(db, designId, animationId, spriteId);
    expect(manifest?.animation?.binding.bindingStatus).toBe('compatible');
    expect(manifest?.animation?.files[0]?.path).toBe('assets/animations/walk/clip.json');
  });

  it('marks the binding as broken when the sprite is not bound to the animation', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const sprite = createGameArtifact(db, {
      designId: design.id,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const anim = createGameArtifact(db, {
      designId: design.id,
      kind: 'animation',
      name: 'Walk',
      metadata: ANIM_META,
      fileRefs: [],
    });
    const manifest = buildAnimationPreviewManifest(db, design.id, anim.id, sprite.id);
    expect(manifest?.animation?.binding.bindingStatus).toBe('broken');
  });
});

describe('synthesized __preview/* paths', () => {
  it('serves a preview HTML shell containing the artifact id', () => {
    const { db, designId, spriteId } = setup();
    const synth = makeGameFilesSynthesizer(db);
    const params = new URLSearchParams({ artifactId: spriteId });
    const result = synth(designId, '__preview/sprite.html', params);
    expect(result).not.toBeNull();
    const decoded = new TextDecoder().decode(result?.body);
    expect(decoded).toContain(spriteId);
    expect(result?.contentType).toBe('text/html');
  });

  it('serves the manifest JSON for sprite mode', () => {
    const { db, designId, spriteId } = setup();
    const synth = makeGameFilesSynthesizer(db);
    const params = new URLSearchParams({ mode: 'sprite', artifactId: spriteId });
    const result = synth(designId, '__preview/manifest.json', params);
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe('application/json');
    const parsed = JSON.parse(new TextDecoder().decode(result?.body));
    expect(parsed.mode).toBe('sprite');
    expect(parsed.sprite.id).toBe(spriteId);
  });

  it('serves the manifest JSON for animation mode and includes the binding', () => {
    const { db, designId, spriteId, animationId } = setup();
    const synth = makeGameFilesSynthesizer(db);
    const params = new URLSearchParams({
      mode: 'animation',
      artifactId: animationId,
      spriteId,
    });
    const result = synth(designId, '__preview/manifest.json', params);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(result?.body));
    expect(parsed.animation.binding.spriteId).toBe(spriteId);
  });

  it('returns null when artifactId is missing', () => {
    const { db, designId } = setup();
    const synth = makeGameFilesSynthesizer(db);
    const params = new URLSearchParams();
    expect(synth(designId, '__preview/sprite.html', params)).toBeNull();
  });
});
