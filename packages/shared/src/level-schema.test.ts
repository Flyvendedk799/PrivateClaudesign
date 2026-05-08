import { describe, expect, it } from 'vitest';
import {
  LEVEL_DOC_SCHEMA_VERSION,
  LevelDoc,
  LevelDocKind,
  LevelSchemaDeclaration,
  WORLD_DOC_SCHEMA_VERSION,
  WorldDoc,
  inferLevelKind,
} from './level-schema';

describe('LevelDoc', () => {
  it('parses a minimal tilemap-2d level', () => {
    const doc = LevelDoc.parse({
      schemaVersion: LEVEL_DOC_SCHEMA_VERSION,
      kind: 'tilemap-2d',
      size: { cols: 10, rows: 8 },
      layers: [{ name: 'base', tiles: [[0]] }],
    });
    expect(doc.kind).toBe('tilemap-2d');
    if (doc.kind === 'tilemap-2d') {
      expect(doc.tileSize).toBe(16);
      expect(doc.entities).toEqual([]);
      expect(doc.spawns).toEqual([]);
    }
  });

  it('parses a scene-3d level with default rotation/scale', () => {
    const doc = LevelDoc.parse({
      schemaVersion: 1,
      kind: 'scene-3d',
      bounds: { min: [-50, 0, -50], max: [50, 10, 50] },
      nodes: [
        {
          id: 'wall-1',
          type: 'wall',
          transform: { position: [0, 1, 0] },
          properties: {},
        },
      ],
    });
    expect(doc.kind).toBe('scene-3d');
    if (doc.kind === 'scene-3d') {
      expect(doc.nodes[0]?.transform.rotation).toEqual([0, 0, 0]);
      expect(doc.nodes[0]?.transform.scale).toEqual([1, 1, 1]);
    }
  });

  it('parses a node-graph level', () => {
    const doc = LevelDoc.parse({
      schemaVersion: 1,
      kind: 'node-graph',
      nodes: [
        { id: 'n1', type: 'dialogue', position: { x: 0, y: 0 }, payload: {} },
        { id: 'n2', type: 'choice', position: { x: 100, y: 50 }, payload: {} },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', payload: {} }],
      startNodeId: 'n1',
    });
    expect(doc.kind).toBe('node-graph');
  });

  it('parses a wave-script level', () => {
    const doc = LevelDoc.parse({
      schemaVersion: 1,
      kind: 'wave-script',
      waves: [
        {
          id: 'w1',
          startMs: 0,
          spawns: [{ enemyType: 'grunt', count: 4 }],
        },
      ],
    });
    expect(doc.kind).toBe('wave-script');
    if (doc.kind === 'wave-script') {
      expect(doc.waves[0]?.spawns[0]?.delayMs).toBe(0);
      expect(doc.waves[0]?.completionRule).toBe('all-killed');
    }
  });

  it('accepts freeform-json with arbitrary data', () => {
    const doc = LevelDoc.parse({
      schemaVersion: 1,
      kind: 'freeform-json',
      data: { whatever: ['yes'], goes: { here: 1 } },
    });
    expect(doc.kind).toBe('freeform-json');
  });

  it('rejects unknown kinds', () => {
    expect(() =>
      LevelDoc.parse({
        schemaVersion: 1,
        kind: 'metroidvania',
        size: { cols: 1, rows: 1 },
        layers: [],
      }),
    ).toThrow();
  });

  it('rejects levels without schemaVersion', () => {
    expect(() =>
      LevelDoc.parse({
        kind: 'freeform-json',
        data: {},
      }),
    ).toThrow();
  });
});

describe('WorldDoc', () => {
  it('parses an empty world graph', () => {
    const doc = WorldDoc.parse({
      schemaVersion: WORLD_DOC_SCHEMA_VERSION,
      kind: 'world-graph',
      levels: [],
      transitions: [],
    });
    expect(doc.startLevelSlug).toBeNull();
    expect(doc.globalState).toEqual({});
  });

  it('defaults startLevelSlug to null and globalState to {}', () => {
    const doc = WorldDoc.parse({
      schemaVersion: 1,
      kind: 'world-graph',
      levels: [{ slug: 'tutorial', sequencePosition: 0 }],
      transitions: [],
    });
    expect(doc.startLevelSlug).toBeNull();
  });

  it('parses transitions with default triggerType', () => {
    const doc = WorldDoc.parse({
      schemaVersion: 1,
      kind: 'world-graph',
      levels: [{ slug: 'a' }, { slug: 'b' }],
      transitions: [{ id: 't1', from: 'a', to: 'b' }],
    });
    expect(doc.transitions[0]?.triggerType).toBe('exit');
  });
});

describe('LevelSchemaDeclaration', () => {
  it('parses a minimal schema declaration', () => {
    const decl = LevelSchemaDeclaration.parse({
      schemaVersion: 1,
      kind: 'tilemap-2d',
    });
    expect(decl.kind).toBe('tilemap-2d');
    expect(decl.defaults).toEqual({});
  });
});

describe('LevelDocKind enum', () => {
  it('lists exactly five canonical kinds', () => {
    const opts = LevelDocKind.options;
    expect(opts).toEqual(['tilemap-2d', 'scene-3d', 'node-graph', 'wave-script', 'freeform-json']);
  });
});

describe('inferLevelKind', () => {
  it('returns the kind for valid input', () => {
    expect(inferLevelKind({ kind: 'tilemap-2d' })).toBe('tilemap-2d');
    expect(inferLevelKind({ kind: 'scene-3d' })).toBe('scene-3d');
    expect(inferLevelKind({ kind: 'wave-script' })).toBe('wave-script');
  });

  it("returns 'unknown' for non-objects", () => {
    expect(inferLevelKind(null)).toBe('unknown');
    expect(inferLevelKind('string')).toBe('unknown');
    expect(inferLevelKind(42)).toBe('unknown');
  });

  it("returns 'unknown' for missing kind", () => {
    expect(inferLevelKind({})).toBe('unknown');
    expect(inferLevelKind({ size: { cols: 1, rows: 1 } })).toBe('unknown');
  });

  it("returns 'unknown' for invalid kind value", () => {
    expect(inferLevelKind({ kind: 'metroidvania' })).toBe('unknown');
    expect(inferLevelKind({ kind: 42 })).toBe('unknown');
  });
});
