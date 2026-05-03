/**
 * Per-message size-based context compaction for pi-agent-core's
 * `transformContext` hook. Runs before every LLM call.
 *
 * Philosophy: **history is intent tracking, not payload storage.** The model
 * needs the decision trail — which tools, in what order, with what shape —
 * not verbatim 9 MB artifact dumps or whole-file view returns from ten turns
 * ago. Current file state is always recoverable via ranged `view()`.
 *
 * Evolution:
 *   - v1 (window): kept last N turns verbatim, stubbed older. Missed the
 *     dominant failure mode — a 9 MB `<artifact>` text dump sat inside the
 *     keep-verbatim window and shipped 3.97 M tokens.
 *   - v2 (windowless): stubbed every block over its cap regardless of
 *     position. Safe, but over-aggressive after the prompt OVERRIDE block
 *     eliminated the text-dump vector — the model's own latest str_replace
 *     new_str got summarized, so picking the next old_str required guessing.
 *   - v3 (this file): split behavior by block type.
 *        · `assistant.content[*].text` is always capped (8 KB, all turns).
 *          This is the regression guard: the one class of block that must
 *          never be allowed to balloon, because a bad prompt interaction
 *          can resurrect the `<artifact>` dump.
 *        · `assistant.content[*].toolCall.input` and
 *          `toolResult.content[*].text` are capped only outside a small
 *          recent-turn window. Inside the window they stay verbatim so the
 *          model reads its own just-written section and the latest view()
 *          output in full fidelity. Outside the window, large payloads
 *          collapse to a one-line stub.
 *
 * Block-level caps:
 *   - TEXT_BLOCK_LIMIT     — assistant prose, ALL turns.
 *   - TOOL_INPUT_LIMIT     — assistant.toolCall.input, older turns only.
 *   - TOOL_RESULT_LIMIT    — toolResult.text, older turns only.
 *
 * Stub format carries bytes + a short preview so the model can tell what
 * got dropped, and (for tool calls) keeps tool NAME + id so pi-ai's shape
 * validation remains happy.
 *
 * Safety net: after per-block stubbing, if the grand total still exceeds
 * `HARD_CAP_BYTES`, we shrink caps further (including within the window)
 * and re-run. Catches pathological runs with many just-under-threshold
 * blocks.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { type CoreLogger, NOOP_LOGGER } from './logger.js';

const TEXT_BLOCK_LIMIT = 8 * 1024;
const TOOL_INPUT_LIMIT = 24 * 1024;
const TOOL_RESULT_LIMIT = 8 * 1024;
const HARD_CAP_BYTES = 200_000;
const AGGRESSIVE_BLOCK_LIMIT = 2 * 1024;

/**
 * Number of most-recent non-user messages whose tool payloads (toolCall.input
 * and toolResult.text) stay verbatim. Assistant TEXT is still capped inside
 * this window — see TEXT_BLOCK_LIMIT rationale above.
 *
 * 3 covers "current turn is reading the previous turn's str_replace + its
 * toolResult" in the typical one-section-per-turn polish cadence.
 */
const RECENT_WINDOW = 3;

/**
 * Per-active-file window — backlog-2 #3. The most-recent text_editor
 * `path` is identified as the active file; the last N toolResult blocks
 * for that file stay un-pruned even when the global aggressive mode
 * fires. Without this, the agent's late-run `view index.html` calls
 * pay tokens to re-establish state that was just thrown away.
 */
const ACTIVE_FILE_WINDOW = 6;

/** Tool name emitted by `makeTextEditorTool`. Must match the literal in
 *  `text-editor.ts` so `findActiveFile` recognises edits. */
const TEXT_EDITOR_TOOL_NAME = 'str_replace_based_edit_tool';

function estimateBytes(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m).length;
    } catch {
      /* circular or unserializable — ignore */
    }
  }
  return total;
}

function preview(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.slice(0, 80);
}

function stubText(text: string, label: string): string {
  return `[${label} — ${text.length}B, head: "${preview(text)}"]`;
}

function compactAssistant(
  m: AgentMessage,
  textLimit: number,
  toolLimit: number | null,
): AgentMessage {
  const original = m as unknown as {
    role: 'assistant';
    content?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(original.content)) return m;
  let changed = false;
  const nextContent = original.content.map((block) => {
    const type = block?.['type'];
    if (type === 'text') {
      const text = typeof block['text'] === 'string' ? (block['text'] as string) : '';
      if (text.length <= textLimit) return block;
      changed = true;
      return { ...block, text: stubText(text, 'prior assistant output dropped') };
    }
    if (type === 'toolCall' && toolLimit !== null) {
      // pi-ai's ToolCall uses `arguments`. Older AgentMessage flows used
      // `input`. Read either; write to whichever field was actually
      // populated so we don't leave a stale large copy on the other field.
      const args = block['arguments'] ?? block['input'];
      const fieldName = block['arguments'] !== undefined ? 'arguments' : 'input';
      let origBytes = 0;
      let preview = '';
      try {
        const serialized = JSON.stringify(args ?? null);
        origBytes = serialized.length;
        preview = serialized.slice(0, 80);
      } catch {
        /* ignore */
      }
      if (origBytes <= toolLimit) return block;
      changed = true;
      // 2026-04-29 traces (mokhzyr8, mokivxgx) showed Sonnet 4.6 echoing the
      // old `{ _summarized: true, _origBytes, _preview }` placeholder as a
      // fresh tool call's arguments — validation then fails with "missing
      // command/path". Namespaced keys + a directive string make the
      // placeholder visibly redacted history rather than a template.
      return {
        ...block,
        [fieldName]: {
          __codesign_stripped:
            'PRIOR TOOL INPUT REDACTED — original was too large for the rolling context window. DO NOT reproduce this shape as a new tool call; the original arguments are gone. If you need the file state, call view() or list_files() instead.',
          __codesign_original_bytes: origBytes,
          __codesign_preview: preview,
        },
      };
    }
    return block;
  });
  if (!changed) return m;
  return { ...(original as object), content: nextContent } as unknown as AgentMessage;
}

function compactToolResult(m: AgentMessage, limit: number | null): AgentMessage {
  if (limit === null) return m;
  const original = m as unknown as {
    role: 'toolResult';
    content?: Array<{ type: string; text?: string }>;
  };
  if (!Array.isArray(original.content)) return m;
  let changed = false;
  const nextContent = original.content.map((block) => {
    if (block?.type !== 'text') return block;
    const text = typeof block.text === 'string' ? block.text : '';
    if (text.length <= limit) return block;
    changed = true;
    return { ...block, text: stubText(text, 'tool result dropped — use view() for current state') };
  });
  if (!changed) return m;
  return { ...(original as object), content: nextContent } as unknown as AgentMessage;
}

/**
 * Walk messages from newest to oldest. Returns the `path` argument of
 * the most-recent `str_replace_based_edit_tool` call, or null when no
 * text_editor call has happened yet. Used by the active-file window
 * (backlog-2 #3) — the file the agent is currently editing.
 */
export function findActiveFile(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const original = m as unknown as { content?: Array<Record<string, unknown>> };
    if (!Array.isArray(original.content)) continue;
    for (const block of original.content) {
      if (block?.['type'] !== 'toolCall') continue;
      if (block['name'] !== TEXT_EDITOR_TOOL_NAME) continue;
      // pi-ai's ToolCall stores params on `arguments`. Older code paths used
      // `input`; accept both so this stays robust if pi-agent-core ever
      // normalizes back. Without this fallback, active-file pruning silently
      // never fires (see 2026-04-28 trace moix9ivu — 5 consecutive `view`
      // calls because aggressive pruning didn't preserve the active file).
      const args =
        (block['arguments'] as Record<string, unknown> | undefined) ??
        (block['input'] as Record<string, unknown> | undefined);
      if (typeof args !== 'object' || args === null) continue;
      const path = args['path'];
      if (typeof path === 'string' && path.length > 0) return path;
    }
  }
  return null;
}

/**
 * Build the set of toolCallIds whose corresponding text_editor call
 * targets `activeFile`, capped at the most-recent `windowSize`. The
 * pruner exempts toolResult blocks with these ids from size limits even
 * under aggressive mode — the rationale being that late-run navigation
 * on the active file paid tokens just to re-read the same state.
 */
export function buildActiveFileResultIds(
  messages: AgentMessage[],
  activeFile: string | null,
  windowSize: number,
): Set<string> {
  const out = new Set<string>();
  if (activeFile === null || windowSize <= 0) return out;
  for (let i = messages.length - 1; i >= 0 && out.size < windowSize; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const original = m as unknown as { content?: Array<Record<string, unknown>> };
    if (!Array.isArray(original.content)) continue;
    for (const block of original.content) {
      if (block?.['type'] !== 'toolCall') continue;
      if (block['name'] !== TEXT_EDITOR_TOOL_NAME) continue;
      const args =
        (block['arguments'] as Record<string, unknown> | undefined) ??
        (block['input'] as Record<string, unknown> | undefined);
      if (typeof args !== 'object' || args === null) continue;
      const path = args['path'];
      if (path !== activeFile) continue;
      const id = block['id'];
      if (typeof id === 'string' && id.length > 0) {
        out.add(id);
        if (out.size >= windowSize) break;
      }
    }
  }
  return out;
}

/**
 * Index threshold (inclusive) — messages at or after this index are "recent"
 * and their tool payloads stay verbatim. Counts assistant + toolResult roles
 * from the tail; user messages are never a prune target but also don't
 * consume window slots.
 */
function computeWindowStart(messages: AgentMessage[], windowTurns: number): number {
  if (windowTurns <= 0) return messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i]?.role;
    if (role === 'assistant' || role === 'toolResult') {
      seen += 1;
      if (seen >= windowTurns) return i;
    }
  }
  return 0;
}

interface CapConfig {
  textLimit: number;
  toolInputLimitOld: number;
  toolResultLimitOld: number;
  toolInputLimitRecent: number | null;
  toolResultLimitRecent: number | null;
  windowTurns: number;
  /** Set of toolCallIds whose toolResult blocks are exempt from size
   *  limits even under aggressive mode — see backlog-2 #3. */
  activeFileResultIds: Set<string>;
}

function applyCaps(messages: AgentMessage[], cfg: CapConfig): AgentMessage[] {
  const windowStart = computeWindowStart(messages, cfg.windowTurns);
  return messages.map((m, idx) => {
    const isRecent = idx >= windowStart;
    if (m.role === 'assistant') {
      return compactAssistant(
        m,
        cfg.textLimit,
        isRecent ? cfg.toolInputLimitRecent : cfg.toolInputLimitOld,
      );
    }
    if (m.role === 'toolResult') {
      const tcId = (m as unknown as { toolCallId?: unknown }).toolCallId;
      if (typeof tcId === 'string' && cfg.activeFileResultIds.has(tcId)) {
        // Active-file exemption — backlog-2 #3. Keep the result verbatim
        // regardless of the recent window or aggressive mode so late-run
        // navigation on the file the agent is editing doesn't re-pay
        // tokens to re-establish state.
        return m;
      }
      return compactToolResult(m, isRecent ? cfg.toolResultLimitRecent : cfg.toolResultLimitOld);
    }
    return m;
  });
}

export function buildTransformContext(
  log: CoreLogger = NOOP_LOGGER,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages) => {
    if (messages.length === 0) return messages;

    const activeFile = findActiveFile(messages);
    const activeFileResultIds = buildActiveFileResultIds(messages, activeFile, ACTIVE_FILE_WINDOW);
    if (activeFile !== null && activeFileResultIds.size > 0) {
      log.info('[context-prune] step=active_file_kept', {
        activeFile,
        keptResults: activeFileResultIds.size,
        windowSize: ACTIVE_FILE_WINDOW,
      });
    }

    const before = estimateBytes(messages);
    const first = applyCaps(messages, {
      textLimit: TEXT_BLOCK_LIMIT,
      toolInputLimitOld: TOOL_INPUT_LIMIT,
      toolResultLimitOld: TOOL_RESULT_LIMIT,
      toolInputLimitRecent: null,
      toolResultLimitRecent: null,
      windowTurns: RECENT_WINDOW,
      activeFileResultIds,
    });
    const firstSize = estimateBytes(first);

    log.info('[context-prune] step=caps', {
      messages: messages.length,
      before,
      after: firstSize,
      textLimit: TEXT_BLOCK_LIMIT,
      toolInputLimit: TOOL_INPUT_LIMIT,
      toolResultLimit: TOOL_RESULT_LIMIT,
      window: RECENT_WINDOW,
    });

    if (firstSize <= HARD_CAP_BYTES) return first;

    const aggressive = applyCaps(messages, {
      textLimit: AGGRESSIVE_BLOCK_LIMIT,
      toolInputLimitOld: AGGRESSIVE_BLOCK_LIMIT,
      toolResultLimitOld: AGGRESSIVE_BLOCK_LIMIT,
      toolInputLimitRecent: AGGRESSIVE_BLOCK_LIMIT,
      toolResultLimitRecent: AGGRESSIVE_BLOCK_LIMIT,
      windowTurns: 0,
      activeFileResultIds,
    });
    const aggressiveSize = estimateBytes(aggressive);
    log.info('[context-prune] step=aggressive', {
      messages: messages.length,
      before,
      first: firstSize,
      after: aggressiveSize,
      blockLimit: AGGRESSIVE_BLOCK_LIMIT,
      activeFileExempt: activeFileResultIds.size,
    });
    return aggressive;
  };
}
