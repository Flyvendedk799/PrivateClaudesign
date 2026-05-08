import { z } from 'zod';

export const GAME_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const GameArtifactKind = z.enum(['sprite', 'animation', 'level', 'world']);
export type GameArtifactKind = z.infer<typeof GameArtifactKind>;

export const GameArtifactStatus = z.enum(['ready', 'generating', 'error', 'archived']);
export type GameArtifactStatus = z.infer<typeof GameArtifactStatus>;

export const GameArtifactFileRole = z.enum([
  'source',
  'texture',
  'spritesheet',
  'atlas',
  'model',
  'rig',
  'animation',
  'thumbnail',
  'preview',
  'metadata',
  'derived',
]);
export type GameArtifactFileRole = z.infer<typeof GameArtifactFileRole>;

export const GameAnimationBindingStatus = z.enum(['compatible', 'needs_retarget', 'broken']);
export type GameAnimationBindingStatus = z.infer<typeof GameAnimationBindingStatus>;

export const GameArtifactBaseMetadata = z.object({
  version: z.literal(1),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const SpriteArtifactMetadata = GameArtifactBaseMetadata.extend({
  kind: z.literal('sprite'),
  visualType: z.enum(['2d-sprite', 'spritesheet', 'voxel', 'billboard-3d', 'model-3d']),
  dimensions: z
    .object({
      width: z.number(),
      height: z.number(),
      depth: z.number().optional(),
    })
    .optional(),
  frameCount: z.number().int().nonnegative().default(1),
  pivot: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number().optional(),
    })
    .optional(),
  bounds: z
    .object({
      min: z.tuple([z.number(), z.number(), z.number()]),
      max: z.tuple([z.number(), z.number(), z.number()]),
    })
    .optional(),
  skeleton: z
    .object({
      rigId: z.string(),
      boneNames: z.array(z.string()),
      restPoseHash: z.string(),
    })
    .optional(),
});
export type SpriteArtifactMetadata = z.infer<typeof SpriteArtifactMetadata>;

export const AnimationArtifactMetadata = GameArtifactBaseMetadata.extend({
  kind: z.literal('animation'),
  animationType: z.enum([
    'frame-sequence',
    'spritesheet-cycle',
    'skeletal',
    'procedural',
    'engine-clip',
  ]),
  durationMs: z.number().int().positive(),
  loop: z.boolean().default(true),
  fps: z.number().positive().optional(),
  requiredRigHash: z.string().optional(),
  requiredTags: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
});
export type AnimationArtifactMetadata = z.infer<typeof AnimationArtifactMetadata>;

/** Per-level metadata stored on the `game_artifacts` row for `kind='level'`.
 *  The actual level *content* (geometry, tiles, spawns, etc.) lives in
 *  `assets/levels/<slug>/level.json` and is described by `LevelDoc` in
 *  `./level-schema.ts`. This metadata only carries cataloging fields the
 *  registry needs without re-parsing the document. */
export const LevelArtifactMetadata = GameArtifactBaseMetadata.extend({
  kind: z.literal('level'),
  /** The discriminator from LevelDoc.kind — duplicated here so the
   *  registry / list view can show a chip without parsing every level
   *  file. Tracks the canonical kinds + 'freeform-json' fallback +
   *  'unknown' for files that haven't been validated yet. */
  levelKind: z
    .enum(['tilemap-2d', 'scene-3d', 'node-graph', 'wave-script', 'freeform-json', 'unknown'])
    .default('unknown'),
  /** Which world position (sequencePosition) this level holds, if any.
   *  Mirrors `world.json.levels[].sequencePosition`; pre-computed at
   *  index time so list views can sort without joining. */
  sequencePosition: z.number().int().optional(),
  /** Free-form genre/biome tag — e.g. 'forest', 'tutorial', 'boss'. */
  biome: z.string().optional(),
});
export type LevelArtifactMetadata = z.infer<typeof LevelArtifactMetadata>;

/** Singleton metadata for `kind='world'` artifacts. The actual world
 *  graph lives in `assets/world/world.json` and is described by
 *  `WorldDoc` in `./level-schema.ts`. */
export const WorldArtifactMetadata = GameArtifactBaseMetadata.extend({
  kind: z.literal('world'),
  levelCount: z.number().int().nonnegative().default(0),
  transitionCount: z.number().int().nonnegative().default(0),
  startLevelSlug: z.string().nullable().default(null),
});
export type WorldArtifactMetadata = z.infer<typeof WorldArtifactMetadata>;

export const GameArtifactMetadata = z.discriminatedUnion('kind', [
  SpriteArtifactMetadata,
  AnimationArtifactMetadata,
  LevelArtifactMetadata,
  WorldArtifactMetadata,
]);
export type GameArtifactMetadata = z.infer<typeof GameArtifactMetadata>;

export const GameArtifactProvenance = z.object({
  source: z.enum(['agent', 'user-import', 'indexed-from-files', 'duplicated']).default('agent'),
  generationId: z.string().optional(),
  fromArtifactId: z.string().optional(),
  notes: z.string().optional(),
});
export type GameArtifactProvenance = z.infer<typeof GameArtifactProvenance>;

export const GameArtifactFile = z.object({
  id: z.string(),
  artifactId: z.string(),
  designId: z.string(),
  path: z.string(),
  role: GameArtifactFileRole,
  createdAt: z.string(),
});
export type GameArtifactFile = z.infer<typeof GameArtifactFile>;

export const GameArtifact = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string(),
  designId: z.string(),
  kind: GameArtifactKind,
  name: z.string(),
  slug: z.string(),
  promptAlias: z.string(),
  status: GameArtifactStatus,
  engine: z.enum(['three', 'phaser', 'pygame', 'godot']).nullable(),
  primaryFilePath: z.string().nullable(),
  previewFilePath: z.string().nullable(),
  thumbnailPath: z.string().nullable(),
  metadata: GameArtifactMetadata,
  provenance: GameArtifactProvenance,
  files: z.array(GameArtifactFile),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GameArtifact = z.infer<typeof GameArtifact>;

export const GameAnimationBinding = z.object({
  id: z.string(),
  designId: z.string(),
  animationId: z.string(),
  spriteId: z.string(),
  bindingStatus: GameAnimationBindingStatus,
  retarget: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GameAnimationBinding = z.infer<typeof GameAnimationBinding>;

export const GameArtifactFileRefInput = z.object({
  path: z.string(),
  role: GameArtifactFileRole,
});
export type GameArtifactFileRefInput = z.infer<typeof GameArtifactFileRefInput>;

export const GameArtifactCreateInput = z.object({
  designId: z.string(),
  kind: GameArtifactKind,
  name: z.string(),
  slug: z.string().optional(),
  promptAlias: z.string().optional(),
  engine: z.enum(['three', 'phaser', 'pygame', 'godot']).optional(),
  primaryFilePath: z.string().optional(),
  previewFilePath: z.string().optional(),
  thumbnailPath: z.string().optional(),
  metadata: GameArtifactMetadata,
  provenance: GameArtifactProvenance.optional(),
  fileRefs: z.array(GameArtifactFileRefInput).default([]),
});
export type GameArtifactCreateInput = z.infer<typeof GameArtifactCreateInput>;

export const GameArtifactUpdateInput = z.object({
  designId: z.string(),
  artifactId: z.string(),
  name: z.string().optional(),
  metadataPatch: z.record(z.unknown()).optional(),
  primaryFilePath: z.string().optional(),
  previewFilePath: z.string().optional(),
  thumbnailPath: z.string().optional(),
  status: GameArtifactStatus.optional(),
  fileRefsAdd: z.array(GameArtifactFileRefInput).optional(),
  fileRefsRemove: z.array(z.string()).optional(),
});
export type GameArtifactUpdateInput = z.infer<typeof GameArtifactUpdateInput>;

export const GameArtifactImportInput = z.object({
  designId: z.string(),
  kind: GameArtifactKind,
  files: z.array(
    z.object({
      relativePath: z.string(),
      content: z.string(),
      role: GameArtifactFileRole.optional(),
    }),
  ),
  targetSpriteId: z.string().optional(),
  name: z.string().optional(),
});
export type GameArtifactImportInput = z.infer<typeof GameArtifactImportInput>;

export const GameArtifactSelection = z.object({
  designId: z.string(),
  spriteId: z.string().nullable(),
  animationId: z.string().nullable(),
  animationTargetSpriteId: z.string().nullable(),
});
export type GameArtifactSelection = z.infer<typeof GameArtifactSelection>;

export const GamePreviewMode = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('game') }),
  z.object({ mode: z.literal('sprite'), spriteId: z.string() }),
  z.object({
    mode: z.literal('animation'),
    animationId: z.string(),
    spriteId: z.string(),
  }),
]);
export type GamePreviewMode = z.infer<typeof GamePreviewMode>;

export const GameArtifactListResult = z.object({
  designId: z.string(),
  artifacts: z.array(GameArtifact),
  bindings: z.array(GameAnimationBinding),
});
export type GameArtifactListResult = z.infer<typeof GameArtifactListResult>;

export interface GameArtifactPreviewManifest {
  schemaVersion: 1;
  designId: string;
  engine: 'three' | 'phaser' | 'pygame' | 'godot';
  mode: 'sprite' | 'animation';
  sprite?: {
    id: string;
    name: string;
    metadata: SpriteArtifactMetadata;
    files: Array<{ path: string; role: GameArtifactFileRole; url: string }>;
  };
  animation?: {
    id: string;
    name: string;
    metadata: AnimationArtifactMetadata;
    files: Array<{ path: string; role: GameArtifactFileRole; url: string }>;
    binding: {
      spriteId: string;
      bindingStatus: GameAnimationBindingStatus;
      retarget: unknown;
    };
  };
}

export interface GameArtifactRegistryEntry {
  id: string;
  alias: string;
  slug: string;
  name: string;
  primaryFilePath: string | null;
  metadata: Record<string, unknown>;
}

export interface GameArtifactRegistry {
  schemaVersion: 1;
  sprites: GameArtifactRegistryEntry[];
  animations: Array<GameArtifactRegistryEntry & { boundSpriteIds: string[] }>;
}

const SLUGIFY_RE = /[^a-z0-9]+/g;

/** Slugify a human name into a stable kebab-case prompt-friendly id.
 *  Empty / numeric-only inputs fall back to 'artifact'. */
export function slugifyArtifactName(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const hyphenated = trimmed.replace(SLUGIFY_RE, '-').replace(/^-+|-+$/g, '');
  if (hyphenated.length === 0) return 'artifact';
  if (/^\d+$/.test(hyphenated)) return `artifact-${hyphenated}`;
  return hyphenated;
}

/** may9 Phase 15 — strict slug validator. Used at the IPC boundary
 *  before persisting an artifact. The slugifier above is permissive
 *  (it normalizes any input); this rejects inputs that would still
 *  collide with reserved names or break our path conventions.
 *
 *  Rules:
 *   - 1-64 chars
 *   - lowercase letter first (no leading digit / hyphen / underscore)
 *   - subsequent chars: lowercase letters, digits, hyphen, underscore
 *   - cannot equal a reserved name
 */
export const SLUG_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

/** Reserved names that would collide with our path conventions. The
 *  `__preview/*` synthesised inspector iframes, the `_build/*` ephemeral
 *  builds, and a handful of canonical entry filenames must never be
 *  used as artifact slugs. Match is case-insensitive and exact. */
export const RESERVED_SLUGS: readonly string[] = [
  '__preview',
  '_build',
  'index',
  'main',
  'manifest',
  'project',
  'autoload',
  'global',
  'admin',
  'system',
];

export interface SlugValidation {
  ok: boolean;
  reason?: string;
}

export function isValidSlug(input: string | null | undefined): SlugValidation {
  if (typeof input !== 'string') return { ok: false, reason: 'not a string' };
  if (input.length === 0) return { ok: false, reason: 'empty' };
  if (input.length > 64) return { ok: false, reason: 'over 64 chars' };
  if (!SLUG_REGEX.test(input))
    return {
      ok: false,
      reason:
        'must start with a lowercase letter and contain only lowercase letters, digits, hyphen, underscore',
    };
  if (RESERVED_SLUGS.includes(input.toLowerCase()))
    return { ok: false, reason: `'${input}' is reserved` };
  return { ok: true };
}

/** Build the canonical prompt alias for an artifact kind + slug. The slug is
 *  expected to already be slugified — caller's responsibility. */
export function aliasForArtifact(kind: GameArtifactKind, slug: string): string {
  return kind === 'sprite' ? `@sprite:${slug}` : `@animation:${slug}`;
}

/** Match an artifact's alias against a piece of free-form text. Returns the
 *  slug when matched, null otherwise. Used by the prompt resolver. The
 *  agent's @-syntax only covers sprites + animations today (levels +
 *  worlds go through the file system), so the return type narrows
 *  rather than widening to the full GameArtifactKind union. */
export function parseArtifactAlias(
  text: string,
): { kind: 'sprite' | 'animation'; slug: string } | null {
  const sprite = text.match(/^@sprite:([a-z0-9][a-z0-9-]*)$/);
  if (sprite?.[1] !== undefined) return { kind: 'sprite', slug: sprite[1] };
  const anim = text.match(/^@animation:([a-z0-9][a-z0-9-]*)$/);
  if (anim?.[1] !== undefined) return { kind: 'animation', slug: anim[1] };
  return null;
}

/** Pull every `@sprite:slug` / `@animation:slug` reference out of a free-form
 *  prompt. Returns an array of (kind, slug) pairs preserving insertion order
 *  with duplicates collapsed. */
export function extractArtifactAliases(
  text: string,
): Array<{ kind: GameArtifactKind; slug: string }> {
  const re = /@(sprite|animation):([a-z0-9][a-z0-9-]*)/g;
  const out: Array<{ kind: GameArtifactKind; slug: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
  while ((m = re.exec(text)) !== null) {
    const kind = m[1] === 'animation' ? 'animation' : 'sprite';
    const slug = m[2] ?? '';
    const key = `${kind}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, slug });
  }
  return out;
}
