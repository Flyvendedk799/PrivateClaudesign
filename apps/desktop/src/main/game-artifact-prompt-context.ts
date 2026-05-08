/**
 * Resolve the renderer's artifact selection payload into a compact context
 * block injected into the agent's user message. The block carries:
 *  - active project tab
 *  - selected sprite (full metadata + primary file path)
 *  - selected animation (full metadata + bound sprites)
 *  - animation target sprite (full metadata)
 *  - explicit @sprite:/@animation: mentions, resolved to artifact ids
 *
 * Non-selected artifacts get a one-line summary so the agent can decide
 * when to call list_game_artifacts / inspect_game_artifact for more
 * detail. Aliases that fail to resolve are surfaced as `unresolved` so
 * the agent can ask the user which artifact they meant.
 */

import {
  type GameArtifact,
  type GameArtifactPromptContextPayload,
  parseArtifactAlias,
} from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import {
  findGameArtifactByAlias,
  findGameArtifactBySlug,
  getGameArtifact,
  listAnimationBindings,
  listGameArtifacts,
} from './game-artifacts-db';

type Database = BetterSqlite3.Database;

export interface ResolvedAlias {
  alias: string;
  kind: 'sprite' | 'animation';
  slug: string;
  artifactId: string | null;
  artifactName?: string;
}

export interface BuildArtifactContextResult {
  /** The block to append after the user prompt. Empty string when nothing
   *  is in scope (no selection, no aliases, no artifacts). */
  block: string;
  /** Aliases the agent referenced that couldn't be resolved. The renderer
   *  uses this to surface a "select which sprite you meant" UI. */
  unresolvedAliases: string[];
}

function summarizeArtifact(artifact: GameArtifact): string {
  const meta = artifact.metadata;
  const visual =
    meta.kind === 'sprite'
      ? meta.visualType
      : meta.kind === 'animation'
        ? meta.animationType
        : meta.kind === 'level'
          ? meta.levelKind
          : 'world-graph';
  const path = artifact.primaryFilePath ?? '(no primary file)';
  return `  - ${artifact.promptAlias} (${artifact.kind}, ${visual}) → ${path}`;
}

function detailedArtifactSection(artifact: GameArtifact, label: string): string {
  const lines: string[] = [`${label}:`];
  lines.push(`  id: ${artifact.id}`);
  lines.push(`  alias: ${artifact.promptAlias}`);
  lines.push(`  name: ${artifact.name}`);
  if (artifact.primaryFilePath !== null) {
    lines.push(`  primary_file_path: ${artifact.primaryFilePath}`);
  }
  lines.push(`  metadata: ${JSON.stringify(artifact.metadata)}`);
  if (artifact.files.length > 0) {
    lines.push('  files:');
    for (const f of artifact.files) {
      lines.push(`    - ${f.role}: ${f.path}`);
    }
  }
  return lines.join('\n');
}

export function buildGameArtifactContextBlock(
  db: Database,
  designId: string,
  payload: GameArtifactPromptContextPayload | undefined,
): BuildArtifactContextResult {
  if (payload === undefined) return { block: '', unresolvedAliases: [] };
  const allArtifacts = listGameArtifacts(db, designId);
  if (allArtifacts.length === 0 && (payload.mentionedAliases ?? []).length === 0) {
    return { block: '', unresolvedAliases: [] };
  }

  const lines: string[] = ['<game_artifact_context>'];
  if (payload.activeTab !== undefined) {
    lines.push(`active_tab: ${payload.activeTab}`);
  }

  const selectedSprite = payload.selectedSpriteId
    ? getGameArtifact(db, designId, payload.selectedSpriteId)
    : null;
  if (selectedSprite !== null && selectedSprite.kind === 'sprite') {
    lines.push(detailedArtifactSection(selectedSprite, 'selected_sprite'));
  }

  const selectedAnimation = payload.selectedAnimationId
    ? getGameArtifact(db, designId, payload.selectedAnimationId)
    : null;
  if (selectedAnimation !== null && selectedAnimation.kind === 'animation') {
    lines.push(detailedArtifactSection(selectedAnimation, 'selected_animation'));
    const bindings = listAnimationBindings(db, designId, {
      animationId: selectedAnimation.id,
    });
    lines.push(`  bound_sprite_ids: [${bindings.map((b) => b.spriteId).join(', ')}]`);
  }

  const targetSprite =
    payload.animationTargetSpriteId !== undefined &&
    payload.animationTargetSpriteId !== payload.selectedSpriteId
      ? getGameArtifact(db, designId, payload.animationTargetSpriteId)
      : null;
  if (targetSprite !== null && targetSprite.kind === 'sprite') {
    lines.push(detailedArtifactSection(targetSprite, 'animation_target_sprite'));
  }

  // Compact one-line summaries for everything else so the agent knows what
  // exists without burning tokens on full metadata.
  const detailedIds = new Set([selectedSprite?.id, selectedAnimation?.id, targetSprite?.id]);
  const otherSprites = allArtifacts.filter((a) => a.kind === 'sprite' && !detailedIds.has(a.id));
  const otherAnimations = allArtifacts.filter(
    (a) => a.kind === 'animation' && !detailedIds.has(a.id),
  );
  if (otherSprites.length > 0) {
    lines.push('other_sprites:');
    for (const s of otherSprites.slice(0, 24)) lines.push(summarizeArtifact(s));
  }
  if (otherAnimations.length > 0) {
    lines.push('other_animations:');
    for (const a of otherAnimations.slice(0, 24)) lines.push(summarizeArtifact(a));
  }

  const unresolved: string[] = [];
  const aliases = payload.mentionedAliases ?? [];
  if (aliases.length > 0) {
    lines.push('user_mentions:');
    for (const alias of aliases) {
      const parsed = parseArtifactAlias(alias);
      let artifact: GameArtifact | null = null;
      if (parsed !== null) {
        artifact = findGameArtifactBySlug(db, designId, parsed.kind, parsed.slug);
      }
      if (artifact === null) {
        artifact = findGameArtifactByAlias(db, designId, alias);
      }
      if (artifact !== null) {
        lines.push(`  - ${alias} => ${artifact.id}`);
      } else {
        unresolved.push(alias);
        lines.push(`  - ${alias} => UNRESOLVED`);
      }
    }
  }

  lines.push('</game_artifact_context>');
  return { block: lines.join('\n'), unresolvedAliases: unresolved };
}

export function resolveAliasesAgainstDesign(
  db: Database,
  designId: string,
  aliases: string[],
): ResolvedAlias[] {
  const out: ResolvedAlias[] = [];
  for (const alias of aliases) {
    const parsed = parseArtifactAlias(alias);
    if (parsed === null) {
      out.push({ alias, kind: 'sprite', slug: '', artifactId: null });
      continue;
    }
    const artifact = findGameArtifactBySlug(db, designId, parsed.kind, parsed.slug);
    out.push({
      alias,
      kind: parsed.kind,
      slug: parsed.slug,
      artifactId: artifact?.id ?? null,
      ...(artifact !== null ? { artifactName: artifact.name } : {}),
    });
  }
  return out;
}
