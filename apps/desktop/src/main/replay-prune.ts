#!/usr/bin/env tsx
/**
 * Improver1 §11 — replay-prune CLI.
 *
 * Re-runs a persisted design's chat_messages through `buildTransformContext`
 * twice — once with current production tuning, once with proposed tuning —
 * and prints byte deltas + per-tool collapse counts. Lets us validate
 * `RECENT_WINDOW` / `TOOL_RESULT_LIMIT` changes without burning provider
 * tokens on a live run.
 *
 * Usage:
 *   pnpm replay-prune --design c44763af --since 2026-05-05
 *   pnpm replay-prune --design c44763af --window 2 --tool-result-limit 4096
 *
 * Flags:
 *   --design <id-or-prefix>     Required. Full UUID or unique prefix.
 *   --since <YYYY-MM-DD>        Optional. ISO date floor on chat_messages.created_at.
 *   --until <YYYY-MM-DD>        Optional. ISO date ceiling.
 *   --db <path>                 Optional. Defaults to userData/designs.db.
 *   --window <n>                Proposed RECENT_WINDOW (default = current 3).
 *   --tool-result-limit <n>     Proposed TOOL_RESULT_LIMIT in bytes.
 *   --tool-input-limit <n>      Proposed TOOL_INPUT_LIMIT in bytes.
 *   --aggressive-block-limit<n> Proposed AGGRESSIVE_BLOCK_LIMIT in bytes.
 *   --hard-cap <bytes>          Proposed HARD_CAP_BYTES.
 *   --turn <i>                  Replay only the i-th turn boundary (default: every turn).
 *   --json                      Emit machine-readable summary instead of human text.
 *   --full-history              Skip the renderer's per-turn condensation, feeding
 *                               the pruner the full chat-row payload. Use this to
 *                               see what the pruner WOULD do mid-run if it saw the
 *                               full agent transcript (faithful to in-flight passes,
 *                               not the reduced shape persisted at user-prompt
 *                               boundaries).
 *   --session <id>              Restrict replay to chat_messages rows from one
 *                               session (in-design new-conversation feature).
 *                               Defaults to all sessions; pass 0 for the legacy
 *                               bucket, or the value returned by chat:v1:current-session.
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ChatMessage } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
// Direct internal import — `@open-codesign/core` barrel pulls in
// `design-skills/` and `frames/` which use Vite-only `?raw` imports
// that tsx can't resolve. context-prune.ts is a leaf module with only
// type-level pi-agent-core deps and a tiny logger — safe to import
// via the workspace path directly.
import {
  type PruneTuning,
  buildTransformContext,
} from '../../../../packages/core/src/context-prune.js';

// Minimal structural shape of pi-agent-core's AgentMessage that this script
// observes. We only inspect `role` to find turn boundaries; the rest is
// passed through to `buildTransformContext` opaquely.
type ReplayAgentMessage = { role: string };

const require = createRequire(import.meta.url);

interface ReplayOptions {
  design: string;
  since?: string;
  until?: string;
  db?: string;
  window?: number;
  toolResultLimit?: number;
  toolInputLimit?: number;
  aggressiveBlockLimit?: number;
  hardCap?: number;
  turn?: number;
  json?: boolean;
  /** When true, skip the renderer's per-turn summarisation that
   *  collapses older turns to a one-line stub. Feeds the pruner the
   *  full chat-row payload so we see what mid-run pruning passes
   *  would have done in production. Default: false (faithful replay
   *  of what the renderer ships on each user-prompt turn). */
  fullHistory?: boolean;
  /** Restrict to a single session_id; undefined = all sessions. */
  session?: number;
}

function parseFlags(argv: string[]): ReplayOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      design: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      db: { type: 'string' },
      window: { type: 'string' },
      'tool-result-limit': { type: 'string' },
      'tool-input-limit': { type: 'string' },
      'aggressive-block-limit': { type: 'string' },
      'hard-cap': { type: 'string' },
      turn: { type: 'string' },
      json: { type: 'boolean' },
      'full-history': { type: 'boolean' },
      session: { type: 'string' },
    },
    allowPositionals: false,
  });
  if (!values.design) {
    process.stderr.write('error: --design <id-or-prefix> is required\n');
    process.exit(1);
  }
  const num = (s: string | undefined): number | undefined =>
    s === undefined ? undefined : Number.parseInt(s, 10);
  const out: ReplayOptions = { design: values.design, json: values.json === true };
  if (values.since !== undefined) out.since = values.since;
  if (values.until !== undefined) out.until = values.until;
  if (values.db !== undefined) out.db = values.db;
  const w = num(values.window);
  if (w !== undefined) out.window = w;
  const trl = num(values['tool-result-limit']);
  if (trl !== undefined) out.toolResultLimit = trl;
  const til = num(values['tool-input-limit']);
  if (til !== undefined) out.toolInputLimit = til;
  const abl = num(values['aggressive-block-limit']);
  if (abl !== undefined) out.aggressiveBlockLimit = abl;
  const hc = num(values['hard-cap']);
  if (hc !== undefined) out.hardCap = hc;
  const t = num(values.turn);
  if (t !== undefined) out.turn = t;
  if (values['full-history'] === true) out.fullHistory = true;
  const sessionN = num(values.session);
  if (sessionN !== undefined) out.session = sessionN;
  return out;
}

function defaultDbPath(): string {
  // Mirrors Electron's `app.getPath('userData')` for the desktop app on the
  // common dev hosts. Override with --db <path> for non-standard installs.
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', '@open-codesign', 'desktop', 'designs.db');
  }
  if (process.platform === 'win32') {
    return join(
      process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
      '@open-codesign',
      'desktop',
      'designs.db',
    );
  }
  return join(
    process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'),
    '@open-codesign',
    'desktop',
    'designs.db',
  );
}

interface ChatRow {
  kind: string;
  payload: unknown;
  sessionId?: number;
}

function resolveNodeBinding(): string {
  // The repo ships per-runtime prebuilt better-sqlite3 bindings — Electron
  // host arch + Node.js — side by side. The default name (`.node`) is the
  // Electron x64 binary; tsx running on an arm64 Node fails to load it.
  // Pick the Node.js prebuild explicitly so the CLI works regardless of
  // host architecture.
  const pkgJson = require.resolve('better-sqlite3/package.json');
  return join(
    pkgJson.replace(/\/package\.json$/, ''),
    'build',
    'Release',
    'better_sqlite3.node-node.node',
  );
}

function loadChatRows(dbPath: string, opts: ReplayOptions): { designId: string; rows: ChatRow[] } {
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    nativeBinding: resolveNodeBinding(),
  });
  try {
    // Detect whether the session_id column has been migrated. Production
    // designs.db files predating the in-design new-conversation feature
    // won't have the column until the desktop app runs once and applies
    // additive migrations. The CLI is read-only — fall back to treating
    // every row as session 0.
    const cols = (
      db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    const hasSessionCol = cols.includes('session_id');
    if (!hasSessionCol && opts.session !== undefined && opts.session !== 0) {
      throw new Error(
        `--session ${opts.session} requested but the chat_messages.session_id column doesn't exist yet on this DB. Open the desktop app once to apply the additive migration, or pass --session 0.`,
      );
    }
    // Resolve --design as either full UUID or unique prefix.
    const designs = db
      .prepare('SELECT id FROM designs WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 5')
      .all(`${opts.design}%`) as Array<{ id: string }>;
    if (designs.length === 0) {
      throw new Error(`No design matched id-prefix "${opts.design}"`);
    }
    if (designs.length > 1) {
      const ids = designs.map((d) => d.id).join(', ');
      throw new Error(`Ambiguous --design "${opts.design}". Matches: ${ids}`);
    }
    const designId = designs[0]?.id;
    if (designId === undefined) throw new Error('Internal: design row missing id');

    const conditions: string[] = ['design_id = ?'];
    const params: unknown[] = [designId];
    if (opts.since !== undefined) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      conditions.push('created_at < ?');
      params.push(opts.until);
    }
    if (opts.session !== undefined && hasSessionCol) {
      // session_id was added by an additive migration; legacy rows come
      // back as NULL and the renderer treats them as session 0.
      // Mirror that fallback so `--session 0` still picks them up.
      conditions.push('COALESCE(session_id, 0) = ?');
      params.push(opts.session);
    }
    const sessionExpr = hasSessionCol ? 'COALESCE(session_id, 0)' : '0';
    const sql = `SELECT kind, payload, ${sessionExpr} AS session_id FROM chat_messages WHERE ${conditions.join(
      ' AND ',
    )} ORDER BY seq ASC`;
    const raw = db.prepare(sql).all(...params) as Array<{
      kind: string;
      payload: string;
      session_id: number;
    }>;
    const rows: ChatRow[] = raw.map((r) => ({
      kind: r.kind,
      payload: r.payload === null ? null : safeParse(r.payload),
      sessionId: r.session_id,
    }));
    return { designId, rows };
  } finally {
    db.close();
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Mirror of `apps/desktop/src/renderer/src/store.ts → buildHistoryFromChatRows`.
// Kept in sync with that function. The renderer module is browser-only (zustand,
// i18n) so we can't import it from a Node CLI; the spec (improver1.md §11)
// explicitly allows duplication. Update both when one changes.
// ---------------------------------------------------------------------------

const FULL_TRANSCRIPT_TURN_COUNT = 2;
const TOOL_TRANSCRIPT_BYTE_BUDGET = 120 * 1024;

interface ToolCallPayload {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: 'done' | 'error';
}

interface ToolResultSummary {
  text: string;
  isError: boolean;
}

function summariseToolResult(payload: ToolCallPayload): ToolResultSummary {
  const result = payload.result;
  let raw: string;
  if (typeof result === 'string') {
    raw = result;
  } else if (result === null || result === undefined) {
    raw = payload.status === 'error' ? '(tool returned an error)' : '(no output)';
  } else {
    try {
      raw = JSON.stringify(result);
    } catch {
      raw = String(result);
    }
  }
  const limit = 4000;
  const text =
    raw.length > limit ? `${raw.slice(0, limit)}\n…(truncated, ${raw.length} chars)` : raw;
  return { text, isError: payload.status === 'error' };
}

function summariseToolBatch(payloads: ToolCallPayload[]): string {
  if (payloads.length === 0) return '';
  const counts: Record<string, number> = {};
  let errors = 0;
  for (const p of payloads) {
    const key = p.toolName ?? '?';
    counts[key] = (counts[key] ?? 0) + 1;
    if (p.status === 'error') errors += 1;
  }
  const breakdown = Object.entries(counts)
    .map(([name, n]) => `${n}× ${name}`)
    .join(', ');
  const errSuffix = errors > 0 ? ` (${errors} error${errors === 1 ? '' : 's'})` : '';
  return `[prior turn condensed: ${breakdown}${errSuffix}]`;
}

function buildHistoryFromChatRows(
  rows: ReadonlyArray<ChatRow>,
  opts: { fullHistory?: boolean } = {},
): ChatMessage[] {
  type Turn = { userText: string; toolPayloads: ToolCallPayload[]; assistantText: string[] };
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const row of rows) {
    if (row.kind === 'user') {
      const text = (row.payload as { text?: string } | null)?.text;
      if (typeof text !== 'string' || text.length === 0) continue;
      current = { userText: text, toolPayloads: [], assistantText: [] };
      turns.push(current);
    } else if (current !== null) {
      if (row.kind === 'tool_call') {
        const p = row.payload as ToolCallPayload | null;
        if (p !== null) current.toolPayloads.push(p);
      } else if (row.kind === 'assistant_text') {
        const text = (row.payload as { text?: string } | null)?.text;
        if (typeof text === 'string' && text.length > 0) current.assistantText.push(text);
      }
    }
  }

  const out: ChatMessage[] = [];
  // --full-history: keep every turn verbatim (no summarisation), so the
  // pruner sees what mid-run passes would face. Default: match the
  // renderer's on-the-wire behaviour.
  const fullStart =
    opts.fullHistory === true ? 0 : Math.max(0, turns.length - FULL_TRANSCRIPT_TURN_COUNT);
  let totalToolBytes = 0;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;
    out.push({ role: 'user', content: turn.userText });
    if (i < fullStart) {
      const summary = summariseToolBatch(turn.toolPayloads);
      const tail = turn.assistantText[turn.assistantText.length - 1] ?? '';
      const condensed = [summary, tail].filter((s) => s.length > 0).join('\n\n');
      if (condensed.length > 0) out.push({ role: 'assistant', content: condensed });
      continue;
    }
    const leadingText = turn.assistantText.join('\n\n').trim();
    if (turn.toolPayloads.length === 0) {
      if (leadingText.length > 0) out.push({ role: 'assistant', content: leadingText });
      continue;
    }
    let prefixUsed = false;
    for (const p of turn.toolPayloads) {
      if (p.toolCallId === undefined || p.toolName === undefined) continue;
      const argsJson = JSON.stringify(p.args ?? {});
      const assistantContent = !prefixUsed && leadingText.length > 0 ? leadingText : '';
      prefixUsed = true;
      const summary = summariseToolResult(p);
      const pairBytes = assistantContent.length + argsJson.length + summary.text.length;
      const budget =
        opts.fullHistory === true ? Number.POSITIVE_INFINITY : TOOL_TRANSCRIPT_BYTE_BUDGET;
      if (totalToolBytes + pairBytes > budget) {
        out.push({
          role: 'assistant',
          content: `[tool transcript clipped — ${turn.toolPayloads.length} more tool calls omitted to stay under budget]`,
        });
        break;
      }
      out.push({
        role: 'assistant',
        content: assistantContent,
        toolCalls: [{ id: p.toolCallId, name: p.toolName, argsJson }],
      });
      out.push({
        role: 'tool',
        content: summary.text,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        isError: summary.isError,
      });
      totalToolBytes += pairBytes;
    }
  }
  return out;
}

// Mirror of `packages/core/src/agent.ts → chatMessageToAgentMessage`.
// Inlined so we don't import the agent.ts barrel (it transitively pulls
// in `frames/` / `design-skills/`, both of which use Vite-only `?raw`
// imports that tsx cannot resolve). The shapes here match what
// `buildTransformContext` reads — `role`, `content[].type`, `toolCallId`,
// `toolName` — which is all the pruner inspects.
function chatMessagesToReplayAgentMessages(messages: ChatMessage[]): ReplayAgentMessage[] {
  const out: ReplayAgentMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === undefined) continue;
    const timestamp = i + 1;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content, timestamp } as unknown as ReplayAgentMessage);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'toolResult',
        toolCallId: m.toolCallId ?? `historical-${timestamp}`,
        toolName: m.toolName ?? 'unknown',
        content: m.content.length === 0 ? [] : [{ type: 'text', text: m.content }],
        isError: m.isError === true,
        timestamp,
      } as unknown as ReplayAgentMessage);
      continue;
    }
    if (m.role === 'assistant') {
      const content: Array<{ type: string; [key: string]: unknown }> = [];
      if (m.content.length > 0) content.push({ type: 'text', text: m.content });
      if (m.toolCalls !== undefined) {
        for (const call of m.toolCalls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(call.argsJson) as Record<string, unknown>;
          } catch {
            // Malformed historical args — keep the tool_use entry but surface
            // an empty arg bag rather than dropping the call (a missing
            // tool_use breaks pi-ai's id pairing on real runs).
          }
          content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: parsedArgs });
        }
      }
      out.push({
        role: 'assistant',
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'replay-stub',
        content,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: m.toolCalls && m.toolCalls.length > 0 ? 'toolUse' : 'stop',
        timestamp,
      } as unknown as ReplayAgentMessage);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Replay the pruner. We capture the per-pass log entries via a collecting
// logger so we can extract collapse counts without re-walking the messages.
// ---------------------------------------------------------------------------

interface CollectedEntry {
  step: string | undefined;
  payload: Record<string, unknown>;
}

interface ReplayPassResult {
  before: number;
  after: number;
  hitAggressive: boolean;
  perToolCollapses: Record<string, number>;
  topByBytes?: unknown;
}

async function runPass(
  messages: ReplayAgentMessage[],
  tuning: PruneTuning,
): Promise<ReplayPassResult> {
  const entries: CollectedEntry[] = [];
  const log = {
    info: (msg: string, payload?: unknown) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const stepMatch = /step=(\w+)/.exec(msg);
      entries.push({ step: stepMatch?.[1], payload: p });
    },
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const transform = buildTransformContext(log, tuning);
  // The pi-agent-core AgentMessage union is not importable from this app
  // package; we duck-type it (only `role` is read by this script) and the
  // pruner doesn't mutate the messages it receives.
  await transform(messages as unknown as Parameters<typeof transform>[0]);
  const beforeEntry = entries.find((e) => e.step === 'caps');
  const aggressiveEntry = entries.find((e) => e.step === 'aggressive');
  const dominantEntry = entries.find((e) => e.step === 'aggressive_dominant_msgs');
  const before = (beforeEntry?.payload['before'] as number | undefined) ?? 0;
  const afterCaps = (beforeEntry?.payload['after'] as number | undefined) ?? 0;
  const afterAggressive = aggressiveEntry?.payload['after'] as number | undefined;
  const perToolCollapses =
    (aggressiveEntry?.payload['perToolCollapses'] as Record<string, number> | undefined) ??
    (beforeEntry?.payload['perToolCollapses'] as Record<string, number> | undefined) ??
    {};
  return {
    before,
    after: afterAggressive ?? afterCaps,
    hitAggressive: aggressiveEntry !== undefined,
    perToolCollapses,
    topByBytes: dominantEntry?.payload['topByBytes'],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface PerTurnReplay {
  turnIdx: number;
  messages: number;
  current: ReplayPassResult;
  proposed: ReplayPassResult | null;
}

async function main(): Promise<void> {
  const opts = parseFlags(process.argv.slice(2));
  const dbPath = opts.db ?? defaultDbPath();
  const { designId, rows } = loadChatRows(dbPath, opts);
  const fullHistory = buildHistoryFromChatRows(
    rows,
    opts.fullHistory === true ? { fullHistory: true } : {},
  );
  const fullAgent = chatMessagesToReplayAgentMessages(fullHistory);

  // Find user-message indices — each one is a turn boundary. We slice the
  // history up to (and not including) each subsequent user message so
  // each pass mirrors what the agent saw at the moment it called
  // `transformContext` for the next turn.
  const turnBoundaries: number[] = [];
  for (let i = 0; i < fullAgent.length; i += 1) {
    if (fullAgent[i]?.role === 'user') turnBoundaries.push(i);
  }

  const proposedTuning: PruneTuning = {};
  if (opts.window !== undefined) proposedTuning.recentWindow = opts.window;
  if (opts.toolResultLimit !== undefined) proposedTuning.toolResultLimit = opts.toolResultLimit;
  if (opts.toolInputLimit !== undefined) proposedTuning.toolInputLimit = opts.toolInputLimit;
  if (opts.aggressiveBlockLimit !== undefined) {
    proposedTuning.aggressiveBlockLimit = opts.aggressiveBlockLimit;
  }
  if (opts.hardCap !== undefined) proposedTuning.hardCapBytes = opts.hardCap;
  const hasProposedTuning = Object.keys(proposedTuning).length > 0;

  const replays: PerTurnReplay[] = [];
  const targetIdx = opts.turn !== undefined ? [opts.turn] : turnBoundaries.map((_, i) => i);
  for (const idx of targetIdx) {
    const start = turnBoundaries[idx];
    if (start === undefined) continue;
    const end = turnBoundaries[idx + 1] ?? fullAgent.length;
    const slice = fullAgent.slice(0, end);
    if (slice.length === 0) continue;
    const current = await runPass(slice, {});
    const proposed = hasProposedTuning ? await runPass(slice, proposedTuning) : null;
    replays.push({ turnIdx: idx, messages: slice.length, current, proposed });
  }

  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          designId,
          rows: rows.length,
          turns: turnBoundaries.length,
          tuningProposed: hasProposedTuning ? proposedTuning : null,
          replays,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`design: ${designId}\n`);
  process.stdout.write(`chat_messages: ${rows.length} rows\n`);
  process.stdout.write(`turns: ${turnBoundaries.length}\n`);
  if (hasProposedTuning) {
    process.stdout.write(`proposed tuning: ${JSON.stringify(proposedTuning)}\n`);
  } else {
    process.stdout.write('proposed tuning: (none — pass --window N etc. to compare)\n');
  }
  process.stdout.write('\n');

  let currentAggressive = 0;
  let proposedAggressive = 0;
  let currentByteSum = 0;
  let proposedByteSum = 0;
  for (const r of replays) {
    if (r.current.hitAggressive) currentAggressive += 1;
    if (r.proposed?.hitAggressive) proposedAggressive += 1;
    currentByteSum += r.current.after;
    if (r.proposed) proposedByteSum += r.proposed.after;
  }

  const headerCols = hasProposedTuning
    ? '  turn  msgs    before     current   proposed       Δ%   aggressive(c→p)'
    : '  turn  msgs    before      after  aggr  topTool';
  process.stdout.write(`${headerCols}\n`);
  for (const r of replays) {
    const aggrFlag = (b: boolean) => (b ? '!' : ' ');
    if (hasProposedTuning && r.proposed) {
      const delta =
        r.current.after > 0
          ? (((r.proposed.after - r.current.after) / r.current.after) * 100).toFixed(1)
          : '0.0';
      process.stdout.write(
        `  ${String(r.turnIdx).padStart(4)}  ${String(r.messages).padStart(4)}  ${formatBytes(
          r.current.before,
        )}  ${formatBytes(r.current.after)}  ${formatBytes(r.proposed.after)}  ${`${delta}%`.padStart(
          7,
        )}    ${aggrFlag(r.current.hitAggressive)}→${aggrFlag(r.proposed.hitAggressive)}\n`,
      );
    } else {
      const top = topToolFromCollapses(r.current.perToolCollapses);
      process.stdout.write(
        `  ${String(r.turnIdx).padStart(4)}  ${String(r.messages).padStart(4)}  ${formatBytes(
          r.current.before,
        )}  ${formatBytes(r.current.after)}    ${aggrFlag(r.current.hitAggressive)}  ${top}\n`,
      );
    }
  }

  process.stdout.write('\nsummary:\n');
  process.stdout.write(
    `  current: aggressive ${currentAggressive}/${replays.length} (${pct(
      currentAggressive,
      replays.length,
    )}), avg post-prune ${formatBytes(Math.round(currentByteSum / Math.max(1, replays.length)))}\n`,
  );
  if (hasProposedTuning) {
    const saved = currentByteSum - proposedByteSum;
    const savedPct = currentByteSum > 0 ? ((saved / currentByteSum) * 100).toFixed(1) : '0.0';
    process.stdout.write(
      `  proposed: aggressive ${proposedAggressive}/${replays.length} (${pct(
        proposedAggressive,
        replays.length,
      )}), avg post-prune ${formatBytes(
        Math.round(proposedByteSum / Math.max(1, replays.length)),
      )}\n`,
    );
    process.stdout.write(
      `  saved: ${formatBytes(saved)} total across replays (${savedPct}% byte reduction)\n`,
    );
  }
}

function formatBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function pct(n: number, d: number): string {
  if (d === 0) return '0%';
  return `${Math.round((n / d) * 100)}%`;
}

function topToolFromCollapses(collapses: Record<string, number>): string {
  let topName = '—';
  let topN = 0;
  for (const [name, n] of Object.entries(collapses)) {
    if (n > topN) {
      topN = n;
      topName = name;
    }
  }
  return topN > 0 ? `${topName}×${topN}` : '—';
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
