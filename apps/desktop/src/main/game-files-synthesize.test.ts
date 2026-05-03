/**
 * gameplan A6.x — synthesizer tests. Exercises makeGameFilesSynthesizer
 * against an in-memory DB with a registered runtime adapter.
 */

import { describe, expect, it } from 'vitest';
import { makeGameFilesSynthesizer } from './game-files-synthesize';
import { createDesign, createSnapshot, initInMemoryDb, upsertDesignFile } from './snapshots-db';

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

describe('makeGameFilesSynthesizer', () => {
  it('returns null for a design with no engine pin (design-mode design)', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: 'a landing page',
      artifactType: 'html',
      artifactSource: '<html/>',
    });
    const synth = makeGameFilesSynthesizer(db);
    expect(synth(d.id, 'index.html')).toBeNull();
    expect(synth(d.id, 'manifest.json')).toBeNull();
  });

  it('returns null for engine !== pygame (synthesizer only handles pygame)', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: 'a 3D scene',
      artifactType: 'game',
      artifactSource: '<html/>',
      engine: 'three',
    });
    expect(makeGameFilesSynthesizer(db)(d.id, 'index.html')).toBeNull();
  });

  it('synthesizes a Pyodide-bootstrap index.html for pygame designs', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: 'pong in pygame',
      artifactType: 'game',
      artifactSource: '',
      engine: 'pygame',
      engineVersion: '2.5.5',
    });
    const synth = makeGameFilesSynthesizer(db);
    const result = synth(d.id, 'index.html');
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.contentType).toBe('text/html');
    const html = decode(result.body);
    expect(html).toContain('Loading Pygame runtime');
    expect(html).toContain('pygame-ce==2.5.5');
    expect(html).toContain(`game-files://designs/${d.id}/`);
  });

  it('synthesizes a manifest.json listing every project .py + asset for pygame designs', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: 'a roguelike',
      artifactType: 'game',
      artifactSource: '',
      engine: 'pygame',
    });
    upsertDesignFile(db, d.id, 'main.py', 'import pygame\npygame.init()');
    upsertDesignFile(db, d.id, 'entities/player.py', 'class Player: pass');
    upsertDesignFile(db, d.id, 'assets/sprites/hero.png', 'data:base64,iVBORw0KGgo=');
    const synth = makeGameFilesSynthesizer(db);
    const result = synth(d.id, 'manifest.json');
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.contentType).toBe('application/json');
    const list = JSON.parse(decode(result.body)) as string[];
    expect(list).toContain('main.py');
    expect(list).toContain('entities/player.py');
    expect(list).toContain('assets/sprites/hero.png');
  });

  it('returns null for paths the synthesizer does not handle', () => {
    const db = initInMemoryDb();
    const d = createDesign(db);
    createSnapshot(db, {
      designId: d.id,
      parentId: null,
      type: 'initial',
      prompt: 'pong',
      artifactType: 'game',
      artifactSource: '',
      engine: 'pygame',
    });
    const synth = makeGameFilesSynthesizer(db);
    expect(synth(d.id, 'main.py')).toBeNull();
    expect(synth(d.id, 'assets/sprite.png')).toBeNull();
  });
});
