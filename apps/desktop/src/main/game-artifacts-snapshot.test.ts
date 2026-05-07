/**
 * Integration test for the snapshot path on game-mode designs:
 *  - assets/sprites/<slug>/* directories get indexed into game_artifacts
 *  - the registry file is regenerated to mirror the registry
 *  - snapshot capture stores the artifact rows + bindings
 *
 * We mock electron-runtime so registerSnapshotsIpc collects handlers
 * we can call directly with the in-memory DB.
 */

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

vi.mock('./design-workspace', () => ({
  bindWorkspace: vi.fn(),
  openWorkspaceFolder: vi.fn(),
  checkWorkspaceFolderExists: vi.fn(),
}));

import { listGameArtifacts } from './game-artifacts-db';
import { createDesign, initInMemoryDb, listDesignFiles, upsertDesignFile } from './snapshots-db';
import { registerSnapshotsIpc, registerWorkspaceIpc } from './snapshots-ipc';

let db: ReturnType<typeof initInMemoryDb>;

beforeEach(() => {
  handlers.clear();
  db = initInMemoryDb();
  registerSnapshotsIpc(db);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  registerWorkspaceIpc(db, () => ({}) as any);
});

describe('snapshots:v1:create + game artifacts integration', () => {
  it('indexes new asset directories and includes them in the resulting registry', () => {
    const design = createDesign(db, 'fixture');
    upsertDesignFile(
      db,
      design.id,
      'assets/sprites/hero/sprite.png',
      'data:base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
    );
    upsertDesignFile(db, design.id, 'index.html', '<html></html>');
    const fn = handlers.get('snapshots:v1:create');
    if (!fn) throw new Error('snapshots:v1:create handler not registered');
    fn(null, {
      schemaVersion: 1,
      designId: design.id,
      type: 'initial',
      artifactType: 'game',
      artifactSource: '<html></html>',
      prompt: null,
      parentId: null,
      engine: 'three',
    });
    const sprites = listGameArtifacts(db, design.id, { kind: 'sprite' });
    expect(sprites).toHaveLength(1);
    expect(sprites[0]?.slug).toBe('hero');

    const registry = listDesignFiles(db, design.id).find(
      (f) => f.path === 'assets/artifacts.registry.json',
    );
    expect(registry).toBeDefined();
    const parsed = JSON.parse(registry?.content ?? '{}');
    expect(parsed.sprites).toHaveLength(1);
  });

  it('skips indexing for design-mode (artifactType=html) snapshots', () => {
    const design = createDesign(db, 'fixture');
    // Even a path that LOOKS like an asset dir should not be indexed
    // when this is a design-mode snapshot.
    upsertDesignFile(db, design.id, 'assets/sprites/foo/sprite.png', 'data:base64,iVBORw0KGgo=');
    const fn = handlers.get('snapshots:v1:create');
    if (!fn) throw new Error('snapshots:v1:create handler not registered');
    fn(null, {
      schemaVersion: 1,
      designId: design.id,
      type: 'initial',
      artifactType: 'html',
      artifactSource: '<html></html>',
      prompt: null,
      parentId: null,
    });
    expect(listGameArtifacts(db, design.id)).toHaveLength(0);
  });
});
