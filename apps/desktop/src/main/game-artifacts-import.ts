/**
 * Sprite/animation import path. The IPC layer hands us `(relativePath, content)`
 * tuples already decoded against the renderer FS — we copy them into
 * `design_files` under the canonical path layout (`assets/<kind>s/<slug>/…`),
 * infer minimal metadata, and create the artifact row plus optional binding.
 *
 * Inference is intentionally conservative: PNG dimensions are read from the
 * IHDR chunk, GLB files emit a placeholder model-3d sprite, and unknown blobs
 * fall through as a generic `2d-sprite` with no dimensions. The agent /
 * Inspect tool can refine metadata later through `game-artifacts:v1:update`.
 */

import type {
  AnimationArtifactMetadata,
  GameArtifactCreateInput,
  GameArtifactFileRefInput,
  GameArtifactKind,
  LevelArtifactMetadata,
  LevelDocKind,
  SpriteArtifactMetadata,
  WorldArtifactMetadata,
} from '@open-codesign/shared';
import { inferLevelKind, slugifyArtifactName } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { createAnimationBinding, createGameArtifact, getGameArtifact } from './game-artifacts-db';
import { upsertDesignFile } from './snapshots-db';

type Database = BetterSqlite3.Database;

export interface ImportArtifactFilesInput {
  db: Database;
  designId: string;
  kind: GameArtifactKind;
  files: Array<{ relativePath: string; content: string; role?: string }>;
  targetSpriteId?: string;
  name?: string;
}

export interface ImportArtifactFilesResult {
  artifactId: string;
  primaryPath: string;
}

const SENTINEL_BASE64 = 'data:base64,';

function fileExt(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return path.slice(dot + 1).toLowerCase();
}

function decodeBase64Sentinel(content: string): Buffer | null {
  if (!content.startsWith(SENTINEL_BASE64)) return null;
  try {
    return Buffer.from(content.slice(SENTINEL_BASE64.length), 'base64');
  } catch {
    return null;
  }
}

/** Read PNG width/height from the IHDR chunk. Returns null on malformed
 *  input — caller falls back to no-dimension metadata. */
export function inferPngDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG signature is 8 bytes, IHDR length+type runs to byte 16 (length: 4,
  // type: 4), then width is the next 4 bytes (big endian), height the 4
  // after. This avoids depending on a PNG decoder dep.
  if (buf.length < 24) return null;
  const sig = buf.subarray(0, 8);
  if (
    sig[0] !== 0x89 ||
    sig[1] !== 0x50 ||
    sig[2] !== 0x4e ||
    sig[3] !== 0x47 ||
    sig[4] !== 0x0d ||
    sig[5] !== 0x0a ||
    sig[6] !== 0x1a ||
    sig[7] !== 0x0a
  ) {
    return null;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function inferRole(ext: string, kind: GameArtifactKind): GameArtifactFileRefInput['role'] {
  if (kind === 'animation') {
    if (ext === 'json') return 'animation';
    if (ext === 'glb' || ext === 'gltf') return 'animation';
    if (ext === 'png' || ext === 'webp' || ext === 'jpg' || ext === 'jpeg') return 'spritesheet';
    return 'source';
  }
  if (kind === 'level' || kind === 'world') {
    // Levels + world: the canonical pair is level.json / world.json (metadata)
    // and an optional preview.png (thumbnail). Native authoring sources (Tiled
    // .tmx, Godot .tscn, etc.) drop into 'source'.
    if (ext === 'json') return 'metadata';
    if (ext === 'png' || ext === 'webp' || ext === 'jpg' || ext === 'jpeg') return 'thumbnail';
    return 'source';
  }
  if (ext === 'glb' || ext === 'gltf') return 'model';
  if (ext === 'png' || ext === 'webp' || ext === 'jpg' || ext === 'jpeg') return 'texture';
  if (ext === 'json') return 'atlas';
  return 'source';
}

function pickPrimary(
  kind: GameArtifactKind,
  files: ImportArtifactFilesInput['files'],
): { file: ImportArtifactFilesInput['files'][number]; ext: string } | null {
  // Sprites prefer model > spritesheet > texture > anything. Animations prefer
  // explicit clip JSON > animation glb > spritesheet > anything.
  const order =
    kind === 'sprite'
      ? ['glb', 'gltf', 'png', 'webp', 'jpg', 'jpeg', 'json']
      : ['json', 'glb', 'gltf', 'png', 'webp'];
  for (const ext of order) {
    const match = files.find((f) => fileExt(f.relativePath) === ext);
    if (match !== undefined) return { file: match, ext };
  }
  if (files.length === 0) return null;
  const first = files[0];
  if (first === undefined) return null;
  return { file: first, ext: fileExt(first.relativePath) };
}

function defaultSpriteMetadata(args: {
  ext: string;
  primary: ImportArtifactFilesInput['files'][number];
}): SpriteArtifactMetadata {
  const meta: SpriteArtifactMetadata = {
    version: 1,
    kind: 'sprite',
    visualType:
      args.ext === 'glb' || args.ext === 'gltf'
        ? 'model-3d'
        : args.ext === 'json'
          ? 'spritesheet'
          : '2d-sprite',
    tags: [],
    frameCount: 1,
  };
  if (args.ext === 'png') {
    const decoded = decodeBase64Sentinel(args.primary.content);
    if (decoded !== null) {
      const dims = inferPngDimensions(decoded);
      if (dims !== null) meta.dimensions = dims;
    }
  }
  return meta;
}

function defaultAnimationMetadata(): AnimationArtifactMetadata {
  return {
    version: 1,
    kind: 'animation',
    animationType: 'frame-sequence',
    durationMs: 1000,
    loop: true,
    tags: [],
    requiredTags: [],
    channels: [],
  };
}

export function importGameArtifactFiles(
  input: ImportArtifactFilesInput,
): ImportArtifactFilesResult {
  const { db, designId, kind, files, targetSpriteId } = input;
  if (files.length === 0) throw new Error('importGameArtifactFiles: files[] is empty');
  if (kind === 'animation' && (targetSpriteId === undefined || targetSpriteId.length === 0)) {
    throw new Error('animation imports require a targetSpriteId');
  }
  if (kind === 'animation' && targetSpriteId !== undefined) {
    const target = getGameArtifact(db, designId, targetSpriteId);
    if (target === null || target.kind !== 'sprite') {
      throw new Error(`targetSpriteId ${targetSpriteId} is not a sprite in design ${designId}`);
    }
  }
  const primary = pickPrimary(kind, files);
  if (primary === null) throw new Error('importGameArtifactFiles: no usable primary file');

  // Derive a name + slug. The IPC layer can pass an explicit name; otherwise
  // strip the primary file's extension and slugify.
  const fallbackName =
    primary.file.relativePath
      .replace(/\.[^.]+$/, '')
      .split('/')
      .pop() ?? 'imported';
  const name = (input.name ?? fallbackName).trim() || fallbackName;
  const slug = slugifyArtifactName(name);
  const subdir = kind === 'sprite' ? 'sprites' : 'animations';
  const dirPrefix = `assets/${subdir}/${slug}`;

  // Copy each file into design_files under assets/<kind>s/<slug>/...
  // Preserve the original filename so PNG paired with JSON atlas keeps its
  // pairing.
  const fileRefs: GameArtifactFileRefInput[] = [];
  let primaryPath = '';
  for (const f of files) {
    const cleanName = f.relativePath.replace(/^.*[\\/]/, '');
    const targetPath = `${dirPrefix}/${cleanName}`;
    upsertDesignFile(db, designId, targetPath, f.content);
    const role =
      (f.role as GameArtifactFileRefInput['role'] | undefined) ??
      inferRole(fileExt(targetPath), kind);
    fileRefs.push({ path: targetPath, role });
    if (f === primary.file) primaryPath = targetPath;
  }

  const metadata =
    kind === 'sprite'
      ? defaultSpriteMetadata({ ext: primary.ext, primary: primary.file })
      : defaultAnimationMetadata();

  const createInput: GameArtifactCreateInput = {
    designId,
    kind,
    name,
    slug,
    metadata,
    primaryFilePath: primaryPath,
    fileRefs,
    provenance: { source: 'user-import' },
  };
  const created = createGameArtifact(db, createInput);

  if (kind === 'animation' && targetSpriteId !== undefined) {
    createAnimationBinding(db, {
      designId,
      animationId: created.id,
      spriteId: targetSpriteId,
      bindingStatus: 'compatible',
    });
  }

  return { artifactId: created.id, primaryPath };
}

/**
 * Index sprites/animations from a generated game's `design_files`. Walks
 * `assets/sprites/...` and `assets/animations/...` subdirectories, pairs
 * files by directory, and creates artifact rows for any folder that doesn't
 * already have a registered artifact. Idempotent — caller can run after
 * each generation. Provenance is `indexed-from-files` so the agent / UI
 * can distinguish from user-imported assets.
 */
export function indexGameArtifactsFromFiles(
  db: Database,
  designId: string,
): { spritesAdded: number; animationsAdded: number; levelsAdded: number; worldAdded: number } {
  const files = db
    .prepare('SELECT path FROM design_files WHERE design_id = ?')
    .all(designId) as Array<{ path: string }>;
  const spriteBuckets = new Map<string, string[]>();
  const animationBuckets = new Map<string, string[]>();
  for (const f of files) {
    const spriteMatch = f.path.match(/^assets\/sprites\/([^/]+)\/(.+)$/);
    if (spriteMatch !== null) {
      const slug = spriteMatch[1] ?? '';
      if (!spriteBuckets.has(slug)) spriteBuckets.set(slug, []);
      spriteBuckets.get(slug)?.push(f.path);
      continue;
    }
    const animMatch = f.path.match(/^assets\/animations\/([^/]+)\/(.+)$/);
    if (animMatch !== null) {
      const slug = animMatch[1] ?? '';
      if (!animationBuckets.has(slug)) animationBuckets.set(slug, []);
      animationBuckets.get(slug)?.push(f.path);
    }
  }

  let spritesAdded = 0;
  for (const [slug, paths] of spriteBuckets.entries()) {
    if (paths.length === 0) continue;
    const existing = db
      .prepare("SELECT 1 FROM game_artifacts WHERE design_id = ? AND kind = 'sprite' AND slug = ?")
      .get(designId, slug);
    if (existing !== undefined) continue;
    // Pick a primary file: prefer model > sprite/spritesheet > texture > json.
    const order = ['model.glb', 'model.gltf', 'sprite.png', 'spritesheet.png', 'texture.png'];
    let primaryPath = paths.find((p) => order.some((suffix) => p.endsWith(`/${suffix}`))) ?? null;
    if (primaryPath === null) {
      primaryPath =
        paths.find((p) => /\.(png|webp|jpg|jpeg|glb|gltf)$/i.test(p)) ?? paths[0] ?? null;
    }
    if (primaryPath === null) continue;
    const ext = fileExt(primaryPath);
    const visualType: SpriteArtifactMetadata['visualType'] =
      ext === 'glb' || ext === 'gltf'
        ? 'model-3d'
        : primaryPath.endsWith('spritesheet.png')
          ? 'spritesheet'
          : '2d-sprite';
    const metadata: SpriteArtifactMetadata = {
      version: 1,
      kind: 'sprite',
      visualType,
      tags: [],
      frameCount: 1,
    };
    createGameArtifact(db, {
      designId,
      kind: 'sprite',
      name: slug,
      slug,
      metadata,
      primaryFilePath: primaryPath,
      fileRefs: paths.map((p) => ({ path: p, role: inferRole(fileExt(p), 'sprite') })),
      provenance: { source: 'indexed-from-files' },
    });
    spritesAdded += 1;
  }

  let animationsAdded = 0;
  for (const [slug, paths] of animationBuckets.entries()) {
    if (paths.length === 0) continue;
    const existing = db
      .prepare(
        "SELECT 1 FROM game_artifacts WHERE design_id = ? AND kind = 'animation' AND slug = ?",
      )
      .get(designId, slug);
    if (existing !== undefined) continue;
    const order = ['clip.json', 'frames.json', 'preview.json', 'animation.glb'];
    let primaryPath = paths.find((p) => order.some((suffix) => p.endsWith(`/${suffix}`))) ?? null;
    if (primaryPath === null) primaryPath = paths[0] ?? null;
    if (primaryPath === null) continue;
    const metadata = defaultAnimationMetadata();
    createGameArtifact(db, {
      designId,
      kind: 'animation',
      name: slug,
      slug,
      metadata,
      primaryFilePath: primaryPath,
      fileRefs: paths.map((p) => ({ path: p, role: inferRole(fileExt(p), 'animation') })),
      provenance: { source: 'indexed-from-files' },
    });
    animationsAdded += 1;
  }

  // level-and-world-designer §Phase 1 — index `assets/levels/<slug>/...`
  // and the singleton `assets/world/...` into game_artifacts. Levels carry
  // a denormalized `levelKind` discriminator on the metadata so list views
  // can render a chip without re-reading every level.json. World gets a
  // single row with `slug='world'`.
  const levelBuckets = new Map<string, string[]>();
  const worldFiles: string[] = [];
  for (const f of files) {
    const lvlMatch = f.path.match(/^assets\/levels\/([^/]+)\/(.+)$/);
    if (lvlMatch !== null) {
      const slug = lvlMatch[1] ?? '';
      // Reserved sentinel paths under assets/levels/ are not levels themselves.
      // _schema.json declares the per-design schema; _registry.json is a derived
      // manifest. Skip them so they don't become artifact rows.
      if (slug.startsWith('_')) continue;
      if (!levelBuckets.has(slug)) levelBuckets.set(slug, []);
      levelBuckets.get(slug)?.push(f.path);
      continue;
    }
    if (f.path.startsWith('assets/world/')) {
      worldFiles.push(f.path);
    }
  }

  let levelsAdded = 0;
  for (const [slug, paths] of levelBuckets.entries()) {
    if (paths.length === 0) continue;
    const existing = db
      .prepare("SELECT 1 FROM game_artifacts WHERE design_id = ? AND kind = 'level' AND slug = ?")
      .get(designId, slug);
    if (existing !== undefined) continue;
    const primaryPath = paths.find((p) => p.endsWith('/level.json')) ?? paths[0] ?? null;
    if (primaryPath === null) continue;
    // Best-effort kind inference: read the level.json content to set
    // `levelKind` on the metadata. Failures fall through to 'unknown'
    // and the renderer's JsonRenderer fallback handles it.
    let levelKind: LevelDocKind | 'unknown' = 'unknown';
    if (primaryPath.endsWith('/level.json')) {
      try {
        const row = db
          .prepare('SELECT content FROM design_files WHERE design_id = ? AND path = ?')
          .get(designId, primaryPath) as { content?: unknown } | undefined;
        const raw =
          typeof row?.content === 'string'
            ? row.content
            : Buffer.isBuffer(row?.content)
              ? row.content.toString('utf8')
              : null;
        if (raw !== null) {
          const parsed = JSON.parse(raw) as unknown;
          levelKind = inferLevelKind(parsed);
        }
      } catch {
        levelKind = 'unknown';
      }
    }
    const metadata: LevelArtifactMetadata = {
      version: 1,
      kind: 'level',
      levelKind,
      tags: [],
    };
    const previewPath = paths.find((p) => p.endsWith('/preview.png')) ?? null;
    createGameArtifact(db, {
      designId,
      kind: 'level',
      name: slug,
      slug,
      metadata,
      primaryFilePath: primaryPath,
      ...(previewPath !== null ? { previewFilePath: previewPath, thumbnailPath: previewPath } : {}),
      fileRefs: paths.map((p) => ({ path: p, role: inferRole(fileExt(p), 'level') })),
      provenance: { source: 'indexed-from-files' },
    });
    levelsAdded += 1;
  }

  let worldAdded = 0;
  if (worldFiles.length > 0) {
    const existing = db
      .prepare("SELECT 1 FROM game_artifacts WHERE design_id = ? AND kind = 'world' AND slug = ?")
      .get(designId, 'world');
    if (existing === undefined) {
      const primaryPath = worldFiles.find((p) => p === 'assets/world/world.json') ?? null;
      if (primaryPath !== null) {
        let levelCount = 0;
        let transitionCount = 0;
        let startLevelSlug: string | null = null;
        try {
          const row = db
            .prepare('SELECT content FROM design_files WHERE design_id = ? AND path = ?')
            .get(designId, primaryPath) as { content?: unknown } | undefined;
          const raw =
            typeof row?.content === 'string'
              ? row.content
              : Buffer.isBuffer(row?.content)
                ? row.content.toString('utf8')
                : null;
          if (raw !== null) {
            const parsed = JSON.parse(raw) as {
              levels?: unknown[];
              transitions?: unknown[];
              startLevelSlug?: unknown;
            };
            if (Array.isArray(parsed?.levels)) levelCount = parsed.levels.length;
            if (Array.isArray(parsed?.transitions)) transitionCount = parsed.transitions.length;
            if (typeof parsed?.startLevelSlug === 'string') {
              startLevelSlug = parsed.startLevelSlug;
            }
          }
        } catch {
          // Swallow — worldArtifact still registers with zeroed counts.
        }
        const metadata: WorldArtifactMetadata = {
          version: 1,
          kind: 'world',
          tags: [],
          levelCount,
          transitionCount,
          startLevelSlug,
        };
        const previewPath = worldFiles.find((p) => p === 'assets/world/preview.png') ?? null;
        createGameArtifact(db, {
          designId,
          kind: 'world',
          name: 'world',
          slug: 'world',
          metadata,
          primaryFilePath: primaryPath,
          ...(previewPath !== null
            ? { previewFilePath: previewPath, thumbnailPath: previewPath }
            : {}),
          fileRefs: worldFiles.map((p) => ({
            path: p,
            role: inferRole(fileExt(p), 'world'),
          })),
          provenance: { source: 'indexed-from-files' },
        });
        worldAdded = 1;
      }
    }
  }

  if (spritesAdded > 0 || animationsAdded > 0 || levelsAdded > 0 || worldAdded > 0) {
    regenerateArtifactsRegistry(db, designId);
  }
  return { spritesAdded, animationsAdded, levelsAdded, worldAdded };
}

/**
 * Regenerate `assets/artifacts.registry.json` from the live registry. The
 * DB is the source of truth; this file is an exported manifest so the
 * generated game code (and `pnpm export`) has a portable copy. Called
 * after every artifact mutation that the renderer / agent makes.
 */
export function regenerateArtifactsRegistry(db: Database, designId: string): void {
  const sprites = db
    .prepare(
      `SELECT id, prompt_alias, slug, name, primary_file_path, metadata_json
         FROM game_artifacts
        WHERE design_id = ? AND kind = 'sprite' AND status != 'archived'
        ORDER BY slug ASC`,
    )
    .all(designId) as Array<{
    id: string;
    prompt_alias: string;
    slug: string;
    name: string;
    primary_file_path: string | null;
    metadata_json: string;
  }>;
  const animations = db
    .prepare(
      `SELECT id, prompt_alias, slug, name, primary_file_path, metadata_json
         FROM game_artifacts
        WHERE design_id = ? AND kind = 'animation' AND status != 'archived'
        ORDER BY slug ASC`,
    )
    .all(designId) as Array<{
    id: string;
    prompt_alias: string;
    slug: string;
    name: string;
    primary_file_path: string | null;
    metadata_json: string;
  }>;
  const bindings = db
    .prepare('SELECT animation_id, sprite_id FROM game_animation_bindings WHERE design_id = ?')
    .all(designId) as Array<{ animation_id: string; sprite_id: string }>;
  const boundSpritesByAnim = new Map<string, string[]>();
  for (const b of bindings) {
    const list = boundSpritesByAnim.get(b.animation_id) ?? [];
    list.push(b.sprite_id);
    boundSpritesByAnim.set(b.animation_id, list);
  }
  const safeMetadata = (raw: string): Record<string, unknown> => {
    if (raw === undefined || raw === null || raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed === null || typeof parsed !== 'object'
        ? {}
        : (parsed as Record<string, unknown>);
    } catch {
      return {};
    }
  };
  const payload = {
    schemaVersion: 1 as const,
    sprites: sprites.map((s) => ({
      id: s.id,
      alias: s.prompt_alias,
      slug: s.slug,
      name: s.name,
      primaryFilePath: s.primary_file_path,
      metadata: safeMetadata(s.metadata_json),
    })),
    animations: animations.map((a) => ({
      id: a.id,
      alias: a.prompt_alias,
      slug: a.slug,
      name: a.name,
      primaryFilePath: a.primary_file_path,
      boundSpriteIds: boundSpritesByAnim.get(a.id) ?? [],
      metadata: safeMetadata(a.metadata_json),
    })),
  };
  upsertDesignFile(
    db,
    designId,
    'assets/artifacts.registry.json',
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}
