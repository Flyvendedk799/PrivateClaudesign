/**
 * IPC tests for chat:v1:* and chat:update-tool-status:v1 — exercises the
 * payload validation and DB round-trip without spinning up Electron.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('./electron-runtime', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

vi.mock('./logger', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { CodesignError } from '@open-codesign/shared';
import { buildDebugHandoffMarkdown, registerChatMessagesIpc } from './chat-messages-ipc';
import { appendChatMessage, createDesign, initInMemoryDb, listChatMessages } from './snapshots-db';

function invoke(channel: string, payload: unknown): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return fn({}, payload);
}

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  handlers.clear();
});

describe('chat:update-tool-status:v1', () => {
  it('flips a running tool_call row to done', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);

    const row = appendChatMessage(db, {
      designId: design.id,
      kind: 'tool_call',
      payload: {
        toolName: 'text_editor',
        args: {},
        status: 'running',
        startedAt: new Date().toISOString(),
        verbGroup: 'Working',
      },
    });

    const result = invoke('chat:update-tool-status:v1', {
      schemaVersion: 1,
      designId: design.id,
      seq: row.seq,
      status: 'done',
    });
    expect(result).toEqual({ ok: true });

    const list = listChatMessages(db, design.id);
    expect(list).toHaveLength(1);
    const payload = list[0]?.payload as { status: string };
    expect(payload.status).toBe('done');
  });

  it('records errorMessage when status is error', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);

    const row = appendChatMessage(db, {
      designId: design.id,
      kind: 'tool_call',
      payload: {
        toolName: 'text_editor',
        args: {},
        status: 'running',
        startedAt: new Date().toISOString(),
        verbGroup: 'Working',
      },
    });

    invoke('chat:update-tool-status:v1', {
      schemaVersion: 1,
      designId: design.id,
      seq: row.seq,
      status: 'error',
      errorMessage: 'boom',
    });

    const list = listChatMessages(db, design.id);
    const payload = list[0]?.payload as { status: string; errorMessage?: string };
    expect(payload.status).toBe('error');
    expect(payload.errorMessage).toBe('boom');
  });

  it('rejects payload missing schemaVersion', () => {
    const db = initInMemoryDb();
    registerChatMessagesIpc(db);
    expect(() =>
      invoke('chat:update-tool-status:v1', { designId: 'd', seq: 0, status: 'done' }),
    ).toThrow(CodesignError);
  });

  it('rejects unknown status', () => {
    const db = initInMemoryDb();
    registerChatMessagesIpc(db);
    expect(() =>
      invoke('chat:update-tool-status:v1', {
        schemaVersion: 1,
        designId: 'd',
        seq: 0,
        status: 'pending',
      }),
    ).toThrow(/status must be/);
  });

  it('is a silent no-op when the row does not exist', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);
    expect(() =>
      invoke('chat:update-tool-status:v1', {
        schemaVersion: 1,
        designId: design.id,
        seq: 999,
        status: 'done',
      }),
    ).not.toThrow();
  });
});

describe('chat:v1:append — VALID_KINDS coverage (regression for 2026-05-08 incident)', () => {
  // Run mow70baw-4q4ni4 (claude-opus-4-7, FPS-game design ba2adf62…)
  // produced 30+ "kind must be one of: ..." failures because the IPC
  // validator's allowlist hadn't been updated when reasoning_summary
  // and continuation_pending were added to the schema. Every thinking
  // burst rollup was silently dropped; the user saw the AI proceed
  // without context. This block locks every kind currently declared
  // in the schema.
  it('accepts reasoning_summary rows', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);
    expect(() =>
      invoke('chat:v1:append', {
        schemaVersion: 1,
        designId: design.id,
        kind: 'reasoning_summary',
        payload: {
          fullText: 'I should plan the hero before writing it.',
          durationMs: 12_400,
          tokenEstimate: 11,
          finalisedAt: '2026-05-08T01:00:00.000Z',
        },
      }),
    ).not.toThrow();
    const list = listChatMessages(db, design.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('reasoning_summary');
  });

  it('accepts continuation_pending rows', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);
    expect(() =>
      invoke('chat:v1:append', {
        schemaVersion: 1,
        designId: design.id,
        kind: 'continuation_pending',
        payload: {
          reason: 'wallclock',
          decisionRecap: 'Stopped mid-section to keep the run within budget.',
          outputTokens: 8000,
          contextUsedPct: 65,
          wallClockMs: 290_000,
        },
      }),
    ).not.toThrow();
    const list = listChatMessages(db, design.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('continuation_pending');
  });

  it('accepts every kind currently declared by the shared schema', () => {
    // If a new kind is added to ChatMessageKind without updating
    // VALID_KINDS, this test fails with a descriptive message instead
    // of producing a silent runtime drop in production.
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);
    const minimalPayloads: Record<string, unknown> = {
      user: { text: 'hi' },
      assistant_text: { text: 'hi' },
      tool_call: {
        toolName: 'text_editor',
        args: {},
        status: 'done',
        startedAt: '2026-05-08T00:00:00.000Z',
        verbGroup: 'Working',
      },
      artifact_delivered: { createdAt: '2026-05-08T00:00:00.000Z' },
      error: { message: 'boom', code: 'GENERATION_FAILED' },
      checkpoint: { reason: 'manual', createdAt: '2026-05-08T00:00:00.000Z' },
      reasoning_summary: {
        fullText: 'x',
        durationMs: 1,
        tokenEstimate: 1,
        finalisedAt: '2026-05-08T00:00:00.000Z',
      },
      continuation_pending: {
        reason: 'wallclock',
        decisionRecap: 'x',
        outputTokens: 1,
        contextUsedPct: 1,
        wallClockMs: 1,
      },
    };
    for (const [kind, payload] of Object.entries(minimalPayloads)) {
      expect(
        () =>
          invoke('chat:v1:append', {
            schemaVersion: 1,
            designId: design.id,
            kind,
            payload,
          }),
        `kind="${kind}" should be accepted by chat:v1:append validator`,
      ).not.toThrow();
    }
  });

  it('still rejects an unknown kind with the standard error', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);
    expect(() =>
      invoke('chat:v1:append', {
        schemaVersion: 1,
        designId: design.id,
        kind: 'totally_made_up',
        payload: {},
      }),
    ).toThrow(/kind must be one of/);
  });
});

describe('chat:v1:new-session + chat:v1:current-session', () => {
  it('returns 0 from current-session for a fresh design', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);
    const result = invoke('chat:v1:current-session', {
      schemaVersion: 1,
      designId: design.id,
    });
    expect(result).toEqual({ sessionId: 0 });
  });

  it('bumps the session id and stamps it onto subsequent appends', () => {
    const db = initInMemoryDb();
    const design = createDesign(db, 'T');
    registerChatMessagesIpc(db);

    appendChatMessage(db, { designId: design.id, kind: 'user', payload: { text: 'before' } });

    const created = invoke('chat:v1:new-session', {
      schemaVersion: 1,
      designId: design.id,
    });
    expect(created).toEqual({ sessionId: 1 });

    appendChatMessage(db, { designId: design.id, kind: 'user', payload: { text: 'after' } });

    const list = listChatMessages(db, design.id);
    expect(list[0]?.sessionId).toBe(0);
    expect(list[1]?.sessionId).toBe(1);

    const cur = invoke('chat:v1:current-session', {
      schemaVersion: 1,
      designId: design.id,
    });
    expect(cur).toEqual({ sessionId: 1 });
  });

  it('rejects non-string designId on new-session', () => {
    const db = initInMemoryDb();
    registerChatMessagesIpc(db);
    expect(() => invoke('chat:v1:new-session', { schemaVersion: 1, designId: 123 })).toThrow(
      CodesignError,
    );
  });

  it('throws when the design does not exist', () => {
    const db = initInMemoryDb();
    registerChatMessagesIpc(db);
    expect(() =>
      invoke('chat:v1:new-session', { schemaVersion: 1, designId: 'no-such-id' }),
    ).toThrow(/Failed to start a new chat session/);
  });
});

describe('buildDebugHandoffMarkdown', () => {
  it('exports only the selected chat session and includes project files plus failure signals', () => {
    const md = buildDebugHandoffMarkdown({
      design: {
        schemaVersion: 1,
        id: 'design-1',
        name: 'Broken Button',
        createdAt: '2026-05-20T10:00:00.000Z',
        updatedAt: '2026-05-20T10:05:00.000Z',
        thumbnailText: null,
        deletedAt: null,
        workspacePath: null,
        promptAssistMetadata: null,
        currentSessionId: 1,
        lastDecomposedArtifactHash: null,
      },
      sessionId: 1,
      exportedAt: '2026-05-20T10:10:00.000Z',
      latestSnapshot: null,
      messages: [
        {
          schemaVersion: 2,
          id: 1,
          designId: 'design-1',
          seq: 0,
          kind: 'user',
          payload: { text: 'Old chat that should not export' },
          snapshotId: null,
          createdAt: '2026-05-20T10:00:00.000Z',
          sessionId: 0,
        },
        {
          schemaVersion: 2,
          id: 2,
          designId: 'design-1',
          seq: 1,
          kind: 'user',
          payload: { text: 'Fix the broken checkout button' },
          snapshotId: null,
          createdAt: '2026-05-20T10:01:00.000Z',
          sessionId: 1,
        },
        {
          schemaVersion: 2,
          id: 3,
          designId: 'design-1',
          seq: 2,
          kind: 'tool_call',
          payload: {
            toolName: 'text_editor',
            args: { path: 'src/app.js' },
            status: 'error',
            error: { message: 'old string not found' },
            startedAt: '2026-05-20T10:02:00.000Z',
            verbGroup: 'Editing',
          },
          snapshotId: null,
          createdAt: '2026-05-20T10:02:00.000Z',
          sessionId: 1,
        },
        {
          schemaVersion: 2,
          id: 4,
          designId: 'design-1',
          seq: 3,
          kind: 'reasoning_summary',
          payload: {
            fullText: 'private reasoning text',
            durationMs: 10,
            tokenEstimate: 5,
            finalisedAt: '2026-05-20T10:03:00.000Z',
          },
          snapshotId: null,
          createdAt: '2026-05-20T10:03:00.000Z',
          sessionId: 1,
        },
      ],
      files: [
        {
          schemaVersion: 1,
          id: 'file-1',
          designId: 'design-1',
          path: 'src/app.js',
          content: 'export function App() { return "broken"; }',
          createdAt: '2026-05-20T10:01:00.000Z',
          updatedAt: '2026-05-20T10:04:00.000Z',
        },
      ],
    });

    expect(md).toContain('Fix the broken checkout button');
    expect(md).toContain('seq 2 text_editor: old string not found');
    expect(md).toContain('src/app.js');
    expect(md).toContain('export function App()');
    expect(md).not.toContain('Old chat that should not export');
    expect(md).not.toContain('private reasoning text');
    expect(md).toContain('reasoningText');
  });
});
