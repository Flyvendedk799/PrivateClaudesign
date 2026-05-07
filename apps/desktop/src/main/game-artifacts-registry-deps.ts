/**
 * Adapter that exposes the host's game-artifact registry through the shape
 * the agent expects (`GameArtifactRegistryDeps`). Maps every callback into
 * the underlying CRUD helpers in `./game-artifacts-db.ts` plus the
 * `regenerateArtifactsRegistry` post-mutation hook so `assets/artifacts.registry.json`
 * stays in sync without the agent having to author it.
 */

import type {
  CompactArtifact,
  DetailedArtifact,
  GameArtifactRegistryDeps,
} from '@open-codesign/core';
import { type GameArtifact, GameArtifactMetadata, parseArtifactAlias } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import {
  createAnimationBinding,
  createGameArtifact,
  findGameArtifactByAlias,
  findGameArtifactBySlug,
  getGameArtifact,
  listAnimationBindings,
  listGameArtifacts,
  updateGameArtifact,
} from './game-artifacts-db';
import { regenerateArtifactsRegistry } from './game-artifacts-import';

type Database = BetterSqlite3.Database;

function summarize(a: GameArtifact): CompactArtifact {
  const meta = a.metadata;
  const visual = meta.kind === 'sprite' ? meta.visualType : meta.animationType;
  return {
    id: a.id,
    alias: a.promptAlias,
    name: a.name,
    slug: a.slug,
    kind: a.kind,
    primaryFilePath: a.primaryFilePath,
    status: a.status,
    metadataSummary: visual,
  };
}

function detail(db: Database, designId: string, a: GameArtifact): DetailedArtifact {
  const bindings =
    a.kind === 'animation'
      ? listAnimationBindings(db, designId, { animationId: a.id }).map((b) => ({
          animationId: b.animationId,
          spriteId: b.spriteId,
          bindingStatus: b.bindingStatus,
        }))
      : listAnimationBindings(db, designId, { spriteId: a.id }).map((b) => ({
          animationId: b.animationId,
          spriteId: b.spriteId,
          bindingStatus: b.bindingStatus,
        }));
  return {
    ...summarize(a),
    metadata: a.metadata as unknown as Record<string, unknown>,
    files: a.files.map((f) => ({ path: f.path, role: f.role })),
    bindings,
  };
}

export function buildArtifactRegistryDeps(
  db: Database,
  designId: string,
): GameArtifactRegistryDeps {
  return {
    list: (filter) => {
      const opts: { kind?: 'sprite' | 'animation'; includeArchived?: boolean } = {};
      if (filter.kind !== undefined) opts.kind = filter.kind;
      if (filter.includeArchived === true) opts.includeArchived = true;
      return listGameArtifacts(db, designId, opts).map(summarize);
    },
    inspect: (artifactId) => {
      const a = getGameArtifact(db, designId, artifactId);
      if (a === null) return null;
      return detail(db, designId, a);
    },
    resolveRef: (text, expectedKind) => {
      const trimmed = text.trim();
      const parsed = parseArtifactAlias(trimmed);
      let candidate: GameArtifact | null = null;
      if (parsed !== null) {
        if (expectedKind !== undefined && parsed.kind !== expectedKind) return null;
        candidate = findGameArtifactBySlug(db, designId, parsed.kind, parsed.slug);
      }
      if (candidate === null) {
        candidate = findGameArtifactByAlias(db, designId, trimmed);
      }
      if (candidate === null) {
        // Fallback: try by name match (case-insensitive).
        const lower = trimmed.toLowerCase();
        const all = listGameArtifacts(db, designId, { includeArchived: false });
        const matches = all.filter(
          (a) =>
            (expectedKind === undefined || a.kind === expectedKind) &&
            (a.name.toLowerCase() === lower || a.slug === lower),
        );
        if (matches.length === 1) candidate = matches[0] ?? null;
      }
      if (candidate === null) return null;
      return detail(db, designId, candidate);
    },
    create: (input) => {
      const metadata = GameArtifactMetadata.parse(input.metadata);
      const created = createGameArtifact(db, {
        designId,
        kind: input.kind,
        name: input.name,
        metadata,
        ...(input.primaryFilePath !== undefined ? { primaryFilePath: input.primaryFilePath } : {}),
        fileRefs:
          input.fileRefs?.map((f) => ({
            path: f.path,
            role: f.role as
              | 'source'
              | 'texture'
              | 'spritesheet'
              | 'atlas'
              | 'model'
              | 'rig'
              | 'animation'
              | 'thumbnail'
              | 'preview'
              | 'metadata'
              | 'derived',
          })) ?? [],
      });
      regenerateArtifactsRegistry(db, designId);
      return detail(db, designId, created);
    },
    update: (input) => {
      const updated = updateGameArtifact(db, {
        designId,
        artifactId: input.artifactId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.metadataPatch !== undefined ? { metadataPatch: input.metadataPatch } : {}),
        ...(input.primaryFilePath !== undefined ? { primaryFilePath: input.primaryFilePath } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.fileRefsAdd !== undefined
          ? {
              fileRefsAdd: input.fileRefsAdd.map((f) => ({
                path: f.path,
                role: f.role as
                  | 'source'
                  | 'texture'
                  | 'spritesheet'
                  | 'atlas'
                  | 'model'
                  | 'rig'
                  | 'animation'
                  | 'thumbnail'
                  | 'preview'
                  | 'metadata'
                  | 'derived',
              })),
            }
          : {}),
        ...(input.fileRefsRemove !== undefined ? { fileRefsRemove: input.fileRefsRemove } : {}),
      });
      regenerateArtifactsRegistry(db, designId);
      return detail(db, designId, updated);
    },
    bindAnimation: (input) => {
      const binding = createAnimationBinding(db, {
        designId,
        animationId: input.animationId,
        spriteId: input.spriteId,
        ...(input.bindingStatus !== undefined ? { bindingStatus: input.bindingStatus } : {}),
        ...(input.retarget !== undefined ? { retarget: input.retarget } : {}),
      });
      regenerateArtifactsRegistry(db, designId);
      return { animationId: binding.animationId, spriteId: binding.spriteId };
    },
    validate: () => {
      const issues: Array<{
        artifactId?: string;
        severity: 'error' | 'warn';
        message: string;
      }> = [];
      const artifacts = listGameArtifacts(db, designId, { includeArchived: false });
      const bindings = listAnimationBindings(db, designId);
      const artifactIds = new Set(artifacts.map((a) => a.id));
      for (const a of artifacts) {
        if (a.files.length === 0) {
          issues.push({
            artifactId: a.id,
            severity: 'warn',
            message: `${a.promptAlias} has no linked file refs.`,
          });
        }
      }
      for (const a of artifacts) {
        if (a.kind !== 'animation') continue;
        const bound = bindings.filter((b) => b.animationId === a.id);
        if (bound.length === 0) {
          issues.push({
            artifactId: a.id,
            severity: 'error',
            message: `Animation ${a.promptAlias} has no bound sprite.`,
          });
        }
      }
      for (const b of bindings) {
        if (!artifactIds.has(b.animationId)) {
          issues.push({
            severity: 'error',
            message: `Binding references missing animation ${b.animationId}.`,
          });
        }
        if (!artifactIds.has(b.spriteId)) {
          issues.push({
            severity: 'error',
            message: `Binding references missing sprite ${b.spriteId}.`,
          });
        }
      }
      return { issues };
    },
  };
}
