import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  GROUND_TRUTH_TOOL_NAMES,
  buildGroundTruthResultIds,
  buildToolNameMap,
  buildTransformContext,
  topByBytes,
} from './context-prune.js';

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

  it('Improver1 §1 — summarizes large toolCall.arguments with an echo-proof placeholder', async () => {
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
        name?: string;
        arguments?: Record<string, unknown>;
      }>;
    };
    const tc = oldAssistant.content.find((c) => c.type === 'toolCall');
    expect(tc?.id).toBe('call-old');
    // Improver1 §1 — placeholder MUST carry the poison marker so the
    // tool's execute body can short-circuit on echo. For
    // str_replace_based_edit_tool specifically the placeholder is
    // also schema-valid (command='view', path=sentinel) so ajv
    // doesn't pre-empt our intercept with its generic error.
    expect(tc?.arguments?.['__do_not_echo_this_object']).toBe(true);
    expect(tc?.arguments?.['__redaction_message']).toMatch(/REDACTED/);
    expect(tc?.arguments?.['__redaction_message']).toMatch(/never paste/i);
    expect((tc?.arguments?.['__redaction_original_bytes'] as number) ?? 0).toBeGreaterThan(20_000);
    // Belt-and-braces: when the tool name is the text editor, the
    // placeholder is also schema-valid for it.
    expect(tc?.name).toBe('str_replace_based_edit_tool');
    expect(tc?.arguments?.['command']).toBe('view');
    expect(tc?.arguments?.['path']).toBe('__redacted_history_placeholder__');
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

describe('buildTransformContext — Improver1 §11 tuning overrides', () => {
  it('respects toolResultLimit override on older turns', async () => {
    // Default toolResultLimit is 8 KB; with override = 1 KB and a 4 KB
    // toolResult parked outside the recent window, the result should
    // become a stub.
    const tight = buildTransformContext(undefined, { toolResultLimit: 1024 });
    const bulk = 'y'.repeat(4_000);
    const messages: AgentMessage[] = [userMsg('x')];
    messages.push(assistantWithToolCall('call-old', 'a'));
    messages.push(toolResult('call-old', bulk));
    for (let i = 0; i < 3; i += 1) {
      messages.push(assistantWithToolCall(`t${i}`, 'small'));
      messages.push(toolResult(`t${i}`, 'ok'));
    }
    const out = await tight(messages);
    const tr = out[2] as { content: Array<{ text?: string }> };
    expect(tr.content[0]?.text?.startsWith('[tool result dropped')).toBe(true);

    // Sanity: the same 4 KB body is well under the default 8 KB cap, so
    // the unmodified pruner leaves it alone.
    const loose = buildTransformContext();
    const out2 = await loose(messages);
    const tr2 = out2[2] as { content: Array<{ text?: string }> };
    expect(tr2.content[0]?.text).toBe(bulk);
  });

  it('respects recentWindow override (window=0 stubs everything older)', async () => {
    const transform = buildTransformContext(undefined, { recentWindow: 0 });
    const bulk = 'y'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('x'),
      assistantWithToolCall('call-0', 'a'),
      toolResult('call-0', bulk),
    ];
    const out = await transform(messages);
    // recentWindow=0 puts even the latest pair outside the window, so
    // the toolResult collapses to a stub.
    const tr = out[2] as { content: Array<{ text?: string }> };
    expect(tr.content[0]?.text?.startsWith('[tool result dropped')).toBe(true);
  });

  it('respects hardCapBytes override (lower cap fires aggressive mode sooner)', async () => {
    let aggressiveFired = false;
    const log = {
      info: (msg: string) => {
        if (msg.includes('step=aggressive') && !msg.includes('aggressive_dominant_msgs')) {
          aggressiveFired = true;
        }
      },
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    // ~30 KB of tiny blocks — well under the default 200 KB hard cap, so
    // aggressive mode normally never fires. Drop hardCapBytes to 8 KB
    // and the aggressive-mode log line must appear.
    const transform = buildTransformContext(log, { hardCapBytes: 8_000 });
    const messages: AgentMessage[] = [userMsg('go')];
    for (let i = 0; i < 30; i += 1) {
      messages.push(assistantWithToolCall(`t${i}`, 'a'.repeat(800)));
      messages.push(toolResult(`t${i}`, 'b'.repeat(800)));
    }
    await transform(messages);
    expect(aggressiveFired).toBe(true);
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

  it('Phase 2 — pins up to K=3 distinct active files; both styles.css and index.html survive', async () => {
    // Multi-file pinning. Older edits on styles.css + newer edits on
    // index.html — both should be preserved because the active-file set
    // now holds the K most-recent distinct paths, not just the last one.
    const transform = buildTransformContext();
    const big = 'b'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithEditorCall('css-1', 'styles.css'),
      toolResult('css-1', big),
      assistantWithEditorCall('html-1', 'index.html'),
      toolResult('html-1', big),
      // Push into aggressive mode.
      ...Array.from({ length: 14 }, (_, i) => [
        assistantWithToolCall(`n-${i}`, 'n'.repeat(10_000)),
        toolResult(`n-${i}`, 'n'.repeat(10_000)),
      ]).flat(),
    ];
    const out = await transform(messages);
    const htmlRes = out.find(
      (m) => (m as unknown as { toolCallId?: string }).toolCallId === 'html-1',
    ) as { content: Array<{ text: string }> } | undefined;
    expect(htmlRes?.content[0]?.text.startsWith('[tool result dropped')).toBe(false);
    const cssRes = out.find(
      (m) => (m as unknown as { toolCallId?: string }).toolCallId === 'css-1',
    ) as { content: Array<{ text: string }> } | undefined;
    expect(cssRes?.content[0]?.text.startsWith('[tool result dropped')).toBe(false);
  });

  it('Phase 2 — beyond K=3, the oldest file is no longer pinned', async () => {
    // Edits across 4 distinct paths in order: a.js, b.css, c.html, d.json.
    // With K=3, the {b.css, c.html, d.json} window survives; a.js drops.
    const transform = buildTransformContext();
    const big = 'b'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithEditorCall('a-1', 'a.js'),
      toolResult('a-1', big),
      assistantWithEditorCall('b-1', 'b.css'),
      toolResult('b-1', big),
      assistantWithEditorCall('c-1', 'c.html'),
      toolResult('c-1', big),
      assistantWithEditorCall('d-1', 'd.json'),
      toolResult('d-1', big),
      ...Array.from({ length: 14 }, (_, i) => [
        assistantWithToolCall(`n-${i}`, 'n'.repeat(10_000)),
        toolResult(`n-${i}`, 'n'.repeat(10_000)),
      ]).flat(),
    ];
    const out = await transform(messages);
    for (const id of ['b-1', 'c-1', 'd-1']) {
      const r = out.find((m) => (m as unknown as { toolCallId?: string }).toolCallId === id) as
        | { content: Array<{ text: string }> }
        | undefined;
      expect(r?.content[0]?.text.startsWith('[tool result dropped')).toBe(false);
    }
    const aRes = out.find((m) => (m as unknown as { toolCallId?: string }).toolCallId === 'a-1') as
      | { content: Array<{ text: string }> }
      | undefined;
    expect(aRes?.content[0]?.text.startsWith('[tool result dropped')).toBe(true);
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

describe('buildToolNameMap — Backlog-3 §6 local-join', () => {
  it('indexes every assistant toolCall by id', () => {
    const messages: AgentMessage[] = [
      userMsg('hi'),
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'a', name: 'view' },
          { type: 'toolCall', id: 'b', name: 'str_replace_based_edit_tool' },
        ],
      } as unknown as AgentMessage,
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c', name: 'read_url' }],
      } as unknown as AgentMessage,
    ];
    const map = buildToolNameMap(messages);
    expect(map.get('a')).toBe('view');
    expect(map.get('b')).toBe('str_replace_based_edit_tool');
    expect(map.get('c')).toBe('read_url');
  });

  it('returns empty map for messages with no toolCalls', () => {
    const map = buildToolNameMap([userMsg('x'), assistantText('y')]);
    expect(map.size).toBe(0);
  });
});

describe('buildTransformContext — per-tool window enforcement (Backlog-3 §6)', () => {
  // Helper: assistant message that calls a specific tool by name with id.
  function assistantWithCall(toolCallId: string, name: string): AgentMessage {
    return {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'toolCall', id: toolCallId, name, arguments: {} },
      ],
    } as unknown as AgentMessage;
  }

  it('view results outside the 1-call per-tool window get stubbed even inside the recent-3 window', async () => {
    // Three consecutive view calls. The default RECENT_WINDOW=3 would
    // keep all three verbatim. The PER_TOOL_RECENT_BUDGET.view = 1
    // override means only the LAST view stays full-size; the older two
    // get stubbed once they're outside their per-tool budget.
    const transform = buildTransformContext();
    const big = 'v'.repeat(20_000);
    const messages: AgentMessage[] = [
      userMsg('inspect'),
      assistantWithCall('v1', 'view'),
      toolResult('v1', big),
      assistantWithCall('v2', 'view'),
      toolResult('v2', big),
      assistantWithCall('v3', 'view'),
      toolResult('v3', big),
    ];
    const out = await transform(messages);
    const v1 = out.find((m) => (m as unknown as { toolCallId?: string }).toolCallId === 'v1') as
      | { content: Array<{ text: string }> }
      | undefined;
    const v2 = out.find((m) => (m as unknown as { toolCallId?: string }).toolCallId === 'v2') as
      | { content: Array<{ text: string }> }
      | undefined;
    const v3 = out.find((m) => (m as unknown as { toolCallId?: string }).toolCallId === 'v3') as
      | { content: Array<{ text: string }> }
      | undefined;
    expect(v3?.content[0]?.text).toBe(big);
    expect(v1?.content[0]?.text.startsWith('[tool result dropped')).toBe(true);
    expect(v2?.content[0]?.text.startsWith('[tool result dropped')).toBe(true);
  });

  it('str_replace results stay verbatim across 3 calls (per-tool budget = 3)', async () => {
    // The default str_replace_based_edit_tool budget is 3 — the last
    // three results should stay verbatim despite being in the inner
    // recent window. (No aggressive mode: the bodies are small enough
    // that HARD_CAP_BYTES isn't crossed.)
    const transform = buildTransformContext();
    const body = 's'.repeat(4_000);
    const messages: AgentMessage[] = [
      userMsg('edit'),
      assistantWithCall('s1', 'str_replace_based_edit_tool'),
      toolResult('s1', body),
      assistantWithCall('s2', 'str_replace_based_edit_tool'),
      toolResult('s2', body),
      assistantWithCall('s3', 'str_replace_based_edit_tool'),
      toolResult('s3', body),
    ];
    const out = await transform(messages);
    for (const id of ['s1', 's2', 's3']) {
      const r = out.find((m) => (m as unknown as { toolCallId?: string }).toolCallId === id) as
        | { content: Array<{ text: string }> }
        | undefined;
      expect(r?.content[0]?.text).toBe(body);
    }
  });
});

describe('topByBytes — Improver1 §9 aggressive root-cause logging', () => {
  it('returns top-N entries sorted by bytes desc', () => {
    const messages: AgentMessage[] = [
      userMsg('short'),
      assistantWithToolCall('big', 'X'.repeat(10_000)),
      toolResult('big', 'Y'.repeat(2_000)),
      assistantText('a'.repeat(500)),
    ];
    const map = buildToolNameMap(messages);
    const top = topByBytes(messages, map, 2);
    expect(top.length).toBe(2);
    // The largest is the assistant tool-call (10K bytes JSON-encoded
    // dominates). Result row is second-largest.
    expect(top[0]?.bytes).toBeGreaterThan(top[1]?.bytes ?? 0);
    expect(top[0]?.role).toBe('assistant');
  });

  it('annotates assistant rows with kind and tool name', () => {
    const messages: AgentMessage[] = [userMsg('go'), assistantWithToolCall('a', 'X'.repeat(5_000))];
    const map = buildToolNameMap(messages);
    const top = topByBytes(messages, map, 5);
    const tcEntry = top.find((e) => e.kind === 'toolCall');
    expect(tcEntry).toBeDefined();
    expect(tcEntry?.toolName).toBe('str_replace_based_edit_tool');
    expect(tcEntry?.toolCallId).toBe('a');
  });

  it('annotates toolResult rows with the joined tool name from the map', () => {
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithToolCall('z', 'small'),
      toolResult('z', 'Y'.repeat(8_000)),
    ];
    const map = buildToolNameMap(messages);
    const top = topByBytes(messages, map, 5);
    const trEntry = top.find((e) => e.kind === 'toolResult');
    expect(trEntry).toBeDefined();
    expect(trEntry?.toolName).toBe('str_replace_based_edit_tool');
    expect(trEntry?.toolCallId).toBe('z');
  });

  it('handles n=0 by returning empty', () => {
    const messages: AgentMessage[] = [userMsg('hi'), assistantText('there')];
    expect(topByBytes(messages, new Map(), 0)).toEqual([]);
  });

  it('returns idx pointing back at the original message position', () => {
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantText('x'.repeat(100)),
      assistantWithToolCall('big', 'Z'.repeat(5_000)),
    ];
    const map = buildToolNameMap(messages);
    const top = topByBytes(messages, map, 1);
    expect(top[0]?.idx).toBe(2);
  });
});

// Phase 3 of pause-prune-fix-2026-05-08 — ground-truth tool pinning.
// Regression coverage for run mox8xixd-j8cr2o where a 627 KB
// `render_preview` toolResult got capped to 2 KB by aggressive prune,
// leaving the model with no visual handle on what it just rendered.

function assistantWithNamedTool(toolCallId: string, name: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: toolCallId,
        name,
        arguments: { viewport: 'desktop' },
      },
    ],
  } as unknown as AgentMessage;
}

describe('buildGroundTruthResultIds — pin latest result of ground-truth tools', () => {
  it('returns the toolCallId of the latest render_preview', () => {
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithNamedTool('rp_old', 'render_preview'),
      toolResult('rp_old', 'old'),
      assistantWithEditorCall('edit1', 'index.html', 'str_replace'),
      toolResult('edit1', 'edit done'),
      assistantWithNamedTool('rp_new', 'render_preview'),
      toolResult('rp_new', 'new'),
    ];
    const ids = buildGroundTruthResultIds(messages, GROUND_TRUTH_TOOL_NAMES);
    expect(ids.has('rp_new')).toBe(true);
    expect(ids.has('rp_old')).toBe(false);
  });

  it('pins the latest result of every requested tool independently', () => {
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithNamedTool('va1', 'verify_artifact'),
      toolResult('va1', 'pass'),
      assistantWithNamedTool('rp1', 'render_preview'),
      toolResult('rp1', 'rendered'),
      assistantWithNamedTool('va2', 'verify_artifact'),
      toolResult('va2', 'pass again'),
    ];
    const ids = buildGroundTruthResultIds(messages, GROUND_TRUTH_TOOL_NAMES);
    expect(ids.has('rp1')).toBe(true);
    expect(ids.has('va2')).toBe(true);
    expect(ids.has('va1')).toBe(false);
  });

  it('returns empty when no ground-truth tools were called', () => {
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithEditorCall('edit1', 'index.html', 'str_replace'),
      toolResult('edit1', 'ok'),
    ];
    expect(buildGroundTruthResultIds(messages, GROUND_TRUTH_TOOL_NAMES).size).toBe(0);
  });

  it('respects perToolWindow > 1 to keep N most-recent results per tool', () => {
    const messages: AgentMessage[] = [
      userMsg('go'),
      assistantWithNamedTool('rp1', 'render_preview'),
      toolResult('rp1', 'a'),
      assistantWithNamedTool('rp2', 'render_preview'),
      toolResult('rp2', 'b'),
      assistantWithNamedTool('rp3', 'render_preview'),
      toolResult('rp3', 'c'),
    ];
    const ids = buildGroundTruthResultIds(messages, new Set(['render_preview']), 2);
    expect(ids.has('rp3')).toBe(true);
    expect(ids.has('rp2')).toBe(true);
    expect(ids.has('rp1')).toBe(false);
  });
});

describe('buildTransformContext — ground-truth toolResult survives aggressive prune', () => {
  it('keeps the latest render_preview result verbatim when the run blows past the hard cap', async () => {
    const transform = buildTransformContext();
    // Build a transcript big enough to trip the aggressive branch
    // (HARD_CAP_BYTES = 200 KB): one giant render_preview result at
    // the tail plus enough older str_replace traffic that the first
    // pass still exceeds 200 KB. Mirrors run mox8xixd-j8cr2o.
    const HUGE_PREVIEW = 'p'.repeat(620_000);
    const STR_REPLACE_OLD = 's'.repeat(15_000);
    const messages: AgentMessage[] = [userMsg('build it')];
    for (let i = 0; i < 6; i += 1) {
      messages.push(assistantWithEditorCall(`edit${i}`, 'index.html', 'str_replace'));
      messages.push(toolResult(`edit${i}`, STR_REPLACE_OLD));
    }
    messages.push(assistantWithNamedTool('rp_latest', 'render_preview'));
    messages.push(toolResult('rp_latest', HUGE_PREVIEW));

    const out = await transform(messages);
    const last = out[out.length - 1] as { content?: Array<{ text?: string }> };
    const lastText = last?.content?.[0]?.text ?? '';
    // Ground-truth exemption keeps the full 620 KB blob, not the
    // aggressive-mode 2 KB stub.
    expect(lastText.length).toBeGreaterThan(600_000);
    expect(lastText.startsWith('[tool result dropped')).toBe(false);
  });

  it('still collapses stale (non-latest) render_preview results under aggressive', async () => {
    const transform = buildTransformContext();
    const STALE = 's'.repeat(50_000);
    const FRESH = 'f'.repeat(50_000);
    const PADDING = 'p'.repeat(15_000);
    const messages: AgentMessage[] = [userMsg('build it')];
    // Older render_preview that should NOT be pinned.
    messages.push(assistantWithNamedTool('rp_stale', 'render_preview'));
    messages.push(toolResult('rp_stale', STALE));
    // Padding to push total past hard cap.
    for (let i = 0; i < 8; i += 1) {
      messages.push(assistantWithEditorCall(`edit${i}`, 'index.html', 'str_replace'));
      messages.push(toolResult(`edit${i}`, PADDING));
    }
    // Latest render_preview.
    messages.push(assistantWithNamedTool('rp_latest', 'render_preview'));
    messages.push(toolResult('rp_latest', FRESH));

    const out = await transform(messages);
    const findResult = (id: string): { content?: Array<{ text?: string }> } | undefined =>
      (out as Array<{ role: string; toolCallId?: string }>).find(
        (m) => m.role === 'toolResult' && m.toolCallId === id,
      ) as { content?: Array<{ text?: string }> } | undefined;
    const stale = findResult('rp_stale');
    const fresh = findResult('rp_latest');
    expect(fresh?.content?.[0]?.text?.length ?? 0).toBeGreaterThan(40_000);
    // The stale one is collapsed by aggressive caps (2 KB block limit).
    const staleText = stale?.content?.[0]?.text ?? '';
    expect(staleText.startsWith('[tool result dropped')).toBe(true);
  });
});
