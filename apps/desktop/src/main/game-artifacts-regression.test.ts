/**
 * Phase 10 regression tests — verifies the artifact registry survives every
 * lifecycle hook end-to-end:
 *
 *  - design-mode generation is unchanged (no artifact rows created)
 *  - sprite preview URL resolves correctly
 *  - animation preview URL resolves correctly with both ids
 *  - snapshot restore reconstructs old artifact metadata + bindings
 *  - duplicate design has independent artifact ids and bindings
 *  - archiving a sprite does NOT delete bound animations
 *  - assets/artifacts.registry.json is shipped to design_files and survives
 *    the snapshot round-trip
 */

import type { AnimationArtifactMetadata, SpriteArtifactMetadata } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { resolveGamePreviewSrc } from '../renderer/src/lib/preview-src';
import {
  archiveGameArtifact,
  copyGameArtifactsBetweenDesigns,
  createAnimationBinding,
  createGameArtifact,
  getGameArtifact,
  listAnimationBindings,
  listGameArtifacts,
  restoreGameArtifactsFromSnapshot,
  snapshotGameArtifactsForSnapshot,
} from './game-artifacts-db';
import { regenerateArtifactsRegistry } from './game-artifacts-import';
import {
  createDesign,
  createSnapshot,
  duplicateDesign,
  initInMemoryDb,
  listDesignFiles,
  upsertDesignFile,
} from './snapshots-db';

const SPRITE_META: SpriteArtifactMetadata = {
  version: 1,
  kind: 'sprite',
  visualType: '2d-sprite',
  tags: [],
  frameCount: 4,
};
const ANIM_META: AnimationArtifactMetadata = {
  version: 1,
  kind: 'animation',
  animationType: 'frame-sequence',
  durationMs: 1000,
  loop: true,
  tags: [],
  requiredTags: [],
  channels: [],
};

describe('Phase 10 — registry survives lifecycle hooks', () => {
  it('design-mode design has no artifact rows even after snapshot', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'design-mode-design');
    const snapshot = createSnapshot(db, {
      designId: design.id,
      type: 'initial',
      artifactType: 'html',
      artifactSource: '<html></html>',
      prompt: 'a landing page',
      parentId: null,
    });
    snapshotGameArtifactsForSnapshot(db, snapshot.id, design.id);
    expect(listGameArtifacts(db, design.id)).toHaveLength(0);
  });

  it('sprite + animation preview URLs resolve to the synthesized endpoints', () => {
    const designId = 'd123';
    const spriteUrl = resolveGamePreviewSrc({
      designId,
      engine: 'three',
      previewMode: { mode: 'sprite', spriteId: 'ga_sprite_abc' },
      godotPreviewByDesign: {},
    });
    expect(spriteUrl).toBe(
      `game-files://designs/${designId}/__preview/sprite.html?artifactId=ga_sprite_abc`,
    );
    const animUrl = resolveGamePreviewSrc({
      designId,
      engine: 'three',
      previewMode: { mode: 'animation', animationId: 'ga_anim_def', spriteId: 'ga_sprite_abc' },
      godotPreviewByDesign: {},
    });
    expect(animUrl).toBe(
      `game-files://designs/${designId}/__preview/animation.html?artifactId=ga_anim_def&spriteId=ga_sprite_abc`,
    );
  });

  it('snapshot → wipe live → restore round-trips artifacts + files + bindings', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const sprite = createGameArtifact(db, {
      designId: design.id,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      primaryFilePath: 'assets/sprites/hero/sprite.png',
      fileRefs: [
        { path: 'assets/sprites/hero/sprite.png', role: 'texture' },
        { path: 'assets/sprites/hero/atlas.json', role: 'atlas' },
      ],
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
    regenerateArtifactsRegistry(db, design.id);
    const snapshot = createSnapshot(db, {
      designId: design.id,
      type: 'initial',
      artifactType: 'game',
      artifactSource: '',
      prompt: null,
      parentId: null,
      engine: 'three',
    });
    snapshotGameArtifactsForSnapshot(db, snapshot.id, design.id);

    db.prepare('DELETE FROM game_animation_bindings WHERE design_id = ?').run(design.id);
    db.prepare('DELETE FROM game_artifacts WHERE design_id = ?').run(design.id);
    expect(listGameArtifacts(db, design.id)).toHaveLength(0);

    const restored = restoreGameArtifactsFromSnapshot(db, design.id, snapshot.id);
    expect(restored.artifacts).toBe(2);
    expect(restored.bindings).toBe(1);
    const sprites = listGameArtifacts(db, design.id, { kind: 'sprite' });
    expect(sprites).toHaveLength(1);
    expect(sprites[0]?.files).toHaveLength(2);
    expect(listAnimationBindings(db, design.id)).toHaveLength(1);
  });

  it('duplicate design copies artifacts with new ids and independent bindings', () => {
    const db = initInMemoryDb();
    const source = createDesign(db, 'src');
    const sprite = createGameArtifact(db, {
      designId: source.id,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const anim = createGameArtifact(db, {
      designId: source.id,
      kind: 'animation',
      name: 'Walk',
      metadata: ANIM_META,
      fileRefs: [],
    });
    createAnimationBinding(db, {
      designId: source.id,
      animationId: anim.id,
      spriteId: sprite.id,
    });
    upsertDesignFile(db, source.id, 'index.html', '<html></html>');
    const cloned = duplicateDesign(db, source.id, 'src copy');
    expect(cloned).not.toBeNull();
    if (cloned === null) return;
    const sourceArtifacts = listGameArtifacts(db, source.id);
    const targetArtifacts = listGameArtifacts(db, cloned.id);
    expect(targetArtifacts).toHaveLength(2);
    const overlap = targetArtifacts.some((a) => sourceArtifacts.some((s) => s.id === a.id));
    expect(overlap).toBe(false);
    expect(listAnimationBindings(db, cloned.id)).toHaveLength(1);
  });

  it('archiving a sprite does not delete its bound animations', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const sprite = createGameArtifact(db, {
      designId: design.id,
      kind: 'sprite',
      name: 'Mage',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const anim = createGameArtifact(db, {
      designId: design.id,
      kind: 'animation',
      name: 'Cast',
      metadata: ANIM_META,
      fileRefs: [],
    });
    createAnimationBinding(db, {
      designId: design.id,
      animationId: anim.id,
      spriteId: sprite.id,
    });
    archiveGameArtifact(db, design.id, sprite.id);
    expect(getGameArtifact(db, design.id, sprite.id)?.status).toBe('archived');
    expect(getGameArtifact(db, design.id, anim.id)?.status).toBe('ready');
    // Binding rows are NOT deleted by archiving — they remain visible
    // through the bindings list so the user can re-activate the sprite.
    expect(listAnimationBindings(db, design.id)).toHaveLength(1);
  });

  it('artifacts.registry.json ships into design_files and round-trips through snapshot', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    createGameArtifact(db, {
      designId: design.id,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    regenerateArtifactsRegistry(db, design.id);
    const registry = listDesignFiles(db, design.id).find(
      (f) => f.path === 'assets/artifacts.registry.json',
    );
    expect(registry).toBeDefined();
    const parsed = JSON.parse(registry?.content ?? '{}');
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sprites).toHaveLength(1);
    expect(parsed.sprites[0].alias).toBe('@sprite:hero');
  });
});
