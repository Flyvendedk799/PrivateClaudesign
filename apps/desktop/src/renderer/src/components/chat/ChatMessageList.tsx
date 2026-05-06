import { useT } from '@open-codesign/i18n';
import type { ChatMessageRow, ChatToolCallPayload } from '@open-codesign/shared';
import { FileText, Pause } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useCodesignStore } from '../../store';
import { AssistantText } from './AssistantText';
import { ContinuationPendingRow } from './ContinuationPendingRow';
import { ReasoningSummaryPill } from './ReasoningSummaryPill';
import { UserMessage } from './UserMessage';
import { InlineTodoList, TodoSnapshotCollapsed, WorkingCard } from './WorkingCard';

/** Integration F — store-connected wrapper around `ContinuationPendingRow`.
 *  Pulls `continueRun` and `isGenerating` from the store so the row
 *  can drive the actual resume flow. Kept as a thin shim because the
 *  pure renderer component lives in its own file (testable in isolation
 *  via the formatContinuationLabel pure-fn tests). */
function ContinuationPendingRowConnected({
  payload,
}: {
  payload: import('@open-codesign/shared').ChatContinuationPendingPayload;
}) {
  const continueRun = useCodesignStore((s) => s.continueRun);
  const isGenerating = useCodesignStore((s) => s.isGenerating);
  return (
    <ContinuationPendingRow
      payload={payload}
      onContinue={() => {
        if (isGenerating) return;
        void continueRun();
      }}
    />
  );
}

/** Visual marker between messages from different in-design sessions
 *  (Improver1 follow-up — "new conversation" feature). Older rows
 *  still scroll above the line; rows below the divider belong to the
 *  current session and are the only ones the LLM sees on the next
 *  turn. Decorative — no interaction. */
function SessionDivider() {
  const t = useT();
  return (
    <div
      className="my-[var(--space-2)] flex items-center gap-[var(--space-2)] text-[var(--text-xs)] text-[var(--color-text-muted)]"
      aria-label={t('chat.newSession.previousSessionDivider')}
    >
      <span className="flex-1 h-px bg-[var(--color-border-subtle)]" />
      <span className="uppercase tracking-wide font-medium">
        {t('chat.newSession.previousSessionDivider')}
      </span>
      <span className="flex-1 h-px bg-[var(--color-border-subtle)]" />
    </div>
  );
}

/** Backlog-3 §5 — checkpoint row + Resume CTA. */
function CheckpointRow({
  turnCount,
  elapsedSec,
  preview,
}: {
  turnCount: number;
  elapsedSec: number;
  preview: string;
}) {
  const resume = useCodesignStore((s) => s.resumeFromCheckpoint);
  const isGenerating = useCodesignStore((s) => s.isGenerating);
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-background-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[12.5px]">
      <div className="flex items-center gap-[6px] text-[var(--color-text-muted)]">
        <Pause className="w-[14px] h-[14px]" aria-hidden />
        <span className="font-medium text-[var(--color-text-primary)]">Stopped — checkpoint</span>
        <span className="ml-auto tabular-nums">
          {turnCount} {turnCount === 1 ? 'turn' : 'turns'} · {elapsedSec}s
        </span>
      </div>
      {preview.length > 0 ? (
        <div className="mt-[var(--space-1)] text-[var(--color-text-secondary)] line-clamp-2">
          {preview}
        </div>
      ) : null}
      <div className="mt-[var(--space-2)]">
        <button
          type="button"
          onClick={() => void resume()}
          disabled={isGenerating}
          className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] text-[var(--color-on-accent,white)] px-[var(--space-3)] py-[3px] text-[11.5px] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Resume from checkpoint
        </button>
      </div>
    </div>
  );
}

interface ChatMessageListProps {
  messages: ChatMessageRow[];
  loading: boolean;
  isGenerating?: boolean;
  empty?: React.ReactNode;
  streamingText?: string | null;
  /** Per-turn live "summarized thinking" buffer streamed from Claude's
   *  adaptive-thinking response. Drives the thoughts panel — when present
   *  it replaces the static "Thinking…" dots so the user can SEE the
   *  model reasoning in real time instead of staring at an inert
   *  animation for 30–60 s. */
  streamingThinking?: string | null;
  /** In-flight tool-call composition (pi-ai's toolcall_start/delta events).
   *  Drives the "drafting" indicator that bridges the 1–3 s gap between
   *  thinking ending and the runtime emitting tool_call_start. */
  streamingToolDraft?: { toolName: string; bytes: number } | null;
  pendingToolCalls?: ChatToolCallPayload[];
  /** Sequence-7 (game-mode guardrails) — a precomputed lookup from
   *  snapshotId → 1-3 short "what changed" lines. The artifact_delivered
   *  row renders these next to the file label when its snapshotId hits
   *  the map. Computation lives in the parent (Sidebar) so this
   *  component stays a pure renderer. Pass `null`/`undefined` to disable. */
  snapshotDiffsBySnapshotId?: Record<string, ReadonlyArray<string>> | null;
}

interface RenderItem {
  key: string;
  node: React.ReactNode;
}

/**
 * plan0305 P2.1 — belt-and-braces filter for inter-tool narration that
 * the model emitted as plain assistant_text instead of as part of a tool
 * call (e.g. "Now adding the keyframes…", "Good, let me try…"). These
 * rows render as full chat bubbles and pollute the chat as filler.
 *
 * A row is treated as inter-tool narration when ALL of the following hold:
 *   1. its text is ≤ MAX_NARRATION_CHARS (≈ short transition phrase, not a
 *      deliverable summary — the run-traces' deliverable summaries were
 *      700–1500+ chars; transitions were 50–250)
 *   2. AT LEAST ONE tool_call follows it before the next user row or EOF
 *   3. EVERY message between it and the next user row (or EOF) is either
 *      another assistant_text or a tool_call (no artifact_delivered, error,
 *      etc. — those would mean this text is part of a delivery boundary
 *      and should stay rendered)
 *
 * The model's final post-`done` summary always survives this filter
 * because (a) it's typically long-form narrative > 180 chars, and (b) the
 * artifact_delivered row that follows it makes condition 3 fail.
 *
 * Exported for unit testing.
 */
export const MAX_NARRATION_CHARS = 180;
export function isInterToolNarration(messages: readonly ChatMessageRow[], index: number): boolean {
  const msg = messages[index];
  if (!msg || msg.kind !== 'assistant_text') return false;
  const text = (msg.payload as { text?: string } | undefined)?.text ?? '';
  if (text.length > MAX_NARRATION_CHARS) return false;
  // Walk forward until the FIRST non-text non-user boundary. The kind of
  // that boundary decides:
  //   - tool_call           → mid-stream "Now I'll …" intent line → DROP
  //   - artifact_delivered  → final delivery boundary             → KEEP
  //   - error               → context for a failure               → KEEP
  //   - user                → end of turn with no further action  → KEEP
  //   - end of stream       → live tail                           → KEEP
  // This is stricter than "any tool_call exists somewhere before
  // artifact_delivered" — that older form falsely kept every mid-stream
  // intent line in any run that produced an artifact (FPS run session 7,
  // 2026-05-06: 38 tool_calls and 15 short intent lines all leaked through
  // because seq 488 artifact_delivered terminated the walk).
  for (let j = index + 1; j < messages.length; j += 1) {
    const next = messages[j];
    if (!next) break;
    if (next.kind === 'user') return false;
    if (next.kind === 'assistant_text') continue;
    if (next.kind === 'tool_call') return true;
    return false;
  }
  return false;
}

/** Phase 1 — render plan for a chat's `set_todos` snapshots.
 *
 *  A long run typically fires `set_todos` 3-5 times (planning → mid-progress
 *  → final). Rendering each as a full `<InlineTodoList>` puts the 0/N
 *  planning snapshot at the TOP of the user's eye-line, anchoring the
 *  perception that "no todos got done" even when the latest snapshot is
 *  N/N. Run trace 2026-05-06 design ba2adf62 session 7: 0/28 → 14/28 →
 *  28/28 — the user reported "started from scratch with no todos done"
 *  because the 0/28 card was the first one they saw.
 *
 *  The plan returns:
 *    - collapsedSeqs: which set_todos rows render as one-line history pills
 *    - inlineLatestSeq: the chronological-position latest (when not generating)
 *    - hoistedLatestSeq: the latest, hoisted to a sticky banner (when generating)
 *
 *  When `pendingToolCalls` carries a set_todos, the pending-tool render path
 *  owns the live snapshot; all persisted snapshots are then historical. */
export interface TodoSnapshotPlan {
  collapsedSeqs: ReadonlySet<number>;
  inlineLatestSeq: number | null;
  hoistedLatestSeq: number | null;
}
export function planTodoSnapshots(
  messages: readonly ChatMessageRow[],
  hasPendingTodos: boolean,
  isGenerating: boolean,
): TodoSnapshotPlan {
  const todoSeqs: number[] = [];
  for (const m of messages) {
    if (
      m.kind === 'tool_call' &&
      (m.payload as ChatToolCallPayload | undefined)?.toolName === 'set_todos'
    ) {
      todoSeqs.push(m.seq);
    }
  }
  if (todoSeqs.length === 0) {
    return { collapsedSeqs: new Set(), inlineLatestSeq: null, hoistedLatestSeq: null };
  }
  if (hasPendingTodos) {
    return {
      collapsedSeqs: new Set(todoSeqs),
      inlineLatestSeq: null,
      hoistedLatestSeq: null,
    };
  }
  const latest = todoSeqs[todoSeqs.length - 1] as number;
  const collapsedSeqs = new Set(todoSeqs);
  collapsedSeqs.delete(latest);
  if (isGenerating) {
    return { collapsedSeqs, inlineLatestSeq: null, hoistedLatestSeq: latest };
  }
  return { collapsedSeqs, inlineLatestSeq: latest, hoistedLatestSeq: null };
}

/**
 * Walks the chat message stream once and groups every run of consecutive
 * `tool_call` rows — regardless of verbGroup — into a single WorkingCard.
 * The bucket flushes on any non-tool_call row (assistant_text, user, error,
 * artifact_delivered) which gives us a clean per-turn "Working" card followed
 * by a plain assistant prose bubble. SQLite-replayed history obeys the same
 * grouping because rows are read back in `seq` order.
 */
export function ChatMessageList({
  messages,
  loading,
  isGenerating,
  empty,
  streamingText,
  streamingThinking,
  streamingToolDraft,
  pendingToolCalls,
  snapshotDiffsBySnapshotId,
}: ChatMessageListProps) {
  const t = useT();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current?.parentElement;
    if (!el) return;
    function onScroll(): void {
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 48;
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-scrolls on new messages or streaming text
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streamingText]);

  if (loading && messages.length === 0 && !streamingText) {
    return (
      <div className="text-[var(--text-sm)] text-[var(--color-text-muted)]">
        {t('common.loading')}
      </div>
    );
  }

  if (messages.length === 0 && !streamingText) {
    return <>{empty}</>;
  }

  const items: RenderItem[] = [];
  let bucket: { calls: ChatToolCallPayload[]; firstSeq: number } | null = null;

  const flush = () => {
    if (!bucket || bucket.calls.length === 0) {
      bucket = null;
      return;
    }
    const cur = bucket;
    items.push({
      key: `tc-${cur.firstSeq}`,
      node: <WorkingCard calls={cur.calls} />,
    });
    bucket = null;
  };

  // Phase 1 — pre-compute which set_todos rows render as full vs collapsed
  // vs hoisted (sticky). The pure helper drives both the in-place rendering
  // below AND the sticky-top banner injected just before the items map.
  const hasPendingTodos = Boolean(pendingToolCalls?.some((c) => c.toolName === 'set_todos'));
  const todoPlan = planTodoSnapshots(messages, hasPendingTodos, Boolean(isGenerating));
  const hoistedLatestCall: ChatToolCallPayload | null = (() => {
    if (todoPlan.hoistedLatestSeq === null) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.seq === todoPlan.hoistedLatestSeq && m.kind === 'tool_call') {
        return (m.payload as ChatToolCallPayload | undefined) ?? null;
      }
    }
    return null;
  })();

  // Track session_id transitions so we can inject a "Previous conversation"
  // divider above each new session. Rows older than the in-design new-session
  // feature read back as sessionId=0; first divider only appears when the
  // user has actually clicked New Conversation at least once on this design.
  let prevSessionId: number | null = null;

  for (let mi = 0; mi < messages.length; mi += 1) {
    const msg = messages[mi];
    if (!msg) continue;
    const msgSession = msg.sessionId ?? 0;
    if (prevSessionId !== null && msgSession !== prevSessionId) {
      // Flush pending tool-call bucket BEFORE the divider so the cluster
      // stays inside the previous session visually.
      flush();
      items.push({
        key: `session-divider-${msg.seq}`,
        node: <SessionDivider />,
      });
    }
    prevSessionId = msgSession;
    if (msg.kind === 'tool_call') {
      const call = (msg.payload as ChatToolCallPayload) ?? null;
      if (!call) continue;
      // set_todos breaks the bucket — render the checklist exactly where the
      // agent fired it so the chronological story stays intact (otherwise
      // WorkingCard would pull the todos to the bottom of the cluster).
      if (call.toolName === 'set_todos') {
        flush();
        if (todoPlan.hoistedLatestSeq === msg.seq) {
          // Hoisted to the sticky banner above — skip in-place render.
          continue;
        }
        if (todoPlan.collapsedSeqs.has(msg.seq)) {
          items.push({
            key: `todos-${msg.seq}`,
            node: <TodoSnapshotCollapsed call={call} />,
          });
          continue;
        }
        items.push({
          key: `todos-${msg.seq}`,
          node: (
            <InlineTodoList
              call={call}
              isLatest={msg.seq === todoPlan.inlineLatestSeq}
              isGenerating={Boolean(isGenerating)}
            />
          ),
        });
        continue;
      }
      if (!bucket) bucket = { calls: [], firstSeq: msg.seq };
      bucket.calls.push(call);
      continue;
    }

    flush();

    if (msg.kind === 'user') {
      const p = msg.payload as { text?: string; attachedSkills?: string[] };
      items.push({
        key: `u-${msg.seq}`,
        node: (
          <UserMessage
            text={p?.text ?? ''}
            {...(p?.attachedSkills ? { attachedSkills: p.attachedSkills } : {})}
          />
        ),
      });
    } else if (msg.kind === 'assistant_text') {
      // plan0305 P2.1 — drop short transitional narration that's
      // sandwiched between tool_calls. The deliverable summary at the
      // end of a turn always survives (it's longer than the cutoff
      // and is followed by artifact_delivered, not another tool_call).
      if (isInterToolNarration(messages, mi)) continue;
      const p = msg.payload as { text?: string };
      const isLast = msg === messages[messages.length - 1];
      const streaming = Boolean(isGenerating) && isLast;
      items.push({
        key: `a-${msg.seq}`,
        node: <AssistantText text={p?.text ?? ''} streaming={streaming} />,
      });
    } else if (msg.kind === 'artifact_delivered') {
      const p = msg.payload as { filename?: string; createdAt?: string };
      const label = p?.filename ?? t('sidebar.chat.artifactDefaultLabel');
      const diffLines =
        msg.snapshotId !== null && snapshotDiffsBySnapshotId
          ? snapshotDiffsBySnapshotId[msg.snapshotId]
          : undefined;
      items.push({
        key: `art-${msg.seq}`,
        node: (
          <div className="flex flex-col gap-[var(--space-1)] rounded-[var(--radius-md)] border border-[var(--color-border-muted)] bg-[var(--color-surface)] px-[var(--space-3)] py-[var(--space-2)]">
            <div className="flex items-center gap-[var(--space-2)]">
              <FileText
                className="w-[14px] h-[14px] text-[var(--color-text-secondary)] shrink-0"
                aria-hidden
              />
              <span className="text-[12.5px] font-[ui-monospace,Menlo,monospace] text-[var(--color-text-primary)] truncate">
                {label}
              </span>
              <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">
                {t('sidebar.chat.artifactDelivered')}
              </span>
            </div>
            {diffLines && diffLines.length > 0 && (
              <ul className="mt-[var(--space-1)] flex flex-col gap-[2px] pl-[20px] text-[11.5px] font-[ui-monospace,Menlo,monospace] text-[var(--color-text-muted)]">
                {diffLines.map((line) => (
                  <li key={line} className="truncate">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ),
      });
    } else if (msg.kind === 'error') {
      const p = msg.payload as {
        message?: string;
        code?: string;
        runId?: string;
        requestId?: string;
        upstream_status?: number;
        upstream_request_id?: string;
        upstream_provider?: string;
      };
      const requestId = p?.requestId ?? p?.upstream_request_id;
      const status = p?.upstream_status;
      const provider = p?.upstream_provider;
      const code = p?.code;
      const runId = p?.runId;
      const message = p?.message ?? t('errors.unknown');
      const copyDiagnostic = (): void => {
        const blob = JSON.stringify(
          {
            schemaVersion: 1,
            message,
            ...(code !== undefined ? { code } : {}),
            ...(runId !== undefined ? { runId } : {}),
            ...(status !== undefined ? { httpStatus: status } : {}),
            ...(provider !== undefined ? { provider } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
            capturedAt: new Date().toISOString(),
          },
          null,
          2,
        );
        try {
          void navigator.clipboard.writeText(blob);
        } catch {
          // Clipboard unavailable in some sandboxed contexts — silently
          // ignore; users can still read the visible error.
        }
      };
      items.push({
        key: `err-${msg.seq}`,
        node: (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-surface)] px-[var(--space-3)] py-[var(--space-2)] text-[12.5px] font-[var(--font-mono),ui-monospace,Menlo,monospace] text-[var(--color-text-primary)]">
            <div className="break-all whitespace-pre-wrap">{message}</div>
            {(code !== undefined ||
              runId !== undefined ||
              status !== undefined ||
              requestId !== undefined ||
              provider !== undefined) && (
              <div className="mt-[var(--space-1)] flex flex-wrap items-center gap-[var(--space-2)] text-[11.5px] text-[var(--color-text-muted)]">
                {code !== undefined ? <span>code {code}</span> : null}
                {runId !== undefined ? <span>run {runId}</span> : null}
                {status !== undefined ? <span>HTTP {status}</span> : null}
                {provider !== undefined ? <span>{provider}</span> : null}
                {requestId !== undefined ? <span>req {requestId}</span> : null}
                <button
                  type="button"
                  onClick={copyDiagnostic}
                  className="ml-auto rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-background-secondary)] px-[var(--space-2)] py-[1px] hover:bg-[var(--color-background-tertiary)]"
                  title="Copy a JSON diagnostic blob (no telemetry; clipboard only)"
                >
                  Copy diagnostic
                </button>
              </div>
            )}
          </div>
        ),
      });
    } else if (msg.kind === 'continuation_pending') {
      // Phase 4 — first-class continuation marker. Renders a non-modal
      // Run-paused panel with a Continue button. Integration F wires
      // onContinue to the store action that asks main to rebuild the
      // continuation prompt and dispatches it through sendPrompt.
      const p = (msg.payload ?? null) as
        | import('@open-codesign/shared').ChatContinuationPendingPayload
        | null;
      if (!p) continue;
      items.push({
        key: `cp-${msg.seq}`,
        node: <ContinuationPendingRowConnected payload={p} />,
      });
    } else if (msg.kind === 'reasoning_summary') {
      // Phase 2 — adaptive-thinking rollup persisted at burst → tool/text
      // transitions. Renders as a compact, click-to-expand pill so the
      // chat stays scannable while preserving the full reasoning trace.
      const p = (msg.payload ?? null) as
        | import('@open-codesign/shared').ChatReasoningSummaryPayload
        | null;
      if (!p) continue;
      items.push({
        key: `rs-${msg.seq}`,
        node: <ReasoningSummaryPill payload={p} />,
      });
    } else if (msg.kind === 'checkpoint') {
      // Backlog-3 §5 — checkpoint row with Resume CTA. Payload carries
      // turn count + elapsed + last assistant text preview.
      const p = msg.payload as {
        turnCount?: number;
        elapsedMs?: number;
        lastAssistantText?: string;
        createdAt?: number;
      } | null;
      const turnCount = p?.turnCount ?? 0;
      const elapsedSec = Math.round((p?.elapsedMs ?? 0) / 1000);
      const preview = p?.lastAssistantText ?? '';
      items.push({
        key: `chk-${msg.seq}`,
        node: <CheckpointRow turnCount={turnCount} elapsedSec={elapsedSec} preview={preview} />,
      });
    }
  }

  flush();

  return (
    <div ref={scrollRef} className="space-y-[var(--space-5)]">
      {hoistedLatestCall ? (
        <div
          key="todos-sticky"
          data-testid="todos-sticky-latest"
          className="chat-todo-sticky bg-[var(--color-background-primary)]/95 backdrop-blur-[2px] border-b border-[var(--color-border-subtle)] -mx-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)]"
          style={{ position: 'sticky', top: 0, zIndex: 5 }}
        >
          <InlineTodoList call={hoistedLatestCall} isLatest isGenerating />
        </div>
      ) : null}
      {items.map((item) => (
        <div key={item.key}>{item.node}</div>
      ))}
      {/* In-flight tool calls (memory only, not yet persisted). Same logic as
          the persisted stream: set_todos breaks the cluster and renders inline
          so the chronological position is preserved while the agent is still
          mid-turn. */}
      {pendingToolCalls && pendingToolCalls.length > 0 && (
        <div key="pending-tools" className="space-y-[var(--space-1)]">
          {(() => {
            const groups: React.ReactNode[] = [];
            let pendingBucket: ChatToolCallPayload[] = [];
            const flushPending = (idx: number): void => {
              if (pendingBucket.length === 0) return;
              groups.push(<WorkingCard key={`p-cluster-${idx}`} calls={pendingBucket} />);
              pendingBucket = [];
            };
            // The "latest" set_todos for inference is the LAST one in the
            // pending stream. Older pending set_todos are mid-run updates.
            let latestPendingTodosIdx = -1;
            for (let i = pendingToolCalls.length - 1; i >= 0; i -= 1) {
              if (pendingToolCalls[i]?.toolName === 'set_todos') {
                latestPendingTodosIdx = i;
                break;
              }
            }
            for (let i = 0; i < pendingToolCalls.length; i += 1) {
              const c = pendingToolCalls[i];
              if (!c) continue;
              if (c.toolName === 'set_todos') {
                flushPending(i);
                groups.push(
                  <InlineTodoList
                    key={`p-todos-${i}`}
                    call={c}
                    isLatest={i === latestPendingTodosIdx}
                    isGenerating={Boolean(isGenerating)}
                  />,
                );
                continue;
              }
              pendingBucket.push(c);
            }
            flushPending(pendingToolCalls.length);
            return groups;
          })()}
        </div>
      )}
      {(() => {
        if (!streamingText || streamingText.length === 0) return null;
        // Defensive dedupe: if the most recent persisted assistant_text is
        // already a prefix-equal/superset of the streaming buffer (the IPC
        // turn_end persisted before the streaming reset landed), skip the
        // ephemeral bubble to avoid showing the same prose twice.
        const lastAssistant = [...messages].reverse().find((m) => m.kind === 'assistant_text');
        const lastText =
          (lastAssistant?.payload as { text?: string } | undefined)?.text?.trim() ?? '';
        const streamingTrim = streamingText.trim();
        if (lastText && (lastText === streamingTrim || lastText.startsWith(streamingTrim))) {
          return null;
        }
        return (
          <div key="streaming-assistant">
            <AssistantText text={streamingText} streaming />
          </div>
        );
      })()}
      {(() => {
        // Drafting tool indicator — shown while the model is streaming the
        // args of a tool call (between thinking_end and the runtime's
        // tool_call_start). Tool icon + name + animated dots so the user
        // sees "Composing edit…" instead of a 1–3 s blank window. The byte
        // counter ticks up as deltas arrive, hinting at args size for
        // bigger str_replace patches.
        if (!streamingToolDraft) return null;
        const tn = streamingToolDraft.toolName;
        // Friendly label per tool — mirrors WorkingCard's iconAndLabel
        // taxonomy at a higher level. Defaults to the raw tool name.
        const friendlyName =
          tn === 'set_todos'
            ? 'Updating plan'
            : tn === 'str_replace_based_edit_tool' || tn === 'text_editor'
              ? 'Composing edit'
              : tn === 'done'
                ? 'Finalizing'
                : tn === 'render_preview'
                  ? 'Capturing preview'
                  : tn === 'read_url'
                    ? 'Composing fetch'
                    : tn === 'list_design_skills'
                      ? 'Listing skills'
                      : tn === 'view_design_skill'
                        ? 'Reading skill'
                        : tn === 'declare_tweak_schema'
                          ? 'Declaring tweak schema'
                          : `Calling ${tn}`;
        return (
          <div
            key="streaming-tool-draft"
            className="inline-flex items-center gap-[var(--space-2)] rounded-2xl rounded-bl-md bg-[var(--color-surface)] border border-[var(--color-accent)]/30 px-[var(--space-3)] py-[var(--space-2)] text-[12px] text-[var(--color-text-primary)]"
            aria-live="polite"
          >
            <span className="relative inline-flex w-[10px] h-[10px] items-center justify-center shrink-0">
              <span className="absolute inline-block w-[5px] h-[5px] rounded-full bg-[var(--color-accent)] animate-pulse" />
              <span className="absolute inline-block w-[10px] h-[10px] rounded-full border border-[var(--color-accent)]/40 animate-ping" />
            </span>
            <span className="font-medium">{friendlyName}</span>
            <span className="codesign-stream-dot">·</span>
            <span className="codesign-stream-dot" style={{ animationDelay: '150ms' }}>
              ·
            </span>
            <span className="codesign-stream-dot" style={{ animationDelay: '300ms' }}>
              ·
            </span>
            {streamingToolDraft.bytes > 0 ? (
              <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
                {streamingToolDraft.bytes < 1024
                  ? `${streamingToolDraft.bytes} B`
                  : `${(streamingToolDraft.bytes / 1024).toFixed(1)} KB`}
              </span>
            ) : null}
          </div>
        );
      })()}
      {(() => {
        // Live thoughts panel. Two modes:
        //  (a) `streamingThinking` is non-empty → render Claude's
        //      summarized reasoning live, italicized and fading in. The
        //      panel naturally clears when text_delta or tool_call_start
        //      land (handled by the agent stream hook).
        //  (b) Generating but nothing streamed yet AND last message is
        //      the user's prompt → fall back to the dot animation so the
        //      gap between submit and first event isn't silent.
        if (!isGenerating) return null;
        if (streamingText && streamingText.length > 0) return null;
        const hasThoughts = streamingThinking && streamingThinking.length > 0;
        if (hasThoughts) {
          return (
            <div
              key="thinking-stream"
              className="rounded-2xl rounded-bl-md bg-[var(--color-surface)]/60 border border-[var(--color-border-muted)] px-[var(--space-3)] py-[var(--space-2)] max-w-[640px]"
              aria-live="polite"
            >
              <div className="flex items-center gap-[var(--space-1)] text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] mb-[var(--space-1)]">
                <span className="codesign-stream-dot">·</span>
                <span className="codesign-stream-dot" style={{ animationDelay: '150ms' }}>
                  ·
                </span>
                <span className="codesign-stream-dot" style={{ animationDelay: '300ms' }}>
                  ·
                </span>
                <span className="ml-[var(--space-1)]">{t('sidebar.chat.thinking')}</span>
              </div>
              <div className="text-[12px] italic leading-[1.55] text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
                {streamingThinking}
              </div>
            </div>
          );
        }
        const last = messages[messages.length - 1];
        if (last?.kind !== 'user') return null;
        return (
          <div
            key="thinking-placeholder"
            className="inline-flex items-center gap-[var(--space-2)] rounded-2xl rounded-bl-md bg-[var(--color-surface)] border border-[var(--color-border-muted)] px-[var(--space-3)] py-[var(--space-2)] text-[12px] text-[var(--color-text-muted)]"
            aria-live="polite"
          >
            <span className="codesign-stream-dot">·</span>
            <span className="codesign-stream-dot" style={{ animationDelay: '150ms' }}>
              ·
            </span>
            <span className="codesign-stream-dot" style={{ animationDelay: '300ms' }}>
              ·
            </span>
            <span className="ml-[var(--space-1)]">{t('sidebar.chat.thinking')}</span>
          </div>
        );
      })()}
      <div ref={bottomRef} />
    </div>
  );
}
