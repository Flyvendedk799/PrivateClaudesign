/**
 * Gameimprove §1 — buildHistoryFromChatRows must reconstruct the agent's
 * prior tool transcript so follow-up turns don't re-`view` files from
 * scratch. Pure-function test against fixture chat rows.
 */

import type { ChatMessage } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { buildHistoryFromChatRows, capHistoryToTurnBoundary } from './store';

type Row = { kind: string; payload?: unknown };

function userRow(text: string): Row {
  return { kind: 'user', payload: { text } };
}

function toolCallRow(opts: {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: 'done' | 'error';
}): Row {
  return {
    kind: 'tool_call',
    payload: {
      toolName: opts.toolName,
      toolCallId: opts.toolCallId,
      args: opts.args ?? {},
      result: opts.result,
      status: opts.status ?? 'done',
    },
  };
}

function assistantTextRow(text: string): Row {
  return { kind: 'assistant_text', payload: { text } };
}

describe('buildHistoryFromChatRows', () => {
  it('returns empty for empty input', () => {
    expect(buildHistoryFromChatRows([])).toEqual([]);
  });

  it('keeps a single user prompt + assistant text turn unchanged when no tools fired', () => {
    const rows: Row[] = [
      userRow('build a landing page'),
      assistantTextRow('done — landing page shipped'),
    ];
    const out = buildHistoryFromChatRows(rows);
    expect(out).toEqual([
      { role: 'user', content: 'build a landing page' },
      { role: 'assistant', content: 'done — landing page shipped' },
    ]);
  });

  it('reconstructs an assistant→tool pair for a single-call turn (full detail)', () => {
    const rows: Row[] = [
      userRow('add a hero section'),
      toolCallRow({
        toolName: 'text_editor',
        toolCallId: 'call-1',
        args: { command: 'str_replace', path: 'index.html' },
        result: 'edit applied',
        status: 'done',
      }),
      assistantTextRow('done — hero added'),
    ];
    const out = buildHistoryFromChatRows(rows);
    expect(out).toEqual([
      { role: 'user', content: 'add a hero section' },
      {
        role: 'assistant',
        content: 'done — hero added',
        toolCalls: [
          {
            id: 'call-1',
            name: 'text_editor',
            argsJson: '{"command":"str_replace","path":"index.html"}',
          },
        ],
      },
      {
        role: 'tool',
        content: 'edit applied',
        toolCallId: 'call-1',
        toolName: 'text_editor',
        isError: false,
      },
    ]);
  });

  it('marks tool result as error when status=error', () => {
    const rows: Row[] = [
      userRow('refactor'),
      toolCallRow({
        toolName: 'text_editor',
        toolCallId: 'call-bad',
        args: { command: 'str_replace' },
        result: { error: 'old_str not found' },
        status: 'error',
      }),
    ];
    const out = buildHistoryFromChatRows(rows);
    const toolMsg = out.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.isError).toBe(true);
  });

  it('condenses an OLD turn (beyond the recent-turns window) into a one-line summary', () => {
    // 3 turns: only the last 2 should be in full detail; turn 1 condenses.
    const rows: Row[] = [
      userRow('turn 1'),
      toolCallRow({ toolName: 'text_editor', toolCallId: 'a1', args: {}, status: 'done' }),
      toolCallRow({ toolName: 'verify_artifact', toolCallId: 'a2', status: 'error' }),
      assistantTextRow('done turn 1'),

      userRow('turn 2'),
      toolCallRow({ toolName: 'text_editor', toolCallId: 'b1', args: {}, status: 'done' }),
      assistantTextRow('done turn 2'),

      userRow('turn 3'),
      toolCallRow({ toolName: 'text_editor', toolCallId: 'c1', args: {}, status: 'done' }),
      assistantTextRow('done turn 3'),
    ];
    const out = buildHistoryFromChatRows(rows);
    // Turn 1 should appear as user + a single condensed assistant message.
    // Turn 2 + 3 should each have a full tool transcript pair.
    const userMsgs = out.filter((m) => m.role === 'user');
    expect(userMsgs.map((m) => m.content)).toEqual(['turn 1', 'turn 2', 'turn 3']);

    // Turn 1's collapsed message should mention both tools + the error count.
    const condensed = out[1];
    expect(condensed?.role).toBe('assistant');
    expect(condensed?.content).toMatch(/prior turn condensed/);
    expect(condensed?.content).toMatch(/text_editor/);
    expect(condensed?.content).toMatch(/verify_artifact/);
    expect(condensed?.content).toMatch(/1 error/);
    // Critically: condensed turn must NOT include toolCalls (no full
    // detail) and must NOT spawn a tool result message.
    expect(condensed?.toolCalls).toBeUndefined();

    // Turn 2 and 3 should produce assistant+tool pairs (full detail).
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['b1', 'c1']);
  });

  it("truncates very long tool results so a 100KB view doesn't balloon the payload", () => {
    const huge = 'x'.repeat(50_000);
    const rows: Row[] = [
      userRow('peek at a giant file'),
      toolCallRow({
        toolName: 'text_editor',
        toolCallId: 'big',
        args: { command: 'view' },
        result: huge,
        status: 'done',
      }),
    ];
    const out = buildHistoryFromChatRows(rows);
    const toolMsg = out.find((m) => m.role === 'tool');
    expect(toolMsg?.content.length).toBeLessThan(huge.length);
    expect(toolMsg?.content).toMatch(/truncated/);
  });

  it('skips tool_call rows that lack toolCallId (defensive — schema-broken rows)', () => {
    const rows: Row[] = [
      userRow('ping'),
      // Missing toolCallId — would otherwise lose pi-ai's id pairing.
      { kind: 'tool_call', payload: { toolName: 'text_editor', args: {}, status: 'done' } },
      assistantTextRow('done'),
    ];
    const out = buildHistoryFromChatRows(rows);
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(0);
  });

  it('handles tool_call rows that arrive before any user row by ignoring them (defensive)', () => {
    const rows: Row[] = [
      toolCallRow({ toolName: 'text_editor', toolCallId: 'orphan', status: 'done' }),
      userRow('the actual prompt'),
      toolCallRow({ toolName: 'text_editor', toolCallId: 'real', status: 'done' }),
    ];
    const out = buildHistoryFromChatRows(rows);
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['real']);
  });

  it('drops empty user rows (safety against zero-length text)', () => {
    const rows: Row[] = [{ kind: 'user', payload: { text: '' } }, userRow('real prompt')];
    const out = buildHistoryFromChatRows(rows);
    const userMsgs = out.filter((m) => m.role === 'user');
    expect(userMsgs.map((m) => m.content)).toEqual(['real prompt']);
  });

  it('emits a budget-clip marker when the byte budget would be exceeded', () => {
    // Build a turn with many tool calls each carrying a large result;
    // total exceeds the 120KB cap, so the function should clip.
    const big = 'y'.repeat(8000);
    const tools: Row[] = [];
    for (let i = 0; i < 60; i++) {
      tools.push(
        toolCallRow({
          toolName: 'text_editor',
          toolCallId: `c${i}`,
          args: { command: 'view' },
          result: big,
          status: 'done',
        }),
      );
    }
    const rows: Row[] = [userRow('huge edit session'), ...tools];
    const out = buildHistoryFromChatRows(rows);
    // Some — but not all — tool pairs must have been included.
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(toolMsgs.length).toBeLessThan(60);
    // A clip marker should be present.
    const clipMarker = out.find(
      (m) => m.role === 'assistant' && m.content.startsWith('[tool transcript clipped'),
    );
    expect(clipMarker).toBeDefined();
  });
});

describe('capHistoryToTurnBoundary', () => {
  const u = (content: string): ChatMessage => ({ role: 'user', content });
  const a = (content: string, toolCalls?: ChatMessage['toolCalls']): ChatMessage =>
    toolCalls === undefined
      ? { role: 'assistant', content }
      : { role: 'assistant', content, toolCalls };
  const t = (content: string, toolCallId: string, toolName = 'text_editor'): ChatMessage => ({
    role: 'tool',
    content,
    toolCallId,
    toolName,
    isError: false,
  });

  it('returns input unchanged when under cap', () => {
    const history: ChatMessage[] = [u('hi'), a('done')];
    expect(capHistoryToTurnBoundary(history, 12)).toEqual(history);
  });

  it('trims leading tool/assistant rows so the array starts on a user turn', () => {
    // 5 messages: assistant(toolCalls) + tool + user + assistant(toolCalls) + tool.
    // Cap of 4 would naively slice from index 1 — leaving a `tool` first.
    // capHistoryToTurnBoundary must drop forward to the first `user`.
    const history: ChatMessage[] = [
      a('', [{ id: 'c1', name: 'text_editor', argsJson: '{}' }]),
      t('ok', 'c1'),
      u('next prompt'),
      a('done', [{ id: 'c2', name: 'text_editor', argsJson: '{}' }]),
      t('ok', 'c2'),
    ];
    const out = capHistoryToTurnBoundary(history, 4);
    expect(out[0]?.role).toBe('user');
    expect(out[0]?.content).toBe('next prompt');
    expect(out).toHaveLength(3);
  });

  it('returns empty when slice contains no user row at all', () => {
    // Pathological: slice contains only an orphaned tool result. Drop it
    // entirely rather than send a malformed request to the provider.
    const history: ChatMessage[] = [t('ok', 'orphan')];
    expect(capHistoryToTurnBoundary(history, 12)).toEqual([]);
  });
});

describe('buildHistoryFromChatRows session filter (in-design new conversation)', () => {
  it('returns all rows when no sessionId filter is provided', () => {
    const rows: Array<Row & { sessionId?: number }> = [
      { ...userRow('s0 prompt'), sessionId: 0 },
      { ...assistantTextRow('s0 done'), sessionId: 0 },
      { ...userRow('s1 prompt'), sessionId: 1 },
      { ...assistantTextRow('s1 done'), sessionId: 1 },
    ];
    const out = buildHistoryFromChatRows(rows);
    // Two user prompts → two assistant turns → 4 messages total.
    expect(out.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('drops rows from prior sessions when sessionId=current is passed', () => {
    const rows: Array<Row & { sessionId?: number }> = [
      { ...userRow('old prompt'), sessionId: 0 },
      { ...assistantTextRow('old done'), sessionId: 0 },
      { ...userRow('fresh prompt'), sessionId: 1 },
      { ...assistantTextRow('fresh done'), sessionId: 1 },
    ];
    const out = buildHistoryFromChatRows(rows, { sessionId: 1 });
    expect(out.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(out[0]?.content).toBe('fresh prompt');
  });

  it('treats missing sessionId as session 0 for legacy rows', () => {
    const rows: Array<Row & { sessionId?: number }> = [
      // Legacy row pre-migration (no sessionId field at all).
      { ...userRow('legacy prompt') },
      { ...assistantTextRow('legacy done') },
    ];
    const out = buildHistoryFromChatRows(rows, { sessionId: 0 });
    expect(out.filter((m) => m.role === 'user')).toHaveLength(1);
    // Filtering to a non-zero session removes the legacy rows.
    const out1 = buildHistoryFromChatRows(rows, { sessionId: 1 });
    expect(out1).toEqual([]);
  });

  it('returns empty when the requested session has no rows', () => {
    const rows: Array<Row & { sessionId?: number }> = [
      { ...userRow('s0 prompt'), sessionId: 0 },
      { ...assistantTextRow('s0 done'), sessionId: 0 },
    ];
    expect(buildHistoryFromChatRows(rows, { sessionId: 99 })).toEqual([]);
  });
});
