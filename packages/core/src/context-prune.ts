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

/**
 * Phase 2 — multi-file pinning. Up to K distinct paths touched by recent
 * `str_replace_based_edit_tool` calls each retain their result anchors.
 * Set to 3 to cover the typical HTML + CSS + JS bundle that Vanilla mode
 * fans out into.
 */
const ACTIVE_FILE_K = 3;

/**
 * Phase 2 — per-tool-type recent-window overrides. Inside the rolling
 * recent window, view results re-issue cheaply; str_replace results are
 * load-bearing for follow-up edits and cannot be re-derived. Tools not
 * listed here use the default window behavior.
 *
 * Currently advisory only — the size-cap path treats all toolResult
 * blocks uniformly via `toolResultLimitRecent`. A future pass can wire
 * per-tool-name caps once pi-agent-core preserves toolName on the
 * toolResult message envelope.
 */
export const PER_TOOL_RECENT_BUDGET: Record<string, number> = {
  str_replace_based_edit_tool: 3,
  view: 1,
  list_files: 1,
  generate_image_asset: 2,
  verify_artifact: 1,
};

/** Tool name emitted by `makeTextEditorTool`. Must match the literal in
 *  `text-editor.ts` so `findActiveFile` recognises edits. */
const TEXT_EDITOR_TOOL_NAME = 'str_replace_based_edit_tool';

/**
 * Tools whose latest toolResult is the agent's ground-truth view of the
 * artifact. Pruning their most-recent result destroys the very state the
 * model is reasoning about — observed in run mox8xixd-j8cr2o (2026-05-08)
 * where a 627 KB `render_preview` result at idx 25 was capped to 2 KB by
 * aggressive prune, leaving the model with no visual handle on what it
 * had just rendered.
 *
 * The latest result of each name is exempt from caps + aggressive prune
 * regardless of position in the conversation. Older results of the same
 * tool fall under normal caps.
 */
export const GROUND_TRUTH_TOOL_NAMES: ReadonlySet<string> = new Set([
  'render_preview',
  'verify_artifact',
]);

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

/**
 * Improver1 §9 — when aggressive mode fires, identify the top-N
 * byte-heavy messages so we can see which message kind is dominating.
 * Today's data showed 68 % of pruning passes hit aggressive mode but
 * the log line only carried byte counts — no signal on whether one
 * giant view, one massive str_replace, or many smaller blocks were
 * the culprit. This breakdown unblocks the next round of TOOL_*_LIMIT
 * tuning by replacing guesses with the actual distribution.
 */
interface DominantMessageEntry {
  idx: number;
  role: string;
  bytes: number;
  toolName?: string;
  toolCallId?: string;
  /** Best-effort distinguisher: 'toolCall' for assistant tool-call,
   *  'toolResult' for results, 'text' for assistant prose, 'user' for
   *  user messages. */
  kind?: string;
}

export function topByBytes(
  messages: AgentMessage[],
  toolNameById: Map<string, string>,
  n: number,
): DominantMessageEntry[] {
  const entries: DominantMessageEntry[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    let bytes = 0;
    try {
      bytes = JSON.stringify(m).length;
    } catch {
      bytes = 0;
    }
    const entry: DominantMessageEntry = { idx: i, role: m.role, bytes };
    if (m.role === 'toolResult') {
      entry.kind = 'toolResult';
      const tcId = (m as unknown as { toolCallId?: unknown }).toolCallId;
      if (typeof tcId === 'string') {
        entry.toolCallId = tcId;
        const name = toolNameById.get(tcId);
        if (name !== undefined) entry.toolName = name;
      }
    } else if (m.role === 'assistant') {
      // Pick the dominant block kind: if there's a toolCall block,
      // mark that; otherwise count it as text.
      const original = m as unknown as { content?: Array<Record<string, unknown>> };
      if (Array.isArray(original.content)) {
        const tcBlock = original.content.find((b) => b?.['type'] === 'toolCall');
        if (tcBlock) {
          entry.kind = 'toolCall';
          if (typeof tcBlock['name'] === 'string') entry.toolName = tcBlock['name'];
          if (typeof tcBlock['id'] === 'string') entry.toolCallId = tcBlock['id'];
        } else {
          entry.kind = 'text';
        }
      } else {
        entry.kind = 'text';
      }
    } else if (m.role === 'user') {
      entry.kind = 'user';
    }
    entries.push(entry);
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return entries.slice(0, Math.max(0, n));
}

function preview(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.slice(0, 80);
}

function stubText(text: string, label: string): string {
  return `[${label} — ${text.length}B, head: "${preview(text)}"]`;
}

/**
 * Improver1 §1 — schema-valid redaction placeholder.
 *
 * For `str_replace_based_edit_tool` we emit a shape that passes ajv
 * validation (`command: 'view'`, `path: '__redacted_history…'`) and
 * carries the `__do_not_echo_this_object` marker. The tool's execute
 * body short-circuits on the marker with a tailored error.
 *
 * For all other tools we still emit the marker but the schema may
 * fail — that's fine because the validation error STRING includes
 * the marker, which is enough of a hint for non-text-editor echoes
 * (which are vanishingly rare in production).
 */
const REDACTED_PATH_SENTINEL = '__redacted_history_placeholder__';
const REDACTION_POISON_KEY = '__do_not_echo_this_object';

export function makeRedactionPlaceholder(
  toolName: string,
  origBytes: number,
  preview: string,
): Record<string, unknown> {
  const common: Record<string, unknown> = {
    [REDACTION_POISON_KEY]: true,
    __redaction_message:
      'PRIOR TOOL INPUT REDACTED — original was too large for the rolling context window. The original arguments are GONE. To inspect the file, call view() with a view_range. To write, compose FRESH args from scratch — never paste this object into a tool call.',
    __redaction_original_bytes: origBytes,
    __redaction_preview: preview,
  };
  if (toolName === 'str_replace_based_edit_tool') {
    // Schema-valid for text_editor: command='view' is the cheapest
    // routable command; path uses a sentinel so the execute body can
    // also detect "you echoed the placeholder as a path" via the path
    // string alone, even if the marker key were dropped somehow.
    return {
      ...common,
      command: 'view',
      path: REDACTED_PATH_SENTINEL,
    };
  }
  return common;
}

export { REDACTED_PATH_SENTINEL, REDACTION_POISON_KEY };

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
      // Improver1 §1 — echo-proof placeholder. 2026-04-29 traces
      // (mokhzyr8, mokivxgx) AND today's run-1 (mosuuixq-ybcwn0)
      // showed Sonnet 4.6 echoing the prior `__codesign_stripped`
      // placeholder verbatim as a fresh tool call's `arguments`.
      // pi-ai's `validateToolArguments` runs BEFORE we get a
      // beforeToolCall hook, so we can't intercept pre-validation.
      // Strategy: emit a placeholder shape that *passes schema
      // validation* for the tool that owns it, but carries a poison
      // marker `__do_not_echo_this_object` that the tool's execute
      // body short-circuits on with a tailored error. The error
      // becomes a steer that the model can act on (vs. ajv's
      // "must have required property 'command'" which the model
      // historically just slaps a fake `command` on top of).
      const blockName = typeof block['name'] === 'string' ? (block['name'] as string) : '';
      const placeholderArgs = makeRedactionPlaceholder(blockName, origBytes, preview);
      return {
        ...block,
        [fieldName]: placeholderArgs,
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
  const files = findActiveFiles(messages, 1);
  return files[0] ?? null;
}

/**
 * Phase 2 — multi-file active set. Walk messages newest→oldest; collect up to
 * `k` distinct `path` arguments from `str_replace_based_edit_tool` calls.
 * Multi-file refactors (e.g., HTML + CSS + JS bundle) get all three pinned
 * by the active-file exemption rather than only the most-recent file.
 */
export function findActiveFiles(messages: AgentMessage[], k: number): string[] {
  if (k <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && out.length < k; i -= 1) {
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
      if (typeof path === 'string' && path.length > 0 && !seen.has(path)) {
        seen.add(path);
        out.push(path);
        if (out.length >= k) return out;
      }
    }
  }
  return out;
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
  activeFiles: string | string[] | null,
  windowSize: number,
): Set<string> {
  const out = new Set<string>();
  if (activeFiles === null || windowSize <= 0) return out;
  // Accept a single string for backwards compatibility — Phase 2 promotes
  // active-file pinning to a multi-file set so multi-file refactors stop
  // losing anchors when aggressive mode fires.
  const fileSet = new Set<string>(typeof activeFiles === 'string' ? [activeFiles] : activeFiles);
  if (fileSet.size === 0) return out;
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
      if (typeof path !== 'string' || !fileSet.has(path)) continue;
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
 * Phase-3-of-pause-prune-fix-2026-05-08 — pin the latest toolResult of
 * each "ground truth" tool. Walks newest→oldest assistant messages,
 * collecting the toolCallId of the first toolCall block whose `name`
 * matches each entry in `toolNames`. Returns a Set of those ids; the
 * pruner exempts them from caps + aggressive mode.
 *
 * Only the *latest* result per tool is pinned (perToolWindow=1 by
 * default). Earlier `render_preview` / `verify_artifact` results fall
 * under normal caps — they are stale snapshots of state the model has
 * already iterated past.
 */
export function buildGroundTruthResultIds(
  messages: AgentMessage[],
  toolNames: ReadonlySet<string>,
  perToolWindow = 1,
): Set<string> {
  const out = new Set<string>();
  if (toolNames.size === 0 || perToolWindow <= 0) return out;
  const seenPerName = new Map<string, number>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const original = m as unknown as { content?: Array<Record<string, unknown>> };
    if (!Array.isArray(original.content)) continue;
    for (const block of original.content) {
      if (block?.['type'] !== 'toolCall') continue;
      const name = block['name'];
      if (typeof name !== 'string' || !toolNames.has(name)) continue;
      const taken = seenPerName.get(name) ?? 0;
      if (taken >= perToolWindow) continue;
      const id = block['id'];
      if (typeof id !== 'string' || id.length === 0) continue;
      out.add(id);
      seenPerName.set(name, taken + 1);
    }
    // Early-exit when every requested tool has hit its quota.
    if (seenPerName.size === toolNames.size) {
      let allDone = true;
      for (const tname of toolNames) {
        if ((seenPerName.get(tname) ?? 0) < perToolWindow) {
          allDone = false;
          break;
        }
      }
      if (allDone) break;
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
   *  limits even under aggressive mode. Union of two sources:
   *    - active-file pinning (backlog-2 #3) — text_editor results on
   *      the file(s) the agent is currently editing.
   *    - ground-truth pinning (pause-prune-fix 2026-05-08) — the latest
   *      result of each tool in `GROUND_TRUTH_TOOL_NAMES`. */
  exemptResultIds: Set<string>;
  /** Backlog-3 §6 — toolCallId → tool name lookup. Built by walking
   *  assistant messages once and indexing every toolCall block. Used to
   *  enforce per-tool windows on toolResult messages (where pi-ai
   *  doesn't preserve the tool name). */
  toolNameById?: Map<string, string>;
  /** Per-tool retention window — overrides windowTurns when set for a
   *  given tool name. {str_replace_based_edit_tool: 3, view: 1}
   *  collapses old view results aggressively while keeping recent
   *  str_replace anchors verbatim. */
  perToolRecent?: Record<string, number>;
}

/**
 * Backlog-3 §6 — pre-compute toolCallId → toolName map. Walk assistant
 * messages once; index each toolCall block by its id. O(N · k).
 */
export function buildToolNameMap(messages: AgentMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m?.role !== 'assistant') continue;
    const original = m as unknown as { content?: Array<Record<string, unknown>> };
    if (!Array.isArray(original.content)) continue;
    for (const block of original.content) {
      if (block?.['type'] !== 'toolCall') continue;
      const id = block['id'];
      const name = block['name'];
      if (typeof id === 'string' && typeof name === 'string') map.set(id, name);
    }
  }
  return map;
}

/**
 * Backlog-3 §6 — count, for a given toolResult at message index `idx`,
 * how many newer toolResults share its toolName. Used to enforce
 * per-tool windows: if the count is >= perToolRecent[name] we treat
 * THIS result as outside the window even if global RECENT_WINDOW would
 * keep it verbatim. Counts only messages at index > idx.
 */
function newerSameToolCount(
  messages: AgentMessage[],
  idx: number,
  toolName: string,
  toolNameById: Map<string, string>,
): number {
  let count = 0;
  for (let i = idx + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (m?.role !== 'toolResult') continue;
    const tcId = (m as unknown as { toolCallId?: unknown }).toolCallId;
    if (typeof tcId !== 'string') continue;
    if (toolNameById.get(tcId) === toolName) count += 1;
  }
  return count;
}

interface ApplyCapsResult {
  messages: AgentMessage[];
  /** Backlog-3 logging — per-tool name → count of toolResult rows the
   *  per-tool window collapsed when the global recent-window would
   *  have kept them. Empty when no per-tool enforcement fired.
   *  Surfaced through `[context-prune] step=caps`/`step=aggressive`. */
  perToolCollapses: Record<string, number>;
}

function applyCaps(messages: AgentMessage[], cfg: CapConfig): ApplyCapsResult {
  const windowStart = computeWindowStart(messages, cfg.windowTurns);
  const perToolCollapses: Record<string, number> = {};
  const out = messages.map((m, idx) => {
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
      if (typeof tcId === 'string' && cfg.exemptResultIds.has(tcId)) {
        // Exempt — backlog-2 #3 (active-file pinning) + pause-prune-fix
        // 2026-05-08 (ground-truth pinning). Keep the result verbatim
        // regardless of the recent window or aggressive mode so the
        // model retains its handle on the file it's editing AND on the
        // latest render_preview / verify_artifact ground truth.
        return m;
      }
      // Backlog-3 §6 — per-tool window enforcement. If we know the tool
      // name AND have a budget for it, treat results as "outside the
      // window" once we've already kept `perToolRecent[name]` newer
      // same-tool results. Layered on top of the global window: tighter
      // wins. View results collapse after 1 turn; str_replace stays for 3.
      let perToolForcesOld = false;
      let collapsedToolName: string | null = null;
      if (
        typeof tcId === 'string' &&
        cfg.toolNameById !== undefined &&
        cfg.perToolRecent !== undefined
      ) {
        const name = cfg.toolNameById.get(tcId);
        if (name !== undefined && cfg.perToolRecent[name] !== undefined) {
          const budget = cfg.perToolRecent[name];
          const newerCount = newerSameToolCount(messages, idx, name, cfg.toolNameById);
          if (newerCount >= budget) {
            perToolForcesOld = true;
            // Only count as a "collapse" when the global window WOULD
            // have kept this row but the per-tool budget overrode.
            if (isRecent) collapsedToolName = name;
          }
        }
      }
      if (collapsedToolName !== null) {
        perToolCollapses[collapsedToolName] = (perToolCollapses[collapsedToolName] ?? 0) + 1;
      }
      const useRecent = isRecent && !perToolForcesOld;
      return compactToolResult(m, useRecent ? cfg.toolResultLimitRecent : cfg.toolResultLimitOld);
    }
    return m;
  });
  return { messages: out, perToolCollapses };
}

/**
 * Improver1 §11 — runtime overrides for the replay-prune CLI. Every
 * field is optional and defaults to the module-level constant, so
 * production code paths (which call `buildTransformContext()` with no
 * args) are completely unaffected. The CLI passes a partial override
 * to compare current vs proposed tuning offline.
 */
export interface PruneTuning {
  textLimit?: number;
  toolInputLimit?: number;
  toolResultLimit?: number;
  hardCapBytes?: number;
  aggressiveBlockLimit?: number;
  recentWindow?: number;
  activeFileWindow?: number;
  activeFileK?: number;
}

export function buildTransformContext(
  log: CoreLogger = NOOP_LOGGER,
  tuning: PruneTuning = {},
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const textLimit = tuning.textLimit ?? TEXT_BLOCK_LIMIT;
  const toolInputLimit = tuning.toolInputLimit ?? TOOL_INPUT_LIMIT;
  const toolResultLimit = tuning.toolResultLimit ?? TOOL_RESULT_LIMIT;
  const hardCapBytes = tuning.hardCapBytes ?? HARD_CAP_BYTES;
  const aggressiveBlockLimit = tuning.aggressiveBlockLimit ?? AGGRESSIVE_BLOCK_LIMIT;
  const recentWindow = tuning.recentWindow ?? RECENT_WINDOW;
  const activeFileWindow = tuning.activeFileWindow ?? ACTIVE_FILE_WINDOW;
  const activeFileK = tuning.activeFileK ?? ACTIVE_FILE_K;

  return async (messages) => {
    if (messages.length === 0) return messages;

    const activeFiles = findActiveFiles(messages, activeFileK);
    const activeFileResultIds = buildActiveFileResultIds(messages, activeFiles, activeFileWindow);
    if (activeFiles.length > 0 && activeFileResultIds.size > 0) {
      log.info('[context-prune] step=active_file_kept', {
        activeFiles,
        keptResults: activeFileResultIds.size,
        windowSize: activeFileWindow,
      });
    }

    // Phase 3 of pause-prune-fix-2026-05-08 — pin the latest result of
    // each ground-truth tool. The aggressive prune step runs at the end
    // of long runs (typically the same point a context-threshold pause
    // fires); without this, the most recent render_preview / verify_artifact
    // result gets capped to AGGRESSIVE_BLOCK_LIMIT, leaving the model with
    // no visual state to react to on the resumed turn.
    const groundTruthResultIds = buildGroundTruthResultIds(messages, GROUND_TRUTH_TOOL_NAMES);
    if (groundTruthResultIds.size > 0) {
      log.info('[context-prune] step=ground_truth_kept', {
        toolNames: Array.from(GROUND_TRUTH_TOOL_NAMES),
        keptResults: groundTruthResultIds.size,
      });
    }
    const exemptResultIds = new Set<string>([...activeFileResultIds, ...groundTruthResultIds]);

    // Backlog-3 §6 — local-join toolName preservation. Build the
    // toolCallId → toolName map once per pruning pass; reused across
    // both caps + aggressive applyCaps invocations.
    const toolNameById = buildToolNameMap(messages);

    const before = estimateBytes(messages);
    const firstResult = applyCaps(messages, {
      textLimit,
      toolInputLimitOld: toolInputLimit,
      toolResultLimitOld: toolResultLimit,
      toolInputLimitRecent: null,
      toolResultLimitRecent: null,
      windowTurns: recentWindow,
      exemptResultIds,
      toolNameById,
      perToolRecent: PER_TOOL_RECENT_BUDGET,
    });
    const first = firstResult.messages;
    const firstSize = estimateBytes(first);

    log.info('[context-prune] step=caps', {
      messages: messages.length,
      before,
      after: firstSize,
      textLimit,
      toolInputLimit,
      toolResultLimit,
      window: recentWindow,
      // Backlog-3 logging — per-tool collapse counts so we can see
      // where the §6 budget is actually saving tokens.
      perToolCollapses: firstResult.perToolCollapses,
    });

    if (firstSize <= hardCapBytes) return first;

    // Improver1 §9 — log the top byte-heavy messages BEFORE pruning
    // so we can see which messages dominated (one giant view? many
    // small blocks? massive str_replace?). Computed on the original
    // `messages` (pre-prune) because that's the distribution we want
    // to tune against. Capped at 5 to keep the log line small.
    log.info('[context-prune] step=aggressive_dominant_msgs', {
      topByBytes: topByBytes(messages, toolNameById, 5),
      totalBytes: before,
      budgetBytes: hardCapBytes,
    });

    const aggressiveResult = applyCaps(messages, {
      textLimit: aggressiveBlockLimit,
      toolInputLimitOld: aggressiveBlockLimit,
      toolResultLimitOld: aggressiveBlockLimit,
      toolInputLimitRecent: aggressiveBlockLimit,
      toolResultLimitRecent: aggressiveBlockLimit,
      windowTurns: 0,
      exemptResultIds,
      toolNameById,
      perToolRecent: PER_TOOL_RECENT_BUDGET,
    });
    const aggressive = aggressiveResult.messages;
    const aggressiveSize = estimateBytes(aggressive);
    log.info('[context-prune] step=aggressive', {
      messages: messages.length,
      before,
      first: firstSize,
      after: aggressiveSize,
      blockLimit: aggressiveBlockLimit,
      activeFileExempt: activeFileResultIds.size,
      groundTruthExempt: groundTruthResultIds.size,
      perToolCollapses: aggressiveResult.perToolCollapses,
    });
    return aggressive;
  };
}
