import { z } from 'zod';

/**
 * Canonical level + world document schemas.
 *
 * These describe the *content* on disk:
 *   `assets/levels/<slug>/level.json` → conforms to `LevelDoc`
 *   `assets/world/world.json`         → conforms to `WorldDoc`
 *
 * Per-design level shape varies by genre (a tilemap platformer, a 3D FPS,
 * a dialogue-tree visual novel, etc.), so `LevelDoc` is a discriminated
 * union over five canonical kinds plus a `freeform-json` fallback for
 * anything that doesn't fit. The agent owns picking the right kind for
 * each design and writing levels that conform to it.
 *
 * The world doc is fixed at v1 — variation across games is much smaller
 * for the world layer (a graph of levels with transitions) than for
 * individual levels.
 *
 * All on-disk formats carry `schemaVersion` per CLAUDE.md
 * §"Schema-version everything that lives on disk".
 */

export const LEVEL_DOC_SCHEMA_VERSION = 1 as const;
export const WORLD_DOC_SCHEMA_VERSION = 1 as const;

/** The five canonical level kinds plus the freeform-json fallback. The
 *  renderer picks one of N specialized renderers based on this
 *  discriminator; freeform-json drops to a generic JSON editor. */
export const LevelDocKind = z.enum([
  'tilemap-2d',
  'scene-3d',
  'node-graph',
  'wave-script',
  'freeform-json',
]);
export type LevelDocKind = z.infer<typeof LevelDocKind>;

/** `assets/levels/<slug>/level.json` — kind=tilemap-2d. Suitable for
 *  2D platformers, top-down RPGs, roguelikes — anything backed by a
 *  grid of tiles. Tiles are integer ids referencing a tileset (typically
 *  a sprite artifact via `tilesetRef`). Multi-layer (background, fg,
 *  collision) supported via the `layers` array. */
const Tilemap2DLevel = z.object({
  schemaVersion: z.literal(LEVEL_DOC_SCHEMA_VERSION),
  kind: z.literal('tilemap-2d'),
  size: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }),
  tileSize: z.number().int().positive().default(16),
  layers: z.array(
    z.object({
      name: z.string(),
      tiles: z.array(z.array(z.number().int())),
      visible: z.boolean().default(true),
      opacity: z.number().min(0).max(1).default(1),
    }),
  ),
  entities: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        x: z.number(),
        y: z.number(),
        properties: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  spawns: z
    .array(
      z.object({
        role: z.enum(['player', 'enemy', 'item', 'checkpoint', 'exit']),
        x: z.number(),
        y: z.number(),
        metadata: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  /** Sprite slug (matches `assets/sprites/<slug>/`) supplying tile art. */
  tilesetRef: z.string().nullable().default(null),
});

/** `assets/levels/<slug>/level.json` — kind=scene-3d. Suitable for 3D
 *  FPS / third-person / city-builder maps. Nodes carry transforms and
 *  optional sprite refs (for billboards / glTF models). The `bounds`
 *  field is the world-space bounding box; the renderer uses it for
 *  initial camera framing. */
const Scene3DLevel = z.object({
  schemaVersion: z.literal(LEVEL_DOC_SCHEMA_VERSION),
  kind: z.literal('scene-3d'),
  bounds: z.object({
    min: z.tuple([z.number(), z.number(), z.number()]),
    max: z.tuple([z.number(), z.number(), z.number()]),
  }),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      transform: z.object({
        position: z.tuple([z.number(), z.number(), z.number()]),
        rotation: z
          .tuple([z.number(), z.number(), z.number()])
          .default([0, 0, 0] as [number, number, number]),
        scale: z
          .tuple([z.number(), z.number(), z.number()])
          .default([1, 1, 1] as [number, number, number]),
      }),
      spriteRef: z.string().nullable().default(null),
      properties: z.record(z.unknown()).default({}),
    }),
  ),
  spawns: z
    .array(
      z.object({
        role: z.enum(['player', 'enemy', 'item', 'checkpoint', 'exit']),
        position: z.tuple([z.number(), z.number(), z.number()]),
        metadata: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  navigation: z.unknown().nullable().default(null),
});

/** `assets/levels/<slug>/level.json` — kind=node-graph. Suitable for
 *  dialogue trees, state machines, puzzle games where progression is
 *  graph-shaped. Each node carries an arbitrary `payload` interpreted
 *  by the game runtime; edges are typed transitions. */
const NodeGraphLevel = z.object({
  schemaVersion: z.literal(LEVEL_DOC_SCHEMA_VERSION),
  kind: z.literal('node-graph'),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string().optional(),
      position: z.object({ x: z.number(), y: z.number() }),
      payload: z.record(z.unknown()).default({}),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      label: z.string().optional(),
      payload: z.record(z.unknown()).default({}),
    }),
  ),
  startNodeId: z.string().nullable().default(null),
});

/** `assets/levels/<slug>/level.json` — kind=wave-script. Suitable for
 *  wave-defense / arena games. The level is a timeline of spawn events
 *  rather than a static map. */
const WaveScriptLevel = z.object({
  schemaVersion: z.literal(LEVEL_DOC_SCHEMA_VERSION),
  kind: z.literal('wave-script'),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  waves: z.array(
    z.object({
      id: z.string(),
      startMs: z.number().int().nonnegative(),
      spawns: z.array(
        z.object({
          enemyType: z.string(),
          count: z.number().int().nonnegative(),
          spawnPointId: z.string().optional(),
          delayMs: z.number().int().nonnegative().default(0),
        }),
      ),
      completionRule: z.enum(['all-killed', 'time-elapsed', 'objective']).default('all-killed'),
    }),
  ),
});

/** `assets/levels/<slug>/level.json` — kind=freeform-json. Bailout for
 *  games whose level concept doesn't fit any canonical kind. The
 *  renderer drops to a generic JSON editor for these. */
const FreeformJsonLevel = z.object({
  schemaVersion: z.literal(LEVEL_DOC_SCHEMA_VERSION),
  kind: z.literal('freeform-json'),
  data: z.unknown(),
});

export const LevelDoc = z.discriminatedUnion('kind', [
  Tilemap2DLevel,
  Scene3DLevel,
  NodeGraphLevel,
  WaveScriptLevel,
  FreeformJsonLevel,
]);
export type LevelDoc = z.infer<typeof LevelDoc>;

export const Tilemap2DLevelDoc = Tilemap2DLevel;
export type Tilemap2DLevelDoc = z.infer<typeof Tilemap2DLevel>;
export const Scene3DLevelDoc = Scene3DLevel;
export type Scene3DLevelDoc = z.infer<typeof Scene3DLevel>;
export const NodeGraphLevelDoc = NodeGraphLevel;
export type NodeGraphLevelDoc = z.infer<typeof NodeGraphLevel>;
export const WaveScriptLevelDoc = WaveScriptLevel;
export type WaveScriptLevelDoc = z.infer<typeof WaveScriptLevel>;
export const FreeformJsonLevelDoc = FreeformJsonLevel;
export type FreeformJsonLevelDoc = z.infer<typeof FreeformJsonLevel>;

/** `assets/world/world.json` — singleton per design. Graph of level
 *  slugs with typed transitions and global state carry-over. Fixed v1
 *  schema (variation is much smaller than at the level layer). */
export const WorldDoc = z.object({
  schemaVersion: z.literal(WORLD_DOC_SCHEMA_VERSION),
  kind: z.literal('world-graph'),
  startLevelSlug: z.string().nullable().default(null),
  levels: z.array(
    z.object({
      slug: z.string(),
      displayName: z.string().optional(),
      thumbnailPath: z.string().nullable().default(null),
      biome: z.string().optional(),
      sequencePosition: z.number().int().optional(),
    }),
  ),
  transitions: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      triggerType: z.enum(['exit', 'death', 'objective', 'manual']).default('exit'),
      condition: z.string().optional(),
    }),
  ),
  globalState: z.record(z.unknown()).default({}),
});
export type WorldDoc = z.infer<typeof WorldDoc>;

/** `assets/levels/_schema.json` — per-design schema declaration. The
 *  agent writes one of these to constrain the kind of every level under
 *  `assets/levels/<slug>/`. Renderer reads it to bias the generic
 *  editor and to flag schema-divergent levels. */
export const LevelSchemaDeclaration = z.object({
  schemaVersion: z.literal(1),
  kind: LevelDocKind,
  /** Free-form notes the agent can carry across runs to remember design
   *  intent (e.g. "16-tile wide, scrolling left-to-right"). */
  notes: z.string().optional(),
  /** Optional default tilesetRef / spawn types — biases the per-design
   *  templates without forcing them. */
  defaults: z.record(z.unknown()).default({}),
});
export type LevelSchemaDeclaration = z.infer<typeof LevelSchemaDeclaration>;

/** Returns the inner discriminator. Used by the renderer to dispatch
 *  to the right specialized editor; falls back to `'unknown'` for
 *  malformed input rather than throwing. */
export function inferLevelKind(input: unknown): LevelDocKind | 'unknown' {
  if (input === null || typeof input !== 'object') return 'unknown';
  const k = (input as { kind?: unknown }).kind;
  if (typeof k !== 'string') return 'unknown';
  const parsed = LevelDocKind.safeParse(k);
  return parsed.success ? parsed.data : 'unknown';
}
