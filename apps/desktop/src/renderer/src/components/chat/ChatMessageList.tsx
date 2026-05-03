import { useT } from '@open-codesign/i18n';
import type { ChatMessageRow, ChatToolCallPayload } from '@open-codesign/shared';
import { FileText } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { AssistantText } from './AssistantText';
import { UserMessage } from './UserMessage';
import { InlineTodoList, WorkingCard } from './WorkingCard';

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
  let toolCallSeen = false;
  for (let j = index + 1; j < messages.length; j += 1) {
    const next = messages[j];
    if (!next) break;
    if (next.kind === 'user') break;
    if (next.kind === 'tool_call') {
      toolCallSeen = true;
      continue;
    }
    if (next.kind === 'assistant_text') continue;
    return false;
  }
  return toolCallSeen;
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

  // Pre-compute which set_todos rows are "latest" so the InlineTodoList
  // can apply the in-progress inference only to the actual most-recent
  // checklist (older lists are historical and shouldn't pulse). The latest
  // is whichever set_todos appears last across pendingToolCalls (newer
  // wins) OR persisted messages.
  let latestPersistedTodosSeq = -1;
  if (!pendingToolCalls?.some((c) => c.toolName === 'set_todos')) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (
        m?.kind === 'tool_call' &&
        (m.payload as ChatToolCallPayload | undefined)?.toolName === 'set_todos'
      ) {
        latestPersistedTodosSeq = m.seq;
        break;
      }
    }
  }

  for (let mi = 0; mi < messages.length; mi += 1) {
    const msg = messages[mi];
    if (!msg) continue;
    if (msg.kind === 'tool_call') {
      const call = (msg.payload as ChatToolCallPayload) ?? null;
      if (!call) continue;
      // set_todos breaks the bucket — render the checklist exactly where the
      // agent fired it so the chronological story stays intact (otherwise
      // WorkingCard would pull the todos to the bottom of the cluster).
      if (call.toolName === 'set_todos') {
        flush();
        items.push({
          key: `todos-${msg.seq}`,
          node: (
            <InlineTodoList
              call={call}
              isLatest={msg.seq === latestPersistedTodosSeq}
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
      items.push({
        key: `art-${msg.seq}`,
        node: (
          <div className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border border-[var(--color-border-muted)] bg-[var(--color-surface)] px-[var(--space-3)] py-[var(--space-2)]">
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
        ),
      });
    } else if (msg.kind === 'error') {
      const p = msg.payload as { message?: string };
      items.push({
        key: `err-${msg.seq}`,
        node: (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-surface)] px-[var(--space-3)] py-[var(--space-2)] text-[12.5px] font-[var(--font-mono),ui-monospace,Menlo,monospace] text-[var(--color-text-primary)] break-all whitespace-pre-wrap">
            {p?.message ?? t('errors.unknown')}
          </div>
        ),
      });
    }
  }

  flush();

  return (
    <div ref={scrollRef} className="space-y-[var(--space-5)]">
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
