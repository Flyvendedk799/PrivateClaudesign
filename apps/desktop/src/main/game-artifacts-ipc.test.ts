/**
 * IPC tests for game-artifacts:v1:* — verifies the registered handlers
 * round-trip through the in-memory DB and surface CRUD failures as typed
 * CodesignErrors. Mirror of `snapshots-ipc.test.ts` patterns.
 */

import {
  type AnimationArtifactMetadata,
  CodesignError,
  type GameArtifactCreateInput,
  type GameArtifactListResult,
  type SpriteArtifactMetadata,
} from '@open-codesign/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>();

vi.mock('./electron-runtime', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, raw: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('./logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { registerGameArtifactsIpc } from './game-artifacts-ipc';
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

function call<T>(channel: string, raw: unknown): T {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`no handler ${channel}`);
  return fn(null, raw) as T;
}

let db: ReturnType<typeof initInMemoryDb>;
let designId: string;

beforeEach(() => {
  handlers.clear();
  db = initInMemoryDb();
  designId = createDesign(db, 'fixture').id;
  registerGameArtifactsIpc(db);
});

describe('game-artifacts:v1:list', () => {
  it('returns an empty result for a fresh design', () => {
    const result = call<GameArtifactListResult>('game-artifacts:v1:list', {
      schemaVersion: 1,
      designId,
    });
    expect(result.artifacts).toEqual([]);
    expect(result.bindings).toEqual([]);
  });

  it('rejects missing schemaVersion', () => {
    expect(() => call('game-artifacts:v1:list', { designId })).toThrow(CodesignError);
  });
});

describe('game-artifacts:v1:create', () => {
  it('creates a sprite and regenerates the registry file', () => {
    const input: GameArtifactCreateInput = {
      designId,
      kind: 'sprite',
      name: 'Hero',
      metadata: SPRITE_META,
      fileRefs: [],
    };
    const result = call<GameArtifactListResult>('game-artifacts:v1:create', {
      schemaVersion: 1,
      input,
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.kind).toBe('sprite');
    const files = listDesignFiles(db, designId);
    const registry = files.find((f) => f.path === 'assets/artifacts.registry.json');
    expect(registry).toBeDefined();
    const parsed = JSON.parse(registry?.content ?? '{}');
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sprites).toHaveLength(1);
    expect(parsed.animations).toHaveLength(0);
  });

  it('rejects malformed metadata as IPC_BAD_INPUT', () => {
    expect(() =>
      call('game-artifacts:v1:create', {
        schemaVersion: 1,
        input: {
          designId,
          kind: 'sprite',
          name: 'Hero',
          metadata: { kind: 'sprite', visualType: 'unknown' },
          fileRefs: [],
        },
      }),
    ).toThrow(CodesignError);
  });
});

describe('game-artifacts:v1:bind-animation', () => {
  it('binds an animation to a sprite, supports many-to-many, and updates the registry', () => {
    const findBySlug = (list: GameArtifactListResult, slug: string) => {
      const match = list.artifacts.find((a) => a.slug === slug);
      if (match === undefined) throw new Error(`no artifact with slug ${slug}`);
      return match;
    };
    call('game-artifacts:v1:create', {
      schemaVersion: 1,
      input: {
        designId,
        kind: 'sprite',
        name: 'Mage',
        metadata: SPRITE_META,
        fileRefs: [],
      },
    });
    call('game-artifacts:v1:create', {
      schemaVersion: 1,
      input: {
        designId,
        kind: 'sprite',
        name: 'Knight',
        metadata: SPRITE_META,
        fileRefs: [],
      },
    });
    const seeded = call<GameArtifactListResult>('game-artifacts:v1:create', {
      schemaVersion: 1,
      input: {
        designId,
        kind: 'animation',
        name: 'Cast',
        metadata: ANIM_META,
        fileRefs: [],
      },
    });
    const sprite = findBySlug(seeded, 'mage');
    const sprite2 = findBySlug(seeded, 'knight');
    const anim = findBySlug(seeded, 'cast');
    call('game-artifacts:v1:bind-animation', {
      schemaVersion: 1,
      designId,
      animationId: anim.id,
      spriteId: sprite.id,
    });
    const result = call<GameArtifactListResult>('game-artifacts:v1:bind-animation', {
      schemaVersion: 1,
      designId,
      animationId: anim.id,
      spriteId: sprite2.id,
    });
    expect(result.bindings).toHaveLength(2);
    const registry = JSON.parse(
      listDesignFiles(db, designId).find((f) => f.path === 'assets/artifacts.registry.json')
        ?.content ?? '{}',
    );
    expect(registry.animations[0].boundSpriteIds).toHaveLength(2);
  });
});

describe('game-artifacts:v1:resolve-prompt-ref', () => {
  it('resolves an alias back to the artifact', () => {
    call('game-artifacts:v1:create', {
      schemaVersion: 1,
      input: {
        designId,
        kind: 'sprite',
        name: 'Hero Knight',
        metadata: SPRITE_META,
        fileRefs: [],
      },
    });
    const result = call<{ artifact: { slug: string } | null; kind?: string; slug?: string }>(
      'game-artifacts:v1:resolve-prompt-ref',
      {
        schemaVersion: 1,
        designId,
        refText: '@sprite:hero-knight',
      },
    );
    expect(result.artifact?.slug).toBe('hero-knight');
    expect(result.kind).toBe('sprite');
  });

  it('returns null artifact for an unknown alias', () => {
    const result = call<{ artifact: unknown }>('game-artifacts:v1:resolve-prompt-ref', {
      schemaVersion: 1,
      designId,
      refText: '@sprite:does-not-exist',
    });
    expect(result.artifact).toBeNull();
  });
});

describe('game-artifacts:v1:import-files', () => {
  it('blocks animation import without a target sprite', () => {
    expect(() =>
      call('game-artifacts:v1:import-files', {
        schemaVersion: 1,
        designId,
        kind: 'animation',
        files: [{ relativePath: 'walk.json', content: '{"frames": []}' }],
      }),
    ).toThrow(CodesignError);
  });

  it('imports a PNG sprite under assets/sprites/<slug>/...', () => {
    const result = call<GameArtifactListResult>('game-artifacts:v1:import-files', {
      schemaVersion: 1,
      designId,
      kind: 'sprite',
      name: 'Hero',
      files: [
        {
          relativePath: 'hero.png',
          // Minimal valid PNG header so the dimension inference path
          // doesn't throw — the import doesn't require a valid IHDR.
          content:
            'data:base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
        },
      ],
    });
    expect(result.artifacts).toHaveLength(1);
    const sprite = result.artifacts[0];
    if (sprite === undefined) throw new Error('artifact[0] missing after length=1 assertion');
    expect(sprite.primaryFilePath).toBe('assets/sprites/hero/hero.png');
    expect(sprite.files).toHaveLength(1);
    expect(sprite.files[0]?.role).toBe('texture');
  });
});
