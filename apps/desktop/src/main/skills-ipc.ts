/**
 * `skills:v1:*` IPC channels — backlog-2 #7. Wires the user-authored
 * skills CRUD + the region-extractor flow used by the new Skills hub
 * tab.
 *
 * The extractor is a one-shot LLM call: given a snapshot's artifact
 * source and a region rect, return a parameterised reusable JSX
 * skill. Uses the active provider via the existing
 * `resolveActiveApiKeyFromState` helper (and the OAuth-refresh
 * helper from backlog-1 #1, when the active provider is
 * `claude-code-imported`).
 */

import {
  type ChatMessage,
  CodesignError,
  type CommentRect,
  ERROR_CODES,
  type UserSkill,
  type UserSkillCreateInput,
  type UserSkillExtractInput,
  type UserSkillUpdateInput,
} from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { ipcMain } from './electron-runtime';
import { getLogger } from './logger';
import {
  createUserSkill,
  deleteUserSkill,
  getSnapshot,
  getUserSkill,
  listUserSkills,
  updateUserSkill,
} from './snapshots-db';

type Database = BetterSqlite3.Database;

const logger = getLogger('skills-ipc');

export const SKILLS_CHANNELS_V1 = [
  'skills:v1:list',
  'skills:v1:get',
  'skills:v1:create',
  'skills:v1:update',
  'skills:v1:delete',
  'skills:v1:extract-from-design',
] as const;

function requireSchemaV1(r: Record<string, unknown>, channel: string): void {
  if (r['schemaVersion'] !== 1) {
    throw new CodesignError(`${channel} requires schemaVersion: 1`, 'IPC_BAD_INPUT');
  }
}

function parseRect(raw: unknown, channel: string): CommentRect {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(`${channel}: rect must be an object`, 'IPC_BAD_INPUT');
  }
  const r = raw as Record<string, unknown>;
  const top = r['top'];
  const left = r['left'];
  const width = r['width'];
  const height = r['height'];
  if (
    typeof top !== 'number' ||
    typeof left !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(top) ||
    !Number.isFinite(left) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new CodesignError(
      `${channel}: rect must have finite top/left/width/height`,
      'IPC_BAD_INPUT',
    );
  }
  return { top, left, width, height };
}

function parseCreate(raw: unknown): UserSkillCreateInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('skills:v1:create expects an object', 'IPC_BAD_INPUT');
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'skills:v1:create');
  if (typeof r['name'] !== 'string' || r['name'].trim().length === 0) {
    throw new CodesignError('name must be a non-empty string', 'IPC_BAD_INPUT');
  }
  if (typeof r['whenToUse'] !== 'string' || r['whenToUse'].trim().length === 0) {
    throw new CodesignError('whenToUse must be a non-empty string', 'IPC_BAD_INPUT');
  }
  if (typeof r['source'] !== 'string' || r['source'].trim().length === 0) {
    throw new CodesignError('source must be a non-empty string', 'IPC_BAD_INPUT');
  }
  return {
    name: r['name'] as string,
    whenToUse: r['whenToUse'] as string,
    source: r['source'] as string,
    sourceDesignId:
      typeof r['sourceDesignId'] === 'string' ? (r['sourceDesignId'] as string) : null,
    sourceSnapshotId:
      typeof r['sourceSnapshotId'] === 'string' ? (r['sourceSnapshotId'] as string) : null,
    sourceRect:
      r['sourceRect'] && typeof r['sourceRect'] === 'object'
        ? parseRect(r['sourceRect'], 'skills:v1:create')
        : null,
  };
}

function parseUpdate(raw: unknown): { id: string; patch: UserSkillUpdateInput } {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('skills:v1:update expects an object', 'IPC_BAD_INPUT');
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'skills:v1:update');
  if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
    throw new CodesignError('id must be a non-empty string', 'IPC_BAD_INPUT');
  }
  const patchRaw = r['patch'];
  if (typeof patchRaw !== 'object' || patchRaw === null) {
    throw new CodesignError('patch must be an object', 'IPC_BAD_INPUT');
  }
  const patch: UserSkillUpdateInput = {};
  const p = patchRaw as Record<string, unknown>;
  if (typeof p['name'] === 'string') patch.name = p['name'];
  if (typeof p['whenToUse'] === 'string') patch.whenToUse = p['whenToUse'];
  if (typeof p['source'] === 'string') patch.source = p['source'];
  return { id: r['id'] as string, patch };
}

function parseExtract(raw: unknown): UserSkillExtractInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('skills:v1:extract-from-design expects an object', 'IPC_BAD_INPUT');
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'skills:v1:extract-from-design');
  if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
    throw new CodesignError('designId required', 'IPC_BAD_INPUT');
  }
  if (typeof r['snapshotId'] !== 'string' || r['snapshotId'].trim().length === 0) {
    throw new CodesignError('snapshotId required', 'IPC_BAD_INPUT');
  }
  if (typeof r['userPrompt'] !== 'string' || r['userPrompt'].trim().length === 0) {
    throw new CodesignError('userPrompt required', 'IPC_BAD_INPUT');
  }
  return {
    designId: r['designId'] as string,
    snapshotId: r['snapshotId'] as string,
    rect: parseRect(r['rect'], 'skills:v1:extract-from-design'),
    userPrompt: r['userPrompt'] as string,
  };
}

/**
 * Build the prompt the extractor LLM sees. Hand-crafted so the model
 * produces a clean, parameterised skill that round-trips through
 * `view_design_skill` on the next generation.
 */
function buildExtractorMessages(
  artifactSource: string,
  rect: CommentRect,
  userPrompt: string,
): ChatMessage[] {
  const system = [
    'You are a design-skill extractor. Given a finished JSX/HTML artifact and a region the user marked, you return a small reusable JSX skill.',
    '',
    'Output JSON only — no prose, no markdown fences. Schema:',
    '  { "name": "kebab-case-slug", "whenToUse": "one-sentence hint", "source": "<jsx body>" }',
    '',
    'Rules:',
    '- name: 2-4 words, kebab-case, suitable for a JSX component slug. Examples: "mobile-tab-bar", "lesson-row", "stat-card".',
    '- whenToUse: one sentence the agent will read in `list_design_skills`. Describe WHEN to use the skill ("Use when …"), not what it is. Max 200 chars.',
    '- source: the JSX/HTML for the marked region, parameterised:',
    '  * Replace user-specific copy with placeholders (e.g. "{{title}}" or descriptive variable names).',
    '  * Use design tokens (var(--color-accent), var(--color-text-primary)) instead of hex colors when the original design defined them.',
    '  * If the region is a React component, return the function declaration. If raw HTML, return the JSX equivalent.',
    '  * Keep accessibility attributes (aria-*, alt, role) verbatim.',
    '',
    'Return ONLY the JSON object — no commentary.',
  ].join('\n');
  const user = [
    `User intent: ${userPrompt}`,
    '',
    `Marked region (page-relative px): top=${rect.top}, left=${rect.left}, width=${rect.width}, height=${rect.height}`,
    '',
    'Source artifact:',
    '```',
    artifactSource,
    '```',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

interface SkillsIpcDeps {
  /** Run a one-shot LLM completion using the active provider. Injected
   *  so the IPC layer doesn't have to know about provider/auth wiring;
   *  apps/desktop/src/main/index.ts supplies a closure that uses the
   *  same auth/provider machinery as `codesign:v1:generate`. */
  runOneShotCompletion: (messages: ChatMessage[]) => Promise<string>;
}

export function registerSkillsIpc(db: Database, deps: SkillsIpcDeps): void {
  ipcMain.handle('skills:v1:list', (): UserSkill[] => listUserSkills(db));

  ipcMain.handle('skills:v1:get', (_e: unknown, raw: unknown): UserSkill | null => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError('skills:v1:get expects { id }', 'IPC_BAD_INPUT');
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'skills:v1:get');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id required', 'IPC_BAD_INPUT');
    }
    return getUserSkill(db, r['id'] as string);
  });

  ipcMain.handle('skills:v1:create', (_e: unknown, raw: unknown): UserSkill => {
    const input = parseCreate(raw);
    const skill = createUserSkill(db, input);
    logger.info('skill.created', { id: skill.id, name: skill.name });
    return skill;
  });

  ipcMain.handle('skills:v1:update', (_e: unknown, raw: unknown): UserSkill => {
    const { id, patch } = parseUpdate(raw);
    const updated = updateUserSkill(db, id, patch);
    if (updated === null) {
      throw new CodesignError('User skill not found', 'IPC_NOT_FOUND');
    }
    return updated;
  });

  ipcMain.handle('skills:v1:delete', (_e: unknown, raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodesignError('skills:v1:delete expects { id }', 'IPC_BAD_INPUT');
    }
    const r = raw as Record<string, unknown>;
    requireSchemaV1(r, 'skills:v1:delete');
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new CodesignError('id required', 'IPC_BAD_INPUT');
    }
    deleteUserSkill(db, r['id'] as string);
  });

  ipcMain.handle(
    'skills:v1:extract-from-design',
    async (_e: unknown, raw: unknown): Promise<UserSkill> => {
      const input = parseExtract(raw);
      const snap = getSnapshot(db, input.snapshotId);
      if (snap === null) {
        throw new CodesignError('Snapshot not found', 'IPC_NOT_FOUND');
      }
      if (snap.designId !== input.designId) {
        throw new CodesignError('snapshotId does not belong to designId', 'IPC_BAD_INPUT');
      }
      const messages = buildExtractorMessages(snap.artifactSource, input.rect, input.userPrompt);
      let raw_response: string;
      try {
        raw_response = await deps.runOneShotCompletion(messages);
      } catch (err) {
        logger.error('extractor.fail', {
          designId: input.designId,
          message: err instanceof Error ? err.message : String(err),
        });
        throw new CodesignError(
          `Extractor LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          ERROR_CODES.PROVIDER_ERROR,
          { cause: err instanceof Error ? err : new Error(String(err)) },
        );
      }
      let parsed: { name?: unknown; whenToUse?: unknown; source?: unknown };
      try {
        // Strip a possible leading ```json fence the model sometimes adds
        // despite the system prompt asking for raw JSON.
        const cleaned = raw_response
          .trim()
          .replace(/^```(?:json)?\s*/, '')
          .replace(/```\s*$/, '');
        parsed = JSON.parse(cleaned);
      } catch (err) {
        throw new CodesignError(
          `Extractor returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
          ERROR_CODES.PROVIDER_ERROR,
        );
      }
      if (
        typeof parsed.name !== 'string' ||
        typeof parsed.whenToUse !== 'string' ||
        typeof parsed.source !== 'string'
      ) {
        throw new CodesignError(
          'Extractor response missing required fields (name / whenToUse / source)',
          ERROR_CODES.PROVIDER_ERROR,
        );
      }
      const skill = createUserSkill(db, {
        name: parsed.name,
        whenToUse: parsed.whenToUse,
        source: parsed.source,
        sourceDesignId: input.designId,
        sourceSnapshotId: input.snapshotId,
        sourceRect: input.rect,
      });
      logger.info('skill.extracted', { id: skill.id, name: skill.name });
      return skill;
    },
  );
}

export function registerSkillsUnavailableIpc(reason: string): void {
  const message = `Skills database unavailable. (${reason})`;
  const fail = (): never => {
    throw new CodesignError(message, 'SNAPSHOTS_UNAVAILABLE');
  };
  for (const channel of SKILLS_CHANNELS_V1) {
    ipcMain.handle(channel, fail);
  }
}
