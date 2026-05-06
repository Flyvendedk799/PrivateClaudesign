/**
 * IPC handlers for the Sidebar v2 chat_messages table.
 *
 * Channels are namespaced chat:v1:* and independent from snapshots:v1:*
 * so that a future chat-only schema migration can bump version without
 * touching snapshot callers.
 */

import type { ChatAppendInput, ChatMessageKind, ChatMessageRow } from '@open-codesign/shared';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { ipcMain } from './electron-runtime';
import { getLogger } from './logger';
import {
  appendChatMessage,
  getDesignCurrentSession,
  listChatMessages,
  newChatSession,
  seedChatFromSnapshots,
  seedDesignFilesFromLatestSnapshot,
  setDesignCurrentSession,
  updateChatToolCallStatus,
} from './snapshots-db';

type Database = BetterSqlite3.Database;

const logger = getLogger('chat-messages-ipc');

const VALID_KINDS: ChatMessageKind[] = [
  'user',
  'assistant_text',
  'tool_call',
  'artifact_delivered',
  'error',
  // Backlog-3 §5 — checkpoint rows persist mid-run state for resume.
  'checkpoint',
];

function requireSchemaV1(r: Record<string, unknown>, channel: string): void {
  if (r['schemaVersion'] !== 1) {
    throw new CodesignError(`${channel} requires schemaVersion: 1`, ERROR_CODES.IPC_BAD_INPUT);
  }
}

function parseDesignId(raw: unknown, channel: string): string {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(
      `${channel} expects an object with designId`,
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, channel);
  if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
    throw new CodesignError('designId must be a non-empty string', ERROR_CODES.IPC_BAD_INPUT);
  }
  return r['designId'] as string;
}

function parseAppendInput(raw: unknown): ChatAppendInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('chat:v1:append expects an object payload', ERROR_CODES.IPC_BAD_INPUT);
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'chat:v1:append');
  if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
    throw new CodesignError('designId must be a non-empty string', ERROR_CODES.IPC_BAD_INPUT);
  }
  const kind = r['kind'];
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as ChatMessageKind)) {
    throw new CodesignError(
      `kind must be one of: ${VALID_KINDS.join(', ')}`,
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  const snapshotId = r['snapshotId'];
  if (snapshotId !== undefined && snapshotId !== null && typeof snapshotId !== 'string') {
    throw new CodesignError(
      'snapshotId must be a string, null, or absent',
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  return {
    designId: r['designId'],
    kind: kind as ChatMessageKind,
    payload: r['payload'] ?? {},
    ...(snapshotId !== undefined ? { snapshotId: snapshotId as string | null } : {}),
  };
}

function parseUpdateToolStatus(raw: unknown): {
  designId: string;
  seq: number;
  status: 'done' | 'error';
  errorMessage?: string;
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(
      'chat:update-tool-status:v1 expects an object payload',
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'chat:update-tool-status:v1');
  if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
    throw new CodesignError('designId must be a non-empty string', ERROR_CODES.IPC_BAD_INPUT);
  }
  if (typeof r['seq'] !== 'number' || !Number.isInteger(r['seq']) || r['seq'] < 0) {
    throw new CodesignError('seq must be a non-negative integer', ERROR_CODES.IPC_BAD_INPUT);
  }
  const status = r['status'];
  if (status !== 'done' && status !== 'error') {
    throw new CodesignError("status must be 'done' or 'error'", ERROR_CODES.IPC_BAD_INPUT);
  }
  const errorMessage = r['errorMessage'];
  if (errorMessage !== undefined && typeof errorMessage !== 'string') {
    throw new CodesignError(
      'errorMessage must be a string when present',
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  return {
    designId: r['designId'],
    seq: r['seq'],
    status,
    ...(typeof errorMessage === 'string' ? { errorMessage } : {}),
  };
}

function parseSetSession(raw: unknown): { designId: string; sessionId: number } {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(
      'chat:v1:set-session expects an object payload',
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'chat:v1:set-session');
  if (typeof r['designId'] !== 'string' || r['designId'].trim().length === 0) {
    throw new CodesignError('designId must be a non-empty string', ERROR_CODES.IPC_BAD_INPUT);
  }
  if (
    typeof r['sessionId'] !== 'number' ||
    !Number.isInteger(r['sessionId']) ||
    r['sessionId'] < 0
  ) {
    throw new CodesignError('sessionId must be a non-negative integer', ERROR_CODES.IPC_BAD_INPUT);
  }
  return { designId: r['designId'], sessionId: r['sessionId'] };
}

export const CHAT_MESSAGES_CHANNELS_V1 = [
  'chat:v1:list',
  'chat:v1:append',
  'chat:v1:seed-from-snapshots',
  'chat:update-tool-status:v1',
  'chat:v1:new-session',
  'chat:v1:current-session',
  'chat:v1:set-session',
] as const;

export function registerChatMessagesIpc(db: Database): void {
  ipcMain.handle('chat:v1:list', (_e: unknown, raw: unknown): ChatMessageRow[] => {
    const designId = parseDesignId(raw, 'chat:v1:list');
    return listChatMessages(db, designId);
  });

  ipcMain.handle('chat:v1:append', (_e: unknown, raw: unknown): ChatMessageRow => {
    const input = parseAppendInput(raw);
    try {
      const row = appendChatMessage(db, input);
      logger.info('chat.append', { designId: input.designId, seq: row.seq, kind: input.kind });
      return row;
    } catch (err) {
      logger.error('chat.append.fail', {
        designId: input.designId,
        kind: input.kind,
        message: err instanceof Error ? err.message : String(err),
      });
      throw new CodesignError('Failed to append chat message', ERROR_CODES.IPC_DB_ERROR, {
        cause: err,
      });
    }
  });

  ipcMain.handle(
    'chat:v1:seed-from-snapshots',
    (_e: unknown, raw: unknown): { inserted: number } => {
      const designId = parseDesignId(raw, 'chat:v1:seed-from-snapshots');
      const inserted = seedChatFromSnapshots(db, designId);
      if (inserted > 0) logger.info('chat.seeded', { designId, inserted });
      // Multi-file artifacts — when reopening a design that hasn't
      // been touched this session, restore the file tree from the
      // most recent snapshot so the iframe + Files panel see every
      // sidecar, not just the inlined index.html the legacy
      // single-blob path persisted. Idempotent: skips when
      // design_files is already populated.
      try {
        const restored = seedDesignFilesFromLatestSnapshot(db, designId);
        if (restored > 0) logger.info('design_files.seeded', { designId, restored });
      } catch (err) {
        logger.error('design_files.seed.fail', {
          designId,
          message: err instanceof Error ? err.message : String(err),
        });
        // Non-fatal — chat still seeded, the iframe falls back to srcdoc.
      }
      return { inserted };
    },
  );

  ipcMain.handle('chat:v1:new-session', (_e: unknown, raw: unknown): { sessionId: number } => {
    const designId = parseDesignId(raw, 'chat:v1:new-session');
    try {
      const sessionId = newChatSession(db, designId);
      logger.info('chat.new_session', { designId, sessionId });
      return { sessionId };
    } catch (err) {
      logger.error('chat.new_session.fail', {
        designId,
        message: err instanceof Error ? err.message : String(err),
      });
      throw new CodesignError('Failed to start a new chat session', ERROR_CODES.IPC_DB_ERROR, {
        cause: err,
      });
    }
  });

  ipcMain.handle('chat:v1:current-session', (_e: unknown, raw: unknown): { sessionId: number } => {
    const designId = parseDesignId(raw, 'chat:v1:current-session');
    return { sessionId: getDesignCurrentSession(db, designId) };
  });

  ipcMain.handle('chat:v1:set-session', (_e: unknown, raw: unknown): { sessionId: number } => {
    const input = parseSetSession(raw);
    try {
      const sessionId = setDesignCurrentSession(db, input.designId, input.sessionId);
      logger.info('chat.set_session', { designId: input.designId, sessionId });
      return { sessionId };
    } catch (err) {
      logger.error('chat.set_session.fail', {
        designId: input.designId,
        sessionId: input.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      throw new CodesignError('Failed to switch chat session', ERROR_CODES.IPC_DB_ERROR, {
        cause: err,
      });
    }
  });

  ipcMain.handle('chat:update-tool-status:v1', (_e: unknown, raw: unknown): { ok: true } => {
    const input = parseUpdateToolStatus(raw);
    try {
      updateChatToolCallStatus(db, input.designId, input.seq, input.status, input.errorMessage);
      return { ok: true };
    } catch (err) {
      logger.error('chat.update_tool_status.fail', {
        designId: input.designId,
        seq: input.seq,
        message: err instanceof Error ? err.message : String(err),
      });
      throw new CodesignError('Failed to update tool call status', ERROR_CODES.IPC_DB_ERROR, {
        cause: err,
      });
    }
  });
}

export function registerChatMessagesUnavailableIpc(reason: string): void {
  const message = `Chat history is unavailable. ${reason}`;
  const fail = (): never => {
    throw new CodesignError(message, ERROR_CODES.SNAPSHOTS_UNAVAILABLE);
  };
  for (const channel of CHAT_MESSAGES_CHANNELS_V1) {
    ipcMain.handle(channel, fail);
  }
}
