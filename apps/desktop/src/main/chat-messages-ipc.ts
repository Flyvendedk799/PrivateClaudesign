/**
 * IPC handlers for the Sidebar v2 chat_messages table.
 *
 * Channels are namespaced chat:v1:* and independent from snapshots:v1:*
 * so that a future chat-only schema migration can bump version without
 * touching snapshot callers.
 */

import { writeFile } from 'node:fs/promises';
import type {
  ChatAppendInput,
  ChatMessageKind,
  ChatMessageRow,
  Design,
  DesignFile,
  DesignSnapshot,
} from '@open-codesign/shared';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { dialog, ipcMain } from './electron-runtime';
import { seedGameArtifactsFromLatestSnapshot } from './game-artifacts-db';
import { getLogger } from './logger';
import {
  appendChatMessage,
  getDesign,
  getDesignCurrentSession,
  listChatMessages,
  listDesignFiles,
  listSnapshots,
  newChatSession,
  seedChatFromSnapshots,
  seedDesignFilesFromLatestSnapshot,
  setDesignCurrentSession,
  updateChatToolCallStatus,
} from './snapshots-db';

type Database = BetterSqlite3.Database;

const logger = getLogger('chat-messages-ipc');

export interface ChatDebugHandoffResponse {
  status: 'saved' | 'cancelled';
  path?: string;
  bytes?: number;
}

interface ChatDebugHandoffInput {
  designId: string;
  sessionId: number;
}

export interface BuildDebugHandoffMarkdownInput {
  design: Design;
  sessionId: number;
  messages: readonly ChatMessageRow[];
  files: readonly DesignFile[];
  latestSnapshot: DesignSnapshot | null;
  exportedAt: string;
}

const MAX_INLINE_FILE_CHARS = 180_000;
const MAX_INLINE_PAYLOAD_CHARS = 16_000;

const VALID_KINDS: ChatMessageKind[] = [
  'user',
  'assistant_text',
  'tool_call',
  'artifact_delivered',
  'error',
  // Backlog-3 §5 — checkpoint rows persist mid-run state for resume.
  'checkpoint',
  // Phase 2 — adaptive-thinking rollup. Schema added 2026-05-07; this
  // IPC validator was missed in that PR, so every reasoning_summary
  // append throws "kind must be one of: ..." and the row is silently
  // dropped (writer logs `appendChatMessage failed` and moves on).
  // Run mow70baw-4q4ni4 (claude-opus-4-7, 2026-05-08) hit this 30+
  // times — every thinking burst rollup was rejected, which is why
  // the FPS-game design's reasoning history is empty in the DB
  // despite Opus emitting plenty of thinking_delta events.
  'reasoning_summary',
  // Phase 4 — continuation_pending rows mark a clean pause point so
  // resume can rehydrate brief + plan + recap. Same omission story
  // as reasoning_summary above.
  'continuation_pending',
];

/** may9 Phase 15 #29 — exhaustiveness-test escape hatch. The runtime
 *  array stays a private const so production callers cannot mutate it;
 *  the test imports this getter to compare against ChatMessageKind.options
 *  per the lockstep rule documented in the project memory. */
export function _getValidKindsForTests(): readonly ChatMessageKind[] {
  return VALID_KINDS;
}

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

function parseDebugHandoffInput(raw: unknown): ChatDebugHandoffInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError(
      'chat:v1:export-debug-handoff expects an object payload',
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  const r = raw as Record<string, unknown>;
  requireSchemaV1(r, 'chat:v1:export-debug-handoff');
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

function filenameSegment(raw: string): string {
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean.length > 0 ? clean.slice(0, 48) : 'design';
}

function redactText(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]')
    .replace(
      /\b(api[_-]?key|authorization|bearer|password|token)(\s*[:=]\s*)(["']?)[^\s"',;)}\]]{8,}/gi,
      (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}[redacted]`,
    );
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function languageForPath(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'py':
      return 'python';
    case 'gd':
      return 'gdscript';
    case 'svg':
      return 'xml';
    default:
      return '';
  }
}

function markdownFence(content: string, language = ''): string {
  const maxTicks = Math.max(2, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(maxTicks + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}

function safeJson(value: unknown, maxChars = MAX_INLINE_PAYLOAD_CHARS): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  text = redactText(text);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function compactPayload(row: ChatMessageRow): unknown {
  const payload = objectPayload(row.payload);
  if (row.kind === 'reasoning_summary') {
    const fullText = typeof payload['fullText'] === 'string' ? payload['fullText'] : '';
    const { fullText: _fullText, ...rest } = payload;
    return {
      ...rest,
      reasoningText: `[omitted from debug handoff: ${fullText.length} chars]`,
    };
  }
  if (row.kind === 'tool_call') {
    const result = payload['result'];
    const resultText = result === undefined ? undefined : safeJson(result, 4000);
    return {
      toolName: payload['toolName'],
      command: payload['command'],
      status: payload['status'],
      verbGroup: payload['verbGroup'],
      durationMs: payload['durationMs'],
      args: payload['args'],
      ...(payload['error'] !== undefined ? { error: payload['error'] } : {}),
      ...(resultText !== undefined ? { result: resultText } : {}),
    };
  }
  return row.payload;
}

function messageSummary(row: ChatMessageRow): string {
  const payload = objectPayload(row.payload);
  if (row.kind === 'user') {
    const text = typeof payload['text'] === 'string' ? payload['text'] : safeJson(row.payload);
    return redactText(text);
  }
  if (row.kind === 'assistant_text') {
    const text = typeof payload['text'] === 'string' ? payload['text'] : safeJson(row.payload);
    return redactText(text);
  }
  if (row.kind === 'error') {
    return safeJson(row.payload);
  }
  if (row.kind === 'artifact_delivered') {
    return safeJson(row.payload);
  }
  if (row.kind === 'continuation_pending') {
    return safeJson(row.payload);
  }
  return safeJson(compactPayload(row));
}

function fileEntryMarkdown(file: Pick<DesignFile, 'path' | 'content' | 'updatedAt'>): string {
  const size = byteLength(file.content);
  if (file.content.startsWith('data:')) {
    const comma = file.content.indexOf(',');
    const media = comma > 0 ? file.content.slice(5, comma) : 'data-url';
    return `### \`${file.path}\`\n\nData URL omitted (${media}, ${size} bytes).`;
  }
  const redacted = redactText(file.content);
  const body =
    redacted.length <= MAX_INLINE_FILE_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[truncated ${
          redacted.length - MAX_INLINE_FILE_CHARS
        } chars]`;
  return `### \`${file.path}\`\n\n${markdownFence(body, languageForPath(file.path))}`;
}

function errorSignals(messages: readonly ChatMessageRow[]): string[] {
  const signals: string[] = [];
  for (const row of messages) {
    const payload = objectPayload(row.payload);
    if (row.kind === 'error') {
      const message =
        typeof payload['message'] === 'string' ? payload['message'] : safeJson(row.payload, 1000);
      signals.push(`- seq ${row.seq} error: ${redactText(message)}`);
    }
    if (row.kind === 'tool_call') {
      const status = payload['status'];
      if (status === 'error') {
        const tool = typeof payload['toolName'] === 'string' ? payload['toolName'] : 'tool_call';
        const err = objectPayload(payload['error']);
        const message =
          typeof err['message'] === 'string'
            ? err['message']
            : typeof payload['errorMessage'] === 'string'
              ? payload['errorMessage']
              : 'tool call failed';
        signals.push(`- seq ${row.seq} ${tool}: ${redactText(message)}`);
      }
    }
  }
  return signals.slice(-12);
}

function latestUserBrief(messages: readonly ChatMessageRow[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    if (row?.kind !== 'user') continue;
    const payload = objectPayload(row.payload);
    if (typeof payload['text'] === 'string' && payload['text'].trim().length > 0) {
      return redactText(payload['text'].trim());
    }
  }
  return '(no user message in this chat)';
}

export function buildDebugHandoffMarkdown(input: BuildDebugHandoffMarkdownInput): string {
  const sessionMessages = input.messages.filter((msg) => (msg.sessionId ?? 0) === input.sessionId);
  const latest = input.latestSnapshot;
  const files =
    input.files.length > 0
      ? input.files
      : latest !== null
        ? [
            {
              schemaVersion: 1 as const,
              id: `${latest.id}:artifact`,
              designId: input.design.id,
              path: 'snapshot-artifact.html',
              content: latest.artifactSource,
              createdAt: latest.createdAt,
              updatedAt: latest.createdAt,
            },
          ]
        : [];

  const signals = errorSignals(sessionMessages);
  const tree =
    files.length === 0
      ? '(no generated files found)'
      : files
          .map((f) => `- \`${f.path}\` (${byteLength(f.content)} bytes, updated ${f.updatedAt})`)
          .join('\n');
  const transcript =
    sessionMessages.length === 0
      ? '(no messages in this chat session)'
      : sessionMessages
          .map(
            (row) =>
              `### seq ${row.seq} - ${row.kind} - ${row.createdAt}\n\n${markdownFence(
                messageSummary(row),
                row.kind === 'tool_call' ? 'json' : '',
              )}`,
          )
          .join('\n\n');
  const sourceFiles =
    files.length === 0 ? '(no source files available)' : files.map(fileEntryMarkdown).join('\n\n');

  return `# Open CoDesign Debug Handoff

This file is designed to be attached to an agentic AI coding assistant. Ask it to inspect the transcript and source files, identify the likely bug, patch the code with the smallest safe change, and verify the result.

## Suggested Agent Prompt

${markdownFence(
  `You are debugging an Open CoDesign generated project.

Use the handoff below as the source of truth. First identify the user-visible failure or unfinished request from the chat transcript. Then inspect the included source files, make a minimal fix, and explain how to verify it. Preserve unrelated behavior and avoid rewriting the whole project unless the code is unrecoverable.`,
  'text',
)}

## Project

- Design: ${input.design.name}
- Design id: ${input.design.id}
- Chat session: ${input.sessionId}
- Exported at: ${input.exportedAt}
- Messages included: ${sessionMessages.length}
- Files included: ${files.length}
- Latest snapshot: ${latest ? `${latest.id} (${latest.artifactType}, ${latest.createdAt})` : 'none'}
- Workspace: ${input.design.workspacePath ?? 'internal storage'}

## Latest User Request

${markdownFence(latestUserBrief(sessionMessages))}

## Problem Signals

${signals.length > 0 ? signals.join('\n') : '- No explicit error rows or failed tool calls in this chat.'}

## Current File Tree

${tree}

## Chat Transcript

${transcript}

## Source Files

${sourceFiles}
`;
}

export const CHAT_MESSAGES_CHANNELS_V1 = [
  'chat:v1:list',
  'chat:v1:append',
  'chat:v1:seed-from-snapshots',
  'chat:update-tool-status:v1',
  'chat:v1:new-session',
  'chat:v1:current-session',
  'chat:v1:set-session',
  'chat:v1:export-debug-handoff',
] as const;

export function registerChatMessagesIpc(
  db: Database,
  getWindow: () => BrowserWindow | null = () => null,
): void {
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
      // game-artifacts §10 — hydrate the sprite/animation registry from
      // the latest snapshot when reopening a design cold so the new tabs
      // populate without forcing the user to re-import. Skips when the
      // registry is already populated this session.
      try {
        const restoredArtifacts = seedGameArtifactsFromLatestSnapshot(db, designId);
        if (restoredArtifacts.artifacts > 0 || restoredArtifacts.bindings > 0) {
          logger.info('game_artifacts.seeded', { designId, ...restoredArtifacts });
        }
      } catch (err) {
        logger.error('game_artifacts.seed.fail', {
          designId,
          message: err instanceof Error ? err.message : String(err),
        });
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

  ipcMain.handle(
    'chat:v1:export-debug-handoff',
    async (_e: unknown, raw: unknown): Promise<ChatDebugHandoffResponse> => {
      const input = parseDebugHandoffInput(raw);
      const design = getDesign(db, input.designId);
      if (design === null) {
        throw new CodesignError('designId references a missing design', ERROR_CODES.IPC_BAD_INPUT);
      }

      const now = new Date().toISOString();
      const stamp = now.replace(/[:.]/g, '-').slice(0, 19);
      const defaultFilename = `codesign-debug-${filenameSegment(design.name)}-chat-${
        input.sessionId
      }-${stamp}.md`;
      const opts: Electron.SaveDialogOptions = {
        title: 'Export debug handoff',
        defaultPath: defaultFilename,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      };
      const win = getWindow();
      const picked = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (picked.canceled || !picked.filePath) {
        return { status: 'cancelled' };
      }

      const snapshots = listSnapshots(db, input.designId);
      const latestSnapshot = snapshots.at(-1) ?? null;
      const content = buildDebugHandoffMarkdown({
        design,
        sessionId: input.sessionId,
        messages: listChatMessages(db, input.designId),
        files: listDesignFiles(db, input.designId),
        latestSnapshot,
        exportedAt: now,
      });
      await writeFile(picked.filePath, content, 'utf8');
      const bytes = byteLength(content);
      logger.info('chat.export_debug_handoff', {
        designId: input.designId,
        sessionId: input.sessionId,
        path: picked.filePath,
        bytes,
      });
      return { status: 'saved', path: picked.filePath, bytes };
    },
  );

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
