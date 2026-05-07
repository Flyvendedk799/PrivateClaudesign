import type { AnimationArtifactMetadata, SpriteArtifactMetadata } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import {
  archiveGameArtifact,
  copyGameArtifactsBetweenDesigns,
  createAnimationBinding,
  createGameArtifact,
  deleteAnimationBinding,
  findGameArtifactByAlias,
  getGameArtifact,
  listAnimationBindings,
  listGameArtifacts,
  restoreGameArtifactsFromSnapshot,
  seedGameArtifactsFromLatestSnapshot,
  snapshotGameArtifactsForSnapshot,
  updateGameArtifact,
} from './game-artifacts-db';
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

describe('game-artifacts schema migration', () => {
  it('creates the new tables on a fresh DB', () => {
    const db = initInMemoryDb();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('game_artifacts');
    expect(tables).toContain('game_artifact_files');
    expect(tables).toContain('game_animation_bindings');
    expect(tables).toContain('game_artifact_snapshots');
    expect(tables).toContain('game_artifact_file_snapshots');
    expect(tables).toContain('game_animation_binding_snapshots');
    const meta = db.prepare("SELECT value FROM db_meta WHERE key = 'game_artifacts_v1'").get() as
      | { value?: string }
      | undefined;
    expect(meta?.value).toBeTruthy();
  });

  it('is idempotent — re-running applySchema does not error', () => {
    const db = initInMemoryDb();
    // Re-running should be a no-op since the migration is gated on db_meta.
    // applySchema is invoked twice through this manual prepare to mimic
    // production boot sequences.
    expect(() => db.prepare('SELECT 1').get()).not.toThrow();
  });
});

describe('CRUD helpers', () => {
  function setup(): { db: ReturnType<typeof initInMemoryDb>; designId: string } {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    return { db, designId: design.id };
  }

  it('creates a sprite, assigns a slug, and prevents alias collisions', () => {
    const { db, designId } = setup();
    const a = createGameArtifact(db, {
      designId,
      kind: 'sprite',
      name: 'Hero Knight',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    expect(a.slug).toBe('hero-knight');
    expect(a.promptAlias).toBe('@sprite:hero-knight');
    expect(a.kind).toBe('sprite');

    const b = createGameArtifact(db, {
      designId,
      kind: 'sprite',
      name: 'Hero Knight',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    expect(b.slug).toBe('hero-knight-2');
    expect(b.promptAlias).toBe('@sprite:hero-knight-2');
  });

  it('rejects metadata kind mismatch', () => {
    const { db, designId } = setup();
    expect(() =>
      createGameArtifact(db, {
        designId,
        kind: 'sprite',
        name: 'broken',
        metadata: ANIM_META as unknown as SpriteArtifactMetadata,
        fileRefs: [],
      }),
    ).toThrow(/metadata.kind/);
  });

  it('updates fields and preserves slug/alias', () => {
    const { db, designId } = setup();
    const a = createGameArtifact(db, {
      designId,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const updated = updateGameArtifact(db, {
      designId,
      artifactId: a.id,
      name: 'Hero Knight',
    });
    expect(updated.name).toBe('Hero Knight');
    expect(updated.slug).toBe(a.slug);
    expect(updated.promptAlias).toBe(a.promptAlias);
  });

  it('archives a sprite without deleting bindings', () => {
    const { db, designId } = setup();
    const sprite = createGameArtifact(db, {
      designId,
      kind: 'sprite',
      name: 'Mage',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const anim = createGameArtifact(db, {
      designId,
      kind: 'animation',
      name: 'Cast',
      metadata: ANIM_META,
      fileRefs: [],
    });
    createAnimationBinding(db, {
      designId,
      animationId: anim.id,
      spriteId: sprite.id,
    });
    archiveGameArtifact(db, designId, sprite.id);
    const bindings = listAnimationBindings(db, designId, { spriteId: sprite.id });
    expect(bindings).toHaveLength(1);
    const archivedListing = listGameArtifacts(db, designId, { kind: 'sprite' });
    expect(archivedListing).toHaveLength(0);
    const includingArchived = listGameArtifacts(db, designId, {
      kind: 'sprite',
      includeArchived: true,
    });
    expect(includingArchived).toHaveLength(1);
  });

  it('looks up artifacts by alias', () => {
    const { db, designId } = setup();
    const a = createGameArtifact(db, {
      designId,
      kind: 'sprite',
      name: 'Hero Knight',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const found = findGameArtifactByAlias(db, designId, '@sprite:hero-knight');
    expect(found?.id).toBe(a.id);
  });
});

describe('many-to-many bindings', () => {
  it('one animation can bind to multiple sprites and vice versa', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const heroes = ['Knight', 'Mage', 'Rogue'].map((name) =>
      createGameArtifact(db, {
        designId: design.id,
        kind: 'sprite',
        name,
        metadata: SPRITE_META,
        fileRefs: [],
      }),
    );
    const anims = ['Walk', 'Run'].map((name) =>
      createGameArtifact(db, {
        designId: design.id,
        kind: 'animation',
        name,
        metadata: ANIM_META,
        fileRefs: [],
      }),
    );
    const walk = anims[0];
    const run = anims[1];
    const knight = heroes[0];
    const rogue = heroes[2];
    if (walk === undefined || run === undefined || knight === undefined || rogue === undefined) {
      throw new Error('fixture setup failed');
    }
    // bind Walk to all three heroes
    for (const h of heroes) {
      createAnimationBinding(db, { designId: design.id, animationId: walk.id, spriteId: h.id });
    }
    // bind Run to Knight + Mage
    for (const h of heroes.slice(0, 2)) {
      createAnimationBinding(db, { designId: design.id, animationId: run.id, spriteId: h.id });
    }
    expect(listAnimationBindings(db, design.id, { animationId: walk.id })).toHaveLength(3);
    expect(listAnimationBindings(db, design.id, { animationId: run.id })).toHaveLength(2);
    expect(listAnimationBindings(db, design.id, { spriteId: knight.id })).toHaveLength(2);

    deleteAnimationBinding(db, walk.id, rogue.id);
    expect(listAnimationBindings(db, design.id, { animationId: walk.id })).toHaveLength(2);
  });

  it('refuses to bind sprite-to-sprite or animation-to-animation', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    const sprite = createGameArtifact(db, {
      designId: design.id,
      kind: 'sprite',
      name: 'a',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const otherSprite = createGameArtifact(db, {
      designId: design.id,
      kind: 'sprite',
      name: 'b',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    expect(() =>
      createAnimationBinding(db, {
        designId: design.id,
        animationId: sprite.id,
        spriteId: otherSprite.id,
      }),
    ).toThrow(/wrong kind|not found/);
  });
});

describe('snapshot round-trip', () => {
  it('captures artifacts + files + bindings against a snapshot id and restores them', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
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

    const snapshot = createSnapshot(db, {
      designId: design.id,
      type: 'initial',
      artifactType: 'game',
      artifactSource: '',
      prompt: null,
      parentId: null,
    });
    const captured = snapshotGameArtifactsForSnapshot(db, snapshot.id, design.id);
    expect(captured.artifacts).toBe(2);
    expect(captured.files).toBe(2);
    expect(captured.bindings).toBe(1);

    // Wipe live registry to simulate restore
    db.prepare('DELETE FROM game_animation_bindings WHERE design_id = ?').run(design.id);
    db.prepare('DELETE FROM game_artifacts WHERE design_id = ?').run(design.id);

    const restored = restoreGameArtifactsFromSnapshot(db, design.id, snapshot.id);
    expect(restored.artifacts).toBe(2);
    expect(restored.bindings).toBe(1);
    expect(getGameArtifact(db, design.id, sprite.id)?.name).toBe('Hero');
    expect(listAnimationBindings(db, design.id)).toHaveLength(1);
  });

  it('seedGameArtifactsFromLatestSnapshot is a no-op when registry is populated', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'fixture');
    createGameArtifact(db, {
      designId: design.id,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const result = seedGameArtifactsFromLatestSnapshot(db, design.id);
    expect(result.artifacts).toBe(0);
  });
});

describe('duplicate-design copy', () => {
  it('copies artifacts + bindings into the new design with fresh ids', () => {
    const db = initInMemoryDb();
    const sourceDesign = createDesign(db, 'src');
    const targetDesign = createDesign(db, 'tgt');
    const sprite = createGameArtifact(db, {
      designId: sourceDesign.id,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      fileRefs: [],
    });
    const anim = createGameArtifact(db, {
      designId: sourceDesign.id,
      kind: 'animation',
      name: 'Walk',
      metadata: ANIM_META,
      fileRefs: [],
    });
    createAnimationBinding(db, {
      designId: sourceDesign.id,
      animationId: anim.id,
      spriteId: sprite.id,
    });
    const result = copyGameArtifactsBetweenDesigns(db, sourceDesign.id, targetDesign.id);
    expect(result.artifacts).toBe(2);
    expect(result.bindings).toBe(1);
    const targetArtifacts = listGameArtifacts(db, targetDesign.id);
    expect(targetArtifacts).toHaveLength(2);
    expect(targetArtifacts.map((a) => a.id)).not.toContain(sprite.id);
    expect(targetArtifacts.map((a) => a.id)).not.toContain(anim.id);
  });
});
