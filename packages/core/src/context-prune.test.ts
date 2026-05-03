import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { buildTransformContext } from './context-prune.js';

function userMsg(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

function assistantWithToolCall(toolCallId: string, inputArg: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'ok' },
      {
        type: 'toolCall',
        id: toolCallId,
        name: 'str_replace_based_edit_tool',
        arguments: { inputArg },
      },
    ],
  } as unknown as AgentMessage;
}

function assistantWithEditorCall(
  toolCallId: string,
  path: string,
  command: 'view' | 'str_replace' | 'create' | 'insert' = 'view',
): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'ok' },
      {
        type: 'toolCall',
        id: toolCallId,
        name: 'str_replace_based_edit_tool',
        // Real pi-ai shape uses `arguments`, not `input`. The pre-fix code
        // looked at `input` — which was always undefined in production —
        // and silently failed (see 2026-04-28 trace moix9ivu).
        arguments: { command, path },
      },
    ],
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, body: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    content: [{ type: 'text', text: body }],
  } as unknown as AgentMessage;
}

function assistantText(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

describe('buildTransformContext — size-based block compaction with recent-turn window', () => {
  it('is a no-op when every block is under its cap', async () => {
    const transform = buildTransformContext();
    const messages: AgentMessage[] = [
      userMsg('hi'),
      assistantWithToolCall('t1', 'small'),
      toolResult('t1', 'small result'),
      assistantText('done'),
    ];
    const out = await transform(messages);
    expect(out).toEqual(messages);
  });

  it('stubs a large assistant text block even on the LATEST message', async () => {
    // Text cap applies to ALL turns. Guards against the `<artifact>` text
    // dump regression (assistant streamed 9 MB JSX as prose on the final turn).
    const transform = buildTransformContext();
    const huge = 'x'.repeat(50_000);
    const messages: AgentMessage[] = [userMsg('build it'), assistantText(huge)];
    const out = await transform(messages);
    const last = out[out.length - 1] as { content: Array<{ text?: string }> };
    const text = last.content[0]?.text ?? '';
    expect(text.startsWith('[prior assistant output dropped')).toBe(true);
    expect(text).toContain('50000B');
  });

  it('keeps a large toolCall.input verbatim inside the recent window', async () => {
    // The model's own just-written str_replace must stay full-fidelity so it
    // can pick the next old_str from memory instead of guessing.
    const transform = buildTransformContext();
    const bulk = 'a'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('build'),
      assistantWithToolCall('call-0', bulk),
      toolResult('call-0', 'ok'),
    ];
    const out = await transform(messages);
    const a = out[1] as {
      content: Array<{ type?: string; id?: string; arguments?: { inputArg?: string } }>;
    };
    const tc = a.content.find((c) => c.type === 'toolCall');
    expect(tc?.id).toBe('call-0');
    expect(tc?.arguments?.inputArg).toBe(bulk);
  });

  it('summarizes a large toolCall.arguments for older turns outside the window', async () => {
    const transform = buildTransformContext();
    const bulk = 'a'.repeat(30_000);
    const messages: AgentMessage[] = [userMsg('build')];
    messages.push(assistantWithToolCall('call-old', bulk));
    messages.push(toolResult('call-old', 'ok'));
    // Three more turns push call-old out of the 3-turn window.
    for (let i = 0; i < 3; i += 1) {
      messages.push(assistantWithToolCall(`t${i}`, 'small'));
      messages.push(toolResult(`t${i}`, 'ok'));
    }
    const out = await transform(messages);
    const oldAssistant = out[1] as {
      content: Array<{
        type?: string;
        id?: string;
        arguments?: {
          __codesign_stripped?: string;
          __codesign_original_bytes?: number;
        };
      }>;
    };
    const tc = oldAssistant.content.find((c) => c.type === 'toolCall');
    expect(tc?.id).toBe('call-old');
    // Directive string instead of a `_summarized: true` flag, so the model
    // can't echo the placeholder as a fresh tool call.
    expect(tc?.arguments?.__codesign_stripped).toMatch(/REDACTED/);
    expect(tc?.arguments?.__codesign_stripped).toMatch(/DO NOT reproduce/);
    expect(tc?.arguments?.__codesign_original_bytes ?? 0).toBeGreaterThan(20_000);
  });

  it('keeps a large toolResult verbatim inside the recent window', async () => {
    const transform = buildTransformContext();
    const bulk = 'y'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('x'),
      assistantWithToolCall('call-0', 'a'),
      toolResult('call-0', bulk),
    ];
    const out = await transform(messages);
    const tr = out[2] as { toolCallId?: string; content: Array<{ text?: string }> };
    expect(tr.toolCallId).toBe('call-0');
    expect(tr.content[0]?.text).toBe(bulk);
  });

  it('stubs large toolResult bodies for older turns outside the window', async () => {
    const transform = buildTransformContext();
    const bulk = 'y'.repeat(20_000);
    const messages: AgentMessage[] = [userMsg('x')];
    messages.push(assistantWithToolCall('call-old', 'a'));
    messages.push(toolResult('call-old', bulk));
    for (let i = 0; i < 3; i += 1) {
      messages.push(assistantWithToolCall(`t${i}`, 'small'));
      messages.push(toolResult(`t${i}`, 'ok'));
    }
    const out = await transform(messages);
    const tr = out[2] as { toolCallId?: string; content: Array<{ text?: string }> };
    expect(tr.toolCallId).toBe('call-old');
    expect(tr.content[0]?.text?.startsWith('[tool result dropped')).toBe(true);
  });

  it('leaves small blocks untouched regardless of position', async () => {
    const transform = buildTransformContext();
    const messages: AgentMessage[] = [userMsg('go')];
    for (let i = 0; i < 20; i += 1) {
      messages.push(assistantWithToolCall(`t${i}`, 'tiny'));
      messages.push(toolResult(`t${i}`, `tiny result ${i}`));
    }
    const out = await transform(messages);
    expect(out).toEqual(messages);
  });

  it('never modifies user messages', async () => {
    const transform = buildTransformContext();
    const opening = userMsg('x'.repeat(50_000));
    const messages: AgentMessage[] = [opening, assistantText('ok')];
    const out = await transform(messages);
    expect(out[0]).toBe(opening);
  });

  it('tightens to aggressive caps (ignoring window) when HARD_CAP_BYTES is exceeded', async () => {
    const transform = buildTransformContext();
    const messages: AgentMessage[] = [userMsg('go')];
    const midText = 'p'.repeat(6_000);
    for (let i = 0; i < 40; i += 1) {
      messages.push(assistantText(midText));
      messages.push(assistantWithToolCall(`t${i}`, 'p'.repeat(10_000)));
      messages.push(toolResult(`t${i}`, 'p'.repeat(10_000)));
    }
    const out = await transform(messages);
    let droppedTextCount = 0;
    for (const m of out) {
      if (m.role !== 'assistant') continue;
      const content = (m as { content: Array<{ type?: string; text?: string }> }).content;
      for (const c of content) {
        if (c.type === 'text' && c.text?.startsWith('[prior assistant output dropped')) {
          droppedTextCount += 1;
        }
      }
    }
    expect(droppedTextCount).toBeGreaterThanOrEqual(35);
  });
});

describe('buildTransformContext — active-file exemption (backlog-2 #3)', () => {
  it('keeps the most-recent active-file toolResults un-pruned even under aggressive mode', async () => {
    const transform = buildTransformContext();
    const messages: AgentMessage[] = [userMsg('go')];
    const bigBody = 'A'.repeat(20_000);
    // Push enough other-file noise so the global aggressive threshold trips.
    for (let i = 0; i < 12; i += 1) {
      messages.push(assistantWithToolCall(`noise-${i}`, 'noise'));
      messages.push(toolResult(`noise-${i}`, 'p'.repeat(10_000)));
    }
    // Now 6 active-file edits on index.html — these should survive.
    for (let i = 0; i < 6; i += 1) {
      messages.push(assistantWithEditorCall(`edit-${i}`, 'index.html'));
      messages.push(toolResult(`edit-${i}`, bigBody));
    }
    const out = await transform(messages);
    // The 6 most-recent index.html toolResults must keep their full body.
    for (let i = 0; i < 6; i += 1) {
      const tr = out.find(
        (m) => (m as unknown as { toolCallId?: string }).toolCallId === `edit-${i}`,
      ) as { content: Array<{ text: string }> } | undefined;
      const txt = tr?.content[0]?.text ?? '';
      expect(txt.length).toBe(bigBody.length);
      expect(txt.startsWith('[tool result dropped')).toBe(false);
    }
  });

  it('only the most-recent active file counts (switch from styles.css to index.html drops styles.css)', async () => {
    const transform = buildTransformContext();
    const big = 'b'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('go'),
      // Older edits on styles.css
      assistantWithEditorCall('css-1', 'styles.css'),
      toolResult('css-1', big),
      // Then newer edits on index.html — index.html becomes active
      assistantWithEditorCall('html-1', 'index.html'),
      toolResult('html-1', big),
      // Plus enough noise to push into aggressive mode
      ...Array.from({ length: 14 }, (_, i) => [
        assistantWithToolCall(`n-${i}`, 'n'.repeat(10_000)),
        toolResult(`n-${i}`, 'n'.repeat(10_000)),
      ]).flat(),
    ];
    const out = await transform(messages);
    // index.html result kept verbatim
    const htmlRes = out.find(
      (m) => (m as unknown as { toolCallId?: string }).toolCallId === 'html-1',
    ) as { content: Array<{ text: string }> } | undefined;
    expect(htmlRes?.content[0]?.text.startsWith('[tool result dropped')).toBe(false);
    // styles.css result stubbed (under aggressive mode, no active-file
    // exemption since index.html displaced it)
    const cssRes = out.find(
      (m) => (m as unknown as { toolCallId?: string }).toolCallId === 'css-1',
    ) as { content: Array<{ text: string }> } | undefined;
    expect(cssRes?.content[0]?.text.startsWith('[tool result dropped')).toBe(true);
  });

  it('falls back gracefully when no text_editor calls have happened (returns null)', async () => {
    const transform = buildTransformContext();
    const big = 'p'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('go'),
      // Assistant with no toolCall, just chat — no active file detectable.
      assistantText('thinking…'),
      // Push into aggressive mode via noise via a non-text_editor tool name
      ...Array.from({ length: 14 }, (_, i) => [
        {
          role: 'assistant' as const,
          content: [
            { type: 'text', text: 'ok' },
            {
              type: 'toolCall',
              id: `web-${i}`,
              name: 'read_url',
              arguments: { url: 'https://example.com' },
            },
          ],
        } as unknown as AgentMessage,
        toolResult(`web-${i}`, big),
      ]).flat(),
    ];
    // Should not throw and should still aggressively prune (no active file
    // means no exemption). The 14 read_url results all get stubbed.
    const out = await transform(messages);
    let stubbed = 0;
    for (const m of out) {
      if (m.role !== 'toolResult') continue;
      const txt = (m as unknown as { content: Array<{ text: string }> }).content[0]?.text ?? '';
      if (txt.startsWith('[tool result dropped')) stubbed += 1;
    }
    expect(stubbed).toBeGreaterThanOrEqual(10);
  });
});
