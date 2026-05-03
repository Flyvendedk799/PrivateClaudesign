/**
 * Sticky status header above the chat list. Shows a compact narrative of
 * what the agent is doing right now: activity label, todo progress, and
 * (only if chunks ever come back) inter-chunk "auto-resuming" hint.
 * Disappears when the agent isn't running.
 *
 * Single-session note: post-2026-04-27 the framework runs everything in
 * one chunk by default (MAX_AUTO_CONTINUE=1). The "Chunk 1 / 1" pill was
 * always visible and never changed — pure noise. We now hide the chunk
 * pill unless chunkCap > 1, so it only appears if a future build re-enables
 * chunked execution.
 */

import { useT } from '@open-codesign/i18n';
import { Check, Circle, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useCodesignStore } from '../../store';

interface TodoItem {
  text: string;
  done: boolean;
}

/** Truncate a todo label so the row stays single-line in the narrow
 *  sidebar. ~38 chars matches the typical sidebar width at default font. */
function truncateLabel(s: string): string {
  return s.length > 38 ? `${s.slice(0, 37)}…` : s;
}

/** Pick which todo rows to render. We cap at 4 visible rows so the header
 *  stays compact, but we always include the active item. Strategy:
 *   - List ≤ 4: render all.
 *   - Active item index 0 or 1: show first 4.
 *   - Active item near the end: show last 4.
 *   - Active item in the middle: show 1 before active, active, 2 after.
 *  Returns { visible, hiddenBefore, hiddenAfter } so the UI can render
 *  "+N more" indicators on either side. */
function pickVisibleTodos(
  todos: TodoItem[],
  activeIdx: number,
): {
  visible: Array<{ todo: TodoItem; index: number }>;
  hiddenBefore: number;
  hiddenAfter: number;
} {
  const MAX_VISIBLE = 4;
  if (todos.length <= MAX_VISIBLE) {
    return {
      visible: todos.map((todo, index) => ({ todo, index })),
      hiddenBefore: 0,
      hiddenAfter: 0,
    };
  }
  let start: number;
  if (activeIdx <= 1) {
    start = 0;
  } else if (activeIdx >= todos.length - 2) {
    start = todos.length - MAX_VISIBLE;
  } else {
    start = activeIdx - 1;
  }
  const end = start + MAX_VISIBLE;
  return {
    visible: todos.slice(start, end).map((todo, i) => ({ todo, index: start + i })),
    hiddenBefore: start,
    hiddenAfter: todos.length - end,
  };
}

function parseLatestTodos(
  messages: ReturnType<typeof useCodesignStore.getState>['chatMessages'],
): TodoItem[] {
  // Walk backwards: most recent set_todos wins. The set_todos tool emits
  // `args: { items: [{ text, checked }] }` (see packages/core/src/tools/set-todos.ts).
  // Args persist intact across chat:update-tool-status:v1 (snapshots-db.ts
  // uses json_set on $.status only, never touches $.args).
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.kind !== 'tool_call') continue;
    const payload = m.payload as { toolName?: string; args?: { items?: unknown } } | null;
    if (!payload || payload.toolName !== 'set_todos') continue;
    const raw = payload.args?.items;
    if (!Array.isArray(raw)) return [];
    const items: TodoItem[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const obj = r as { text?: unknown; checked?: unknown };
      if (typeof obj.text !== 'string') continue;
      items.push({ text: obj.text, done: obj.checked === true });
    }
    return items;
  }
  return [];
}

export function ChatStatusHeader() {
  // useT was used by the previous "Thinking…" fallback; the new
  // narrative draws from agentLiveness instead.
  void useT;
  const isGenerating = useCodesignStore((s) => s.isGenerating);
  const chunkProgress = useCodesignStore((s) => s.chunkProgress);
  const chatMessages = useCodesignStore((s) => s.chatMessages);
  const pendingToolCalls = useCodesignStore((s) => s.pendingToolCalls);
  const agentLiveness = useCodesignStore((s) => s.agentLiveness);
  const isRefinement = useCodesignStore((s) => s.currentRunIsRefinement);

  // 1Hz tick so the "Quiet for Ns…" / "Waiting for first token Ns" labels
  // re-render every second. Cheap; React batches the re-renders.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isGenerating) return;
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [isGenerating]);

  const todos = useMemo(() => parseLatestTodos(chatMessages), [chatMessages]);

  if (!isGenerating) return null;
  const isChunked = chunkProgress != null && chunkProgress.chunkCap > 1;

  // Activity label — narrative across every meaningful state. The user's
  // "looks stale" complaint was rooted in the prior single-string fallback;
  // the order below is the priority cascade. Each branch hand-holds the
  // user through a different waiting state so no >5s window is silent.
  const now = Date.now();
  const runningTool = pendingToolCalls.find((c) => c.status === 'running');
  const transitioning = agentLiveness?.chunkTransitioning === true;
  const lastTextDeltaAt = agentLiveness?.lastTextDeltaAt ?? null;
  const lastTurnStartAt = agentLiveness?.lastTurnStartAt ?? null;
  const lastEventAt = agentLiveness?.lastEventAt ?? null;

  // First-event-not-yet-fired window for refinements. The agent reads
  // the prior design before doing anything; surface that as "Reading existing
  // design…" instead of the generic "Working…" so the user knows the model
  // has the prior context.
  const noEventsYet = lastEventAt === null;

  // D3 — when no specific tool is running yet, show the active todo label
  // in the activity line so the user always sees what step the run is on.
  // The agent often goes 5-30 s between tool calls (LLM round-trip) and
  // the prior copy ("Waiting for model first token…") didn't tell the
  // user *which step* — useful because the agent's published checklist
  // is the source of truth for "what's being attempted right now".
  const activeTodoIdx = todos.findIndex((it) => !it.done);
  const activeTodoLabel =
    activeTodoIdx >= 0 ? truncateLabel(todos[activeTodoIdx]?.text ?? '') : null;

  let activity: string;
  if (transitioning && isChunked) {
    activity = `Transitioning to chunk ${chunkProgress.chunkIndex}…`;
  } else if (runningTool) {
    activity = `${runningTool.verbGroup ?? 'Working'} · ${runningTool.toolName}`;
  } else if (lastTextDeltaAt !== null && now - lastTextDeltaAt < 4_000) {
    activity = 'Streaming response…';
  } else if (lastTurnStartAt !== null && now - lastTurnStartAt < 30_000) {
    const sinceTurn = Math.floor((now - lastTurnStartAt) / 1000);
    activity = activeTodoLabel
      ? `Working on: ${activeTodoLabel} · ${sinceTurn}s`
      : `Waiting for model first token… (${sinceTurn}s)`;
  } else if (lastEventAt !== null) {
    const sinceEvent = Math.floor((now - lastEventAt) / 1000);
    activity = activeTodoLabel
      ? `Working on: ${activeTodoLabel} · quiet ${sinceEvent}s`
      : `Quiet for ${sinceEvent}s — model still composing…`;
  } else if (isRefinement && noEventsYet) {
    activity = 'Reading existing design…';
  } else {
    activity = activeTodoLabel ? `Working on: ${activeTodoLabel}` : 'Working…';
  }

  // Show the spinner whenever we don't have a fresh text_delta (a stream
  // landed within the last 2s). Proves liveness even during long generations.
  const showSpinner = !(lastTextDeltaAt !== null && now - lastTextDeltaAt < 2_000);

  const doneCount = todos.filter((it) => it.done).length;

  // Surface the turn count once a run is past the "definitely not stuck"
  // threshold. The 2026-04-29 trace ran 30 turns / 6m40s; without a count
  // the user sees "Working…" forever and assumes the run hung. Threshold
  // chosen so short refinements don't get noisy "(turn 3)" badges.
  const TURN_COUNT_THRESHOLD = 10;
  const turnCount = agentLiveness?.turnCount ?? 0;
  const showTurnCount = turnCount >= TURN_COUNT_THRESHOLD;

  // Surface a per-run failure tally once the agent has retried 3+ times.
  // Most healthy runs have 0-2 failures total; 3+ signals thrashing (cap
  // violations, drift loops). The 2026-04-29 mokhzyr8 trace hit 9 failures
  // in 57 turns — the user had no mid-run signal that the run was unhealthy.
  const RUN_FAILURE_THRESHOLD = 3;
  const runFailureCount = agentLiveness?.runFailureCount ?? 0;
  const showRunFailures = runFailureCount >= RUN_FAILURE_THRESHOLD;

  return (
    <div
      className="sticky top-0 z-10 -mx-[var(--space-4)] -mt-[var(--space-4)] mb-[var(--space-3)] bg-[var(--color-background-secondary)]/95 backdrop-blur border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-2)] text-[var(--text-xs)]"
      aria-live="polite"
    >
      <div className="flex items-center gap-[var(--space-3)]">
        {isChunked ? (
          <span className="font-medium text-[var(--color-text-primary)] shrink-0">
            Chunk {chunkProgress.chunkIndex} / {chunkProgress.chunkCap}
          </span>
        ) : null}
        {isRefinement ? (
          <span
            className="flex items-center gap-[3px] shrink-0 text-[var(--color-accent)]"
            aria-label="Refining existing design"
            title="Agent is iterating on the existing design — prior context loaded"
          >
            <Sparkles className="w-[12px] h-[12px]" aria-hidden />
            <span className="font-medium">Refining</span>
          </span>
        ) : null}
        <span className="font-medium text-[var(--color-text-primary)] truncate flex-1">
          {activity}
          {showTurnCount ? (
            <span
              className="ml-[var(--space-2)] font-normal text-[var(--color-text-muted)] tabular-nums"
              aria-label={`Turn ${turnCount}`}
              title="Number of model turns in this run"
            >
              · turn {turnCount}
            </span>
          ) : null}
          {showRunFailures ? (
            <span
              className="ml-[var(--space-2)] inline-flex items-center gap-[3px] rounded-full bg-[var(--color-warning)]/15 px-[var(--space-1)] font-medium tabular-nums text-[var(--color-warning)]"
              aria-label={`${runFailureCount} tool retries this run`}
              title="Tools have failed and been retried this many times. High counts often indicate the agent is thrashing on cap violations or drift."
            >
              {runFailureCount} {runFailureCount === 1 ? 'retry' : 'retries'}
            </span>
          ) : null}
        </span>
        {showSpinner ? (
          <span className="flex items-center gap-[3px] shrink-0" aria-label="Agent is working">
            <span className="codesign-stream-dot" />
            <span className="codesign-stream-dot" style={{ animationDelay: '150ms' }} />
            <span className="codesign-stream-dot" style={{ animationDelay: '300ms' }} />
          </span>
        ) : null}
      </div>
      {todos.length > 0
        ? (() => {
            // First unchecked item = active. -1 if everything is done.
            const activeIdx = todos.findIndex((it) => !it.done);
            const { visible, hiddenBefore, hiddenAfter } = pickVisibleTodos(
              todos,
              activeIdx === -1 ? todos.length - 1 : activeIdx,
            );
            return (
              <div className="mt-[var(--space-2)]">
                <div className="text-[var(--color-text-muted)] tabular-nums mb-[var(--space-1)]">
                  {doneCount} / {todos.length} todos
                </div>
                {hiddenBefore > 0 ? (
                  <div className="text-[var(--color-text-muted)] italic pl-[18px]">
                    +{hiddenBefore} earlier
                  </div>
                ) : null}
                <ul className="space-y-[2px]">
                  {visible.map(({ todo, index }) => {
                    const isActive = index === activeIdx;
                    return (
                      <li
                        key={`${index}-${todo.text}`}
                        className={
                          isActive
                            ? 'flex items-center gap-[6px] rounded-sm bg-[var(--color-accent)]/10 px-[6px] py-[2px] -mx-[6px] ring-1 ring-[var(--color-accent)]/30'
                            : 'flex items-center gap-[6px] px-[6px] py-[2px] -mx-[6px]'
                        }
                        aria-current={isActive ? 'step' : undefined}
                      >
                        {todo.done ? (
                          <Check
                            className="w-[12px] h-[12px] shrink-0 text-[var(--color-accent)]"
                            aria-hidden="true"
                          />
                        ) : (
                          <Circle
                            className={
                              isActive
                                ? 'w-[12px] h-[12px] shrink-0 text-[var(--color-accent)]'
                                : 'w-[12px] h-[12px] shrink-0 text-[var(--color-text-muted)]'
                            }
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className={
                            todo.done
                              ? 'truncate text-[var(--color-text-muted)] line-through'
                              : isActive
                                ? 'truncate text-[var(--color-text-primary)] font-medium'
                                : 'truncate text-[var(--color-text-primary)]'
                          }
                          title={todo.text}
                        >
                          {truncateLabel(todo.text)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {hiddenAfter > 0 ? (
                  <div className="text-[var(--color-text-muted)] italic pl-[18px]">
                    +{hiddenAfter} more
                  </div>
                ) : null}
              </div>
            );
          })()
        : null}
      {/* Auto-resuming pill: stays visible across the entire transition
          (chunk_end → next chunk_start → first turn_start) so the user
          gets continuous reassurance during the long inter-chunk wait.
          The previous gate (lastChunkInterrupted === true) cleared the
          moment chunk_start fired, hiding the pill exactly when the user
          needed it most. Now we read chunkTransitioning instead. */}
      {isChunked && transitioning && chunkProgress.lastChunkInterrupted === true ? (
        <div className="mt-[var(--space-1_5)] text-[var(--color-text-muted)] italic">
          Auto-resuming next chunk…
        </div>
      ) : null}
    </div>
  );
}
