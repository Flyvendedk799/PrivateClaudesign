/**
 * gameplan §7.2 — `game-files://` protocol tests.
 *
 * Exercises the pure resolver `resolveGameFilesRequest` against an in-memory
 * better-sqlite3 instance. Electron isn't booted; the actual `protocol.handle`
 * wrapping is a thin shim around the resolver and is exercised manually.
 */

import { describe, expect, it } from 'vitest';
import {
  GAME_FILES_PRIVILEGED_SCHEME,
  GAME_FILES_SCHEME,
  gameFilesResponseHeaders,
  parseGameFilesUrl,
  resolveGameFilesRequest,
} from './game-files-protocol';
import { createDesign, initInMemoryDb, upsertDesignFile } from './snapshots-db';

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

describe('parseGameFilesUrl', () => {
  it('parses the canonical shape', () => {
    expect(parseGameFilesUrl('game-files://designs/abc-123/index.html')).toEqual({
      designId: 'abc-123',
      path: 'index.html',
      isBuild: false,
    });
  });

  it('parses nested asset paths', () => {
    expect(parseGameFilesUrl('game-files://designs/abc-123/assets/sprites/player.png')).toEqual({
      designId: 'abc-123',
      path: 'assets/sprites/player.png',
      isBuild: false,
    });
  });

  it('parses the _build/ namespace and flags it', () => {
    expect(parseGameFilesUrl('game-files://designs/abc-123/_build/index.html')).toEqual({
      designId: 'abc-123',
      path: 'index.html',
      isBuild: true,
    });
  });

  it('rejects path traversal attempts', () => {
    expect(parseGameFilesUrl('game-files://designs/abc-123/../secret')).toBeNull();
    expect(parseGameFilesUrl('game-files://designs/abc-123/assets/../../escape')).toBeNull();
  });

  it('rejects the wrong protocol', () => {
    expect(parseGameFilesUrl('https://designs/abc-123/index.html')).toBeNull();
    expect(parseGameFilesUrl('file:///abc-123/index.html')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(parseGameFilesUrl('not-a-url')).toBeNull();
    // empty designId
    expect(parseGameFilesUrl('game-files://designs//index.html')).toBeNull();
    // empty path
    expect(parseGameFilesUrl('game-files://designs/abc-123/')).toBeNull();
    expect(parseGameFilesUrl('game-files://designs/abc-123')).toBeNull();
    // wrong host segment
    expect(parseGameFilesUrl('game-files://snapshots/abc-123/index.html')).toBeNull();
  });
});

describe('resolveGameFilesRequest', () => {
  it('returns the file content with the correct MIME on a hit', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    upsertDesignFile(db, d.id, 'index.html', '<!doctype html><body>hello</body>');
    const res = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${d.id}/index.html`,
      db,
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/html');
    expect(decode(res.body)).toBe('<!doctype html><body>hello</body>');
    expect(res.crossOriginIsolated).toBe(false);
  });

  it('decodes base64-sentinel binary content into a real Uint8Array', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    // 1×1 transparent PNG
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
    upsertDesignFile(db, d.id, 'assets/pixel.png', `data:base64,${pngBase64}`);
    const res = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${d.id}/assets/pixel.png`,
      db,
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/png');
    // Real PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(res.body[0]).toBe(0x89);
    expect(res.body[1]).toBe(0x50);
    expect(res.body[2]).toBe(0x4e);
    expect(res.body[3]).toBe(0x47);
  });

  it('serves engine-specific text MIME types correctly', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    upsertDesignFile(db, d.id, 'main.py', 'import pygame\npygame.init()');
    upsertDesignFile(db, d.id, 'player.gd', 'extends CharacterBody2D');
    upsertDesignFile(db, d.id, 'project.godot', '[application]\nname="Game"');

    const py = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${d.id}/main.py`,
      db,
    });
    expect(py.contentType).toBe('text/x-python');
    expect(decode(py.body)).toContain('pygame');

    const gd = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${d.id}/player.gd`,
      db,
    });
    expect(gd.contentType).toBe('text/x-gdscript');
    expect(decode(gd.body)).toContain('CharacterBody2D');

    const godot = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${d.id}/project.godot`,
      db,
    });
    expect(godot.contentType).toBe('text/plain');
  });

  it('returns 404 on a missing design_files row', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    const res = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${d.id}/missing.html`,
      db,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 on a malformed URL', () => {
    const db = initInMemoryDb();
    const res = resolveGameFilesRequest({
      rawUrl: 'not-a-url',
      db,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 with COOP/COEP flagged for _build/ paths in Phase A (no Godot web export yet)', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    const res = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${d.id}/_build/index.html`,
      db,
    });
    expect(res.status).toBe(404);
    expect(res.crossOriginIsolated).toBe(true);
  });

  it('cannot read another design even when the URL claims a different designId', () => {
    // The (designId, path) primary key on design_files is the actual
    // authorisation boundary — a URL claiming designId B never resolves a
    // row keyed by designId A. URL traversal can't fake the host segment.
    const db = initInMemoryDb();
    const a = createDesign(db);
    const b = createDesign(db);
    upsertDesignFile(db, a.id, 'secret.html', 'design A only');
    const res = resolveGameFilesRequest({
      rawUrl: `game-files://designs/${b.id}/secret.html`,
      db,
    });
    expect(res.status).toBe(404);
  });
});

describe('gameFilesResponseHeaders', () => {
  it('always sets cache-control: no-store and the cross-origin-resource-policy', () => {
    const headers = gameFilesResponseHeaders({
      status: 200,
      contentType: 'text/html',
      body: new Uint8Array(),
      crossOriginIsolated: false,
    });
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(headers['cross-origin-opener-policy']).toBeUndefined();
    expect(headers['cross-origin-embedder-policy']).toBeUndefined();
  });

  it('adds COOP+COEP when crossOriginIsolated is set (Godot web export prep)', () => {
    const headers = gameFilesResponseHeaders({
      status: 200,
      contentType: 'application/wasm',
      body: new Uint8Array(),
      crossOriginIsolated: true,
    });
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });
});

describe('GAME_FILES_PRIVILEGED_SCHEME', () => {
  it('matches the gameplan §7.2 privilege block', () => {
    expect(GAME_FILES_PRIVILEGED_SCHEME).toEqual({
      scheme: GAME_FILES_SCHEME,
      privileges: {
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: false,
        standard: true,
      },
    });
  });
});
