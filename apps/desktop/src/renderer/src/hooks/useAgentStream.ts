/**
 * Listens for agent:event:v1 IPC events and fans them into the store.
 *
 * Text deltas are buffered into `streamingAssistantText` so the sidebar
 * chat renders an ephemeral bubble that grows as the model streams.
 * On turn_end the bubble is cleared — `appendChatMessage` persists the
 * final assistant_text row which then replaces the transient view.
 *
 * Tool events are persisted as tool_call chat rows at start time with
 * status='running'; tool_call_result then patches the row to 'done' / 'error'
 * via `chat:update-tool-status:v1`. turn_end is a defensive backstop that
 * marks any still-pending row as 'done' so the WorkingCard never sticks.
 */

import type { ChatReasoningSummaryPayload } from '@open-codesign/shared';
import { useEffect, useRef } from 'react';
import type { AgentStreamEvent } from '../../../preload/index';
import { useCodesignStore } from '../store';

/** Plan 2026-05-08 P3 — pure builder for the `reasoning_summary` chat row
 *  payload. Extracted from `rollupThinkingIfPending` so the payload shape
 *  can be unit-tested without standing up a React hook + IPC stream.
 *
 *  Contract: durationMs is clamped at 0 (clock skew can produce negatives
 *  on resume after sleep); tokenEstimate is `chars/4` rounded up (Claude's
 *  rough English ratio); finalisedAt is the ISO timestamp of `now`. The
 *  toolName is omitted entirely when not provided rather than written as
 *  an empty string — the renderer's pill formatter relies on the field
 *  being absent to suppress the trailing tool tag. */
export function buildReasoningSummaryPayload(
  fullText: string,
  thinkingStartedAt: number,
  now: number,
  toolName?: string,
): ChatReasoningSummaryPayload {
  const durationMs = Math.max(0, now - thinkingStartedAt);
  const tokenEstimate = Math.ceil(fullText.length / 4);
  return {
    fullText,
    durationMs,
    tokenEstimate,
    ...(toolName && toolName.length > 0 ? { toolName } : {}),
    finalisedAt: new Date(now).toISOString(),
  };
}

interface PendingPersist {
  /** Resolves to the persisted row's seq, or null if the append failed. */
  seqPromise: Promise<number | null>;
  toolName: string;
  toolCallId: string | undefined;
  resolved: boolean;
}

interface InFlightTurn {
  designId: string;
  /** Matches the generationId from agent:event:v1 — guaranteed non-empty since
   *  AgentStreamEvent.generationId is required as of schema v1. */
  generationId: string;
  textBuffer: string;
  /** Per-turn buffer for Claude's summarized reasoning. Reset on every
   *  turn_start (thinking is per-turn, not per-run). Cleared on the
   *  first text_delta or tool_call_start of the same turn so the chat
   *  doesn't show two streams at once. */
  thinkingBuffer: string;
  /** Phase 2 — wall-clock the thinking burst started so we can persist
   *  durationMs in the reasoning_summary chat row. Set on the first
   *  thinking_delta of the turn; reset whenever thinkingBuffer is cleared. */
  thinkingStartedAt: number | null;
  /** Phase 2 — set true once the rollup for the current thinking burst
   *  has been persisted as a reasoning_summary row, so we don't double-
   *  write when both thinking_end and tool_draft_start fire. */
  thinkingRolledUp: boolean;
  /** Final assistant text persisted on the previous turn_end of this run.
   *  pi-agent-core can re-emit the same trailing assistant prose across
   *  consecutive turns (e.g. tool turn → wrap-up turn that repeats the
   *  summary); we keep one copy. */
  lastPersistedText: string | null;
  /** Tool calls persisted as 'running' but whose result event hasn't
   *  arrived yet. Drained at tool_call_result and any leftovers are flipped
   *  to 'done' at turn_end. */
  pendingTools: PendingPersist[];
  /** Byte size of `previewHtml` at the first turn_start of this run.
   *  Used at agent_end to compute the delta shown in the
   *  "Preview updated · +N KB" pill so the user has a visible cue when
   *  a long refactor lands sections off-screen. Captured once per run;
   *  preserved across same-run turn_starts. */
  baselineBytes: number;
}

export function useAgentStream(): void {
  const appendChatMessage = useCodesignStore((s) => s.appendChatMessage);
  const setStreamingAssistantText = useCodesignStore((s) => s.setStreamingAssistantText);
  const setStreamingThinking = useCodesignStore((s) => s.setStreamingThinking);
  const setStreamingToolDraft = useCodesignStore((s) => s.setStreamingToolDraft);
  const setPreviewUpdatedAt = useCodesignStore((s) => s.setPreviewUpdatedAt);
  const setPreviewHtmlFromAgent = useCodesignStore((s) => s.setPreviewHtmlFromAgent);
  const updateChatToolStatus = useCodesignStore((s) => s.updateChatToolStatus);
  const persistAgentRunSnapshot = useCodesignStore((s) => s.persistAgentRunSnapshot);
  const setEditCursor = useCodesignStore((s) => s.setEditCursor);
  const inFlight = useRef<InFlightTurn | null>(null);

  // Throttled live-preview push. iframe srcdoc reloads the whole page on every
  // change, so a flurry of str_replace events (10+ per turn is normal) would
  // strobe. Coalesce to ~250ms with a guaranteed trailing edge so the final
  // state always lands.
  const fsThrottle = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: { designId: string; content: string } | null;
    lastFlushAt: number;
  }>({ timer: null, pending: null, lastFlushAt: 0 });
  const FS_THROTTLE_MS = 250;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.codesign) return;
    const flushFs = () => {
      const slot = fsThrottle.current;
      slot.timer = null;
      const pending = slot.pending;
      slot.pending = null;
      if (!pending) return;
      slot.lastFlushAt = Date.now();
      setPreviewHtmlFromAgent(pending);
    };
    const scheduleFs = (next: { designId: string; content: string }) => {
      const slot = fsThrottle.current;
      slot.pending = next;
      const since = Date.now() - slot.lastFlushAt;
      if (since >= FS_THROTTLE_MS && slot.timer === null) {
        // Cold path: flush immediately, then a future event will land within
        // the throttle window and be coalesced.
        flushFs();
        return;
      }
      if (slot.timer !== null) return;
      slot.timer = setTimeout(flushFs, Math.max(FS_THROTTLE_MS - since, 0));
    };

    /** Merge a patch into the agentLiveness slice (always bumps
     *  lastEventAt). If the slice is null, initializes it with sensible
     *  defaults. Centralizes the per-event "still alive" bookkeeping so
     *  the chat status header can render a non-stale narrative. */
    const tickLiveness = (
      patch: Partial<{
        lastTextDeltaAt: number;
        lastTurnStartAt: number;
        chunkTransitioning: boolean;
        turnCount: number;
        turnCountGenerationId: string | null;
        runFailureCount: number;
        runFailureGenerationId: string | null;
        // Improver1 §10 — health metric fields. Patches override; the
        // reducer falls back to the prior value otherwise so the
        // common case (just bumping lastEventAt) doesn't reset state.
        runToolCount: number;
        recentTurns: Array<{ tools: number; edits: number; failures: number }>;
        currentTurnTools: number;
        currentTurnEdits: number;
        currentTurnFailures: number;
      }> = {},
    ) => {
      const now = Date.now();
      const cur = useCodesignStore.getState().agentLiveness;
      useCodesignStore.setState({
        agentLiveness: {
          lastEventAt: now,
          lastTextDeltaAt: patch.lastTextDeltaAt ?? cur?.lastTextDeltaAt ?? null,
          lastTurnStartAt: patch.lastTurnStartAt ?? cur?.lastTurnStartAt ?? null,
          chunkTransitioning: patch.chunkTransitioning ?? cur?.chunkTransitioning ?? false,
          turnCount: patch.turnCount ?? cur?.turnCount ?? 0,
          turnCountGenerationId:
            patch.turnCountGenerationId !== undefined
              ? patch.turnCountGenerationId
              : (cur?.turnCountGenerationId ?? null),
          runFailureCount: patch.runFailureCount ?? cur?.runFailureCount ?? 0,
          runFailureGenerationId:
            patch.runFailureGenerationId !== undefined
              ? patch.runFailureGenerationId
              : (cur?.runFailureGenerationId ?? null),
          runToolCount: patch.runToolCount ?? cur?.runToolCount ?? 0,
          recentTurns: patch.recentTurns ?? cur?.recentTurns ?? [],
          currentTurnTools: patch.currentTurnTools ?? cur?.currentTurnTools ?? 0,
          currentTurnEdits: patch.currentTurnEdits ?? cur?.currentTurnEdits ?? 0,
          currentTurnFailures: patch.currentTurnFailures ?? cur?.currentTurnFailures ?? 0,
        },
      });
    };

    const handleChunkStart = (event: AgentStreamEvent) => {
      if (typeof event.chunkIndex !== 'number' || typeof event.chunkBudgetMs !== 'number') {
        return;
      }
      useCodesignStore.setState({
        chunkProgress: {
          designId: event.designId,
          generationId: event.generationId,
          chunkIndex: event.chunkIndex,
          chunkCap: event.chunkCap ?? event.chunkIndex,
          chunkBudgetMs: event.chunkBudgetMs,
          chunkStartedAt: Date.now(),
          lastChunkInterrupted: null,
        },
      });
      // Stay in transition until the chunk's first turn_start fires —
      // that's when the model has actually begun a turn (not just when
      // the IPC handler signaled the chunk is about to be sent).
      tickLiveness({ chunkTransitioning: true });
    };

    const handleChunkEnd = (event: AgentStreamEvent) => {
      const cp = useCodesignStore.getState().chunkProgress;
      // Only patch if the event matches our current run; ignore stragglers
      // from a prior cancelled run that were in flight when we started a new one.
      if (!cp || cp.generationId !== event.generationId) return;
      useCodesignStore.setState({
        chunkProgress: {
          ...cp,
          lastChunkInterrupted: event.chunkInterrupted ?? null,
        },
      });
      // Between chunk_end and the next chunk_start the IPC layer is
      // settling deferred-abort + re-arming the timeout + reloading
      // history from DB — no events fire for 30-90s. Keep the header
      // narrating "transitioning" so it doesn't read as stale.
      tickLiveness({ chunkTransitioning: true });
    };

    const handleTurnStart = (event: AgentStreamEvent) => {
      // TODO: replace with rendererLogger once renderer-logger lands
      console.debug('[agent] turn_start', {
        generationId: event.generationId,
        designId: event.designId,
      });
      const previous = inFlight.current;
      const sameRun =
        previous &&
        previous.designId === event.designId &&
        previous.generationId === event.generationId;
      // Snapshot the current previewHtml byte size at the first turn_start
      // of a fresh run so we can show "Preview updated · +N KB" at agent_end.
      // Same-run turn_starts (chunk transitions) preserve the original
      // baseline so the delta reflects the entire run, not the last chunk.
      const baselineBytes = sameRun
        ? previous.baselineBytes
        : (useCodesignStore.getState().previewHtml ?? '').length;
      inFlight.current = {
        designId: event.designId,
        generationId: event.generationId,
        textBuffer: '',
        thinkingBuffer: '',
        thinkingStartedAt: null,
        thinkingRolledUp: false,
        lastPersistedText: sameRun ? previous.lastPersistedText : null,
        pendingTools: sameRun ? previous.pendingTools : [],
        baselineBytes,
      };
      setStreamingAssistantText({ designId: event.designId, text: '' });
      setStreamingThinking(null);
      setStreamingToolDraft(null);
      // The model has begun a turn — explicitly clear the chunk-transition
      // flag so the header switches from "Transitioning…" to "Waiting for
      // first token…".
      // Increment the turn counter so long runs can surface "turn N" in the
      // header. Reset to 1 on a fresh generationId; same-run starts (chunk
      // transitions inside one generate call) accumulate.
      const prevLiveness = useCodesignStore.getState().agentLiveness;
      const sameGen = prevLiveness?.turnCountGenerationId === event.generationId;
      const nextTurnCount = sameGen ? (prevLiveness?.turnCount ?? 0) + 1 : 1;
      // Improver1 §10 — health metrics. On a fresh run reset rolling
      // buffers + counters; on same-run starts the per-turn
      // accumulators are zeroed (they fold into recentTurns at the
      // turn_end of the PRIOR turn, see handleTurnEnd below).
      tickLiveness({
        lastTurnStartAt: Date.now(),
        chunkTransitioning: false,
        turnCount: nextTurnCount,
        turnCountGenerationId: event.generationId,
        ...(sameGen
          ? {
              currentTurnTools: 0,
              currentTurnEdits: 0,
              currentTurnFailures: 0,
            }
          : {
              runToolCount: 0,
              recentTurns: [],
              currentTurnTools: 0,
              currentTurnEdits: 0,
              currentTurnFailures: 0,
            }),
      });
    };

    /** Phase 2 — persist a `reasoning_summary` chat row. Called when a
     *  thinking burst transitions to either a tool draft, a tool call, an
     *  assistant_text delta, or the agent finishes — whichever fires first
     *  after thinking content has been collected. The pill survives reload
     *  without dominating the chat viewport.
     *
     *  No-op when the buffer is empty or the burst already rolled up. */
    const rollupThinkingIfPending = (toolName?: string): void => {
      const cur = inFlight.current;
      if (!cur) return;
      if (cur.thinkingRolledUp) return;
      const fullText = cur.thinkingBuffer;
      if (fullText.length === 0) return;
      const startedAt = cur.thinkingStartedAt ?? Date.now();
      const now = Date.now();
      const payload = buildReasoningSummaryPayload(fullText, startedAt, now, toolName);
      cur.thinkingRolledUp = true;
      // 2026-05-07 — log the rollup attempt + any failure so the next
      // "no reasoning_summary rows in DB" investigation can pinpoint
      // whether the model is silent or the writer is silently failing.
      // TODO: replace with rendererLogger once renderer-logger lands
      console.debug('[agent] reasoning_summary.rollup', {
        designId: cur.designId,
        generationId: cur.generationId,
        chars: fullText.length,
        durationMs: payload.durationMs,
        tokenEstimate: payload.tokenEstimate,
        ...(toolName ? { toolName } : {}),
      });
      appendChatMessage({
        designId: cur.designId,
        kind: 'reasoning_summary',
        payload,
      }).catch((err) => {
        // TODO: replace with rendererLogger once renderer-logger lands
        console.error('[agent] reasoning_summary.persist.fail', {
          designId: cur.designId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    };

    const handleTextDelta = (event: AgentStreamEvent) => {
      if (!inFlight.current || typeof event.delta !== 'string') return;
      inFlight.current.textBuffer += event.delta;
      // Once the model emits real assistant text, the thinking summary is
      // no longer informative — clear it so the chat shows the answer, not
      // both at once. Phase 2: roll the buffer up into a persisted
      // reasoning_summary row first so the reasoning isn't lost on reload.
      if (inFlight.current.thinkingBuffer.length > 0) {
        rollupThinkingIfPending();
        inFlight.current.thinkingBuffer = '';
        setStreamingThinking(null);
      }
      setStreamingAssistantText({
        designId: inFlight.current.designId,
        text: inFlight.current.textBuffer,
      });
      tickLiveness({ lastTextDeltaAt: Date.now() });
    };

    const handleThinkingDelta = (event: AgentStreamEvent) => {
      if (!inFlight.current || typeof event.delta !== 'string') return;
      // Phase 2 — record the wall-clock start of the burst on the first
      // delta so the rollup row carries an accurate durationMs. Reset
      // thinkingRolledUp so a fresh burst (post-tool, mid-turn) earns its
      // own pill instead of bouncing off the prior burst's flag.
      if (inFlight.current.thinkingBuffer.length === 0) {
        inFlight.current.thinkingStartedAt = Date.now();
        inFlight.current.thinkingRolledUp = false;
      }
      inFlight.current.thinkingBuffer += event.delta;
      setStreamingThinking({
        designId: inFlight.current.designId,
        text: inFlight.current.thinkingBuffer,
      });
      tickLiveness({ lastTextDeltaAt: Date.now() });
    };

    const handleThinkingEnd = () => {
      // Phase 2 — thinking_end fires when the model ends a thinking block
      // but BEFORE the next assistant_text or tool_call_start lands. We do
      // NOT clear the buffer here (that'd flicker the panel) — but we DO
      // capture a rollup so a reload mid-pause survives. The rollup is
      // idempotent so a later transition (text_delta / tool_draft_start)
      // is a no-op.
      rollupThinkingIfPending();
    };

    const handleHeartbeat = (event: AgentStreamEvent) => {
      // plan0305 P2.4 — main process emits a heartbeat when no other event
      // has fired for ≥5s. Surface it as a soft "still thinking… mm:ss"
      // line in the thoughts panel so the long extended-thinking gaps that
      // showed up in run traces (14 min in run 1 turn 3) read as activity
      // rather than a frozen run. We only synthesise a placeholder when the
      // model has not produced its own thinking content for this turn —
      // otherwise the real reasoning text wins and we just keep liveness
      // ticking.
      if (!inFlight.current) return;
      const sinceMs = typeof event.sinceMs === 'number' ? event.sinceMs : 0;
      tickLiveness({ lastTextDeltaAt: Date.now() });
      if (inFlight.current.thinkingBuffer.length > 0) return;
      const totalSec = Math.floor(sinceMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      const padded = `${m}:${s.toString().padStart(2, '0')}`;
      setStreamingThinking({
        designId: inFlight.current.designId,
        text: `Still working — last update ${padded} ago`,
      });
    };

    const handleToolDraftStart = (event: AgentStreamEvent) => {
      // The model has begun streaming a tool call's args. Open the
      // "drafting" indicator so the user sees activity in the otherwise-
      // silent gap between thinking_end and the runtime's tool_call_start
      // (1–3 s window). The thinking panel is also explicitly cleared
      // here — once the model has committed to a tool, the previous
      // reasoning is no longer the active narrative. Phase 2: roll the
      // thinking buffer up into a persisted reasoning_summary row first,
      // tagged with the upcoming tool name, so the chat keeps the trace
      // even after the live panel clears.
      if (!inFlight.current) return;
      const toolName = event.toolName ?? '';
      if (inFlight.current.thinkingBuffer.length > 0) {
        rollupThinkingIfPending(toolName.length > 0 ? toolName : undefined);
        inFlight.current.thinkingBuffer = '';
        setStreamingThinking(null);
      }
      const toolCallId = event.toolCallId ?? '';
      if (toolName.length === 0) return;
      setStreamingToolDraft({
        designId: event.designId,
        toolName,
        toolCallId,
        bytes: 0,
      });
    };

    const handleToolDraftDelta = (event: AgentStreamEvent) => {
      // Each delta extends the in-progress JSON args. We don't try to
      // parse the partial JSON; just bump the byte counter so the
      // "drafting" UI can show progress (e.g. a thin growing bar or a
      // truncated character count).
      if (!inFlight.current) return;
      const designId = inFlight.current.designId;
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (delta.length === 0) return;
      const cur = useCodesignStore.getState().streamingToolDraft;
      if (cur === null || cur.designId !== designId) return;
      setStreamingToolDraft({ ...cur, bytes: cur.bytes + delta.length });
      tickLiveness({ lastTextDeltaAt: Date.now() });
    };

    const drainPendingTools = (current: InFlightTurn, finalStatus: 'done' | 'error'): void => {
      const designId = current.designId;
      const stragglers = current.pendingTools.filter((p) => !p.resolved);
      current.pendingTools = current.pendingTools.filter((p) => p.resolved);
      for (const p of stragglers) {
        p.resolved = true;
        void p.seqPromise.then((seq) => {
          if (seq === null) return;
          void updateChatToolStatus({ designId, seq, status: finalStatus });
        });
      }
    };

    const handleTurnEnd = (event: AgentStreamEvent) => {
      const current = inFlight.current;
      // TODO: replace with rendererLogger once renderer-logger lands
      console.debug('[agent] turn_end', {
        generationId: event.generationId,
        designId: event.designId,
        textLen: (event.finalText ?? current?.textBuffer ?? '').length,
      });
      // Phase 2 — orphan thinking buffer can survive past turn_end if no
      // text/tool transition fired (rare, but happens on turns where the
      // model emits thinking → done without an intermediate tool draft).
      // Persist the rollup before we lose the buffer.
      rollupThinkingIfPending();
      const finalText = event.finalText ?? current?.textBuffer ?? '';
      const trimmed = finalText.trim();
      if (current && trimmed.length > 0 && trimmed !== current.lastPersistedText?.trim()) {
        void appendChatMessage({
          designId: current.designId,
          kind: 'assistant_text',
          payload: { text: finalText },
        });
        current.lastPersistedText = finalText;
      }
      if (current) drainPendingTools(current, 'done');
      setStreamingAssistantText(null);
      if (current) current.textBuffer = '';
      // Improver1 §10 — fold the just-completed turn's per-turn
      // accumulators into the rolling buffer. The buffer holds the
      // last HEALTH_LOOKBACK turns so the header can compute
      // edits-per-turn / failure-rate without scanning chat_messages.
      const HEALTH_LOOKBACK = 10;
      const prev = useCodesignStore.getState().agentLiveness;
      if (prev) {
        const completed = {
          tools: prev.currentTurnTools,
          edits: prev.currentTurnEdits,
          failures: prev.currentTurnFailures,
        };
        const nextBuffer = [...prev.recentTurns, completed];
        while (nextBuffer.length > HEALTH_LOOKBACK) nextBuffer.shift();
        tickLiveness({
          recentTurns: nextBuffer,
          // Don't reset current* here — handleTurnStart resets on the
          // next turn so events between turns (heartbeat, fs_updated)
          // don't double-count.
        });
      }
    };

    const handleToolCallStart = (event: AgentStreamEvent) => {
      const current = inFlight.current;
      const designId = event.designId;
      const toolName = event.toolName ?? 'unknown';
      // The thinking panel exists to bridge the silent "model is reasoning"
      // gap. Once the model commits to a tool, the next visible signal is
      // the tool card itself — clear the thinking stream so the chat
      // doesn't show two competing live indicators. Same logic for the
      // drafting-tool indicator, which fades the moment the real tool
      // card takes over. Phase 2: persist the rollup before clearing.
      if (current && current.thinkingBuffer.length > 0) {
        rollupThinkingIfPending(toolName !== 'unknown' ? toolName : undefined);
        current.thinkingBuffer = '';
        setStreamingThinking(null);
      }
      setStreamingToolDraft(null);
      // Improver1 §10 — health metrics. Bump per-turn tool count + run
      // tool count. Distinguish edit-class tools (str_replace / patch /
      // insert / create) from inspection tools so the edits-per-turn
      // signal differentiates "agent is making progress" vs "agent is
      // re-reading endlessly".
      const prevHealth = useCodesignStore.getState().agentLiveness;
      const isEditTool =
        toolName === 'str_replace_based_edit_tool' &&
        (event.command === 'str_replace' ||
          event.command === 'patch' ||
          event.command === 'insert' ||
          event.command === 'create');
      tickLiveness({
        runToolCount: (prevHealth?.runToolCount ?? 0) + 1,
        currentTurnTools: (prevHealth?.currentTurnTools ?? 0) + 1,
        ...(isEditTool ? { currentTurnEdits: (prevHealth?.currentTurnEdits ?? 0) + 1 } : {}),
      });
      // TODO: replace with rendererLogger once renderer-logger lands
      console.debug('[agent] tool_call_start', {
        generationId: event.generationId,
        designId,
        toolName,
        toolCallId: event.toolCallId,
      });
      // DB row rather than an in-memory shadow. Capture seq via promise so
      // the result handler can patch the same row even if it lands before
      // the append round-trip completes.
      const seqPromise = appendChatMessage({
        designId,
        kind: 'tool_call',
        payload: {
          toolName,
          ...(event.command !== undefined ? { command: event.command } : {}),
          args: event.args ?? {},
          status: 'running',
          startedAt: new Date().toISOString(),
          verbGroup: event.verbGroup ?? 'Working',
          ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
        },
      }).then((row) => row?.seq ?? null);
      if (current) {
        current.pendingTools.push({
          seqPromise,
          toolName,
          toolCallId: event.toolCallId,
          resolved: false,
        });
      }
      tickLiveness();
    };

    const handleToolCallResult = (event: AgentStreamEvent) => {
      const current = inFlight.current;
      const designId = event.designId;
      // Backlog-3 §4 — drain the streaming entry for this toolCallId
      // (whether or not we find a matching pending tool below). This
      // is the closing edge for any tool_result_delta sequence and
      // cleans up state on both success and failure.
      if (event.toolCallId !== undefined) {
        useCodesignStore.getState().patchStreamingToolResult(event.toolCallId, null);
      }
      if (!current) return;
      const idx = current.pendingTools.findIndex(
        (p) =>
          !p.resolved &&
          (event.toolCallId !== undefined && p.toolCallId !== undefined
            ? p.toolCallId === event.toolCallId
            : p.toolName === (event.toolName ?? 'unknown')),
      );
      if (idx < 0) return;
      const pending = current.pendingTools[idx];
      if (!pending) return;
      pending.resolved = true;
      const result = event.result;
      const durationMs = event.durationMs;
      // plan0305 P3.1 — when pi-agent-core flagged the call with isError,
      // persist status='error' instead of 'done' so the chat history shows
      // failed attempts in red and downstream code can distinguish "this
      // tool actually executed" from "this tool was rejected/threw". Pre-
      // plan0305 (chat_messages schema_version=1) rows always wrote 'done'
      // regardless of outcome — see migrateChatMessageRow for the bump.
      const persistedStatus: 'done' | 'error' = event.isFailure === true ? 'error' : 'done';
      void pending.seqPromise.then((seq) => {
        if (seq === null) return;
        void updateChatToolStatus({
          designId,
          seq,
          status: persistedStatus,
          ...(result !== undefined ? { result } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
      });
      // Per-run failure counter — reset on generationId change, increment
      // on each isFailure=true result. Status header reads this to surface
      // "N retries this run" once the count crosses the threshold.
      // Improver1 §10 — also bump per-turn failure count for the
      // health-pill computation.
      if (event.isFailure === true) {
        const cur = useCodesignStore.getState().agentLiveness;
        const sameGen = cur?.runFailureGenerationId === event.generationId;
        const nextCount = sameGen ? (cur?.runFailureCount ?? 0) + 1 : 1;
        tickLiveness({
          runFailureCount: nextCount,
          runFailureGenerationId: event.generationId,
          currentTurnFailures: (cur?.currentTurnFailures ?? 0) + 1,
        });
      } else {
        tickLiveness();
      }

      // Drive the follow-the-edit cursor from str_replace / insert metadata.
      // Scoped to index.html (the JSX entry point) since the source-line
      // tagger only runs on that file's Babel pass; sidecar / skill edits are
      // intentionally silent. PreviewPane reads `editCursor` and forwards
      // HIGHLIGHT_SRC_LINE to the iframe overlay.
      if (
        event.editPath === 'index.html' &&
        typeof event.editStartLine === 'number' &&
        typeof event.editEndLine === 'number'
      ) {
        const label =
          event.editStartLine === event.editEndLine
            ? `Editing line ${event.editStartLine}`
            : `Editing lines ${event.editStartLine}-${event.editEndLine}`;
        setEditCursor({
          toolLabel: label,
          startLine: event.editStartLine,
          endLine: event.editEndLine,
        });
      }
    };

    const handleFsUpdated = (event: AgentStreamEvent) => {
      // Live mirror of the agent's text_editor mutations into the iframe.
      // We only react to index.html — other paths (frames/, skills/) are
      // read-only context and never become the rendered artifact.
      if (event.path === 'index.html' && typeof event.content === 'string') {
        scheduleFs({ designId: event.designId, content: event.content });
      }
    };

    /** v7 — auto-continue checkpoint pauses (wall_clock / output_budget /
     *  context_threshold) when the user has the preference enabled. The
     *  main process emits this event right after persisting the
     *  `continuation_pending` row for one of those reasons. We consult
     *  the persisted preference (read fresh, not cached, so flipping the
     *  toggle takes effect on the next checkpoint without a reload),
     *  then schedule `continueRun` after a short delay so the closing
     *  `agent_end` has cleared `isGenerating`. continueRun itself
     *  short-circuits if `isGenerating` is still true. */
    const handleAutoContinue = (event: AgentStreamEvent) => {
      const api = window.codesign;
      if (!api?.preferences?.get) return;
      void api.preferences
        .get()
        .then((prefs) => {
          if (prefs.autoContinueEnabled !== true) return;
          // Defer so the agent_end handler that follows this event has
          // cleared isGenerating + chunkProgress before continueRun
          // checks them. 600ms is comfortable headroom over the
          // tryAutoPolish 1200ms timer (which would otherwise fire its
          // own follow-up prompt and conflict with us).
          setTimeout(() => {
            const s = useCodesignStore.getState();
            if (s.currentDesignId !== event.designId) return;
            if (s.isGenerating) return;
            void s.continueRun();
          }, 600);
        })
        .catch(() => {
          /* non-fatal — auto-continue is a convenience layer, not a
           *  correctness requirement. The renderer's continuation_pending
           *  card still offers a Continue button. */
        });
    };

    const handleError = (event: AgentStreamEvent) => {
      const current = inFlight.current;
      // TODO: replace with rendererLogger once renderer-logger lands
      console.error('[agent] error', {
        generationId: event.generationId,
        designId: event.designId,
        message: event.message,
        code: event.code,
      });
      setStreamingAssistantText(null);
      inFlight.current = null;
      void appendChatMessage({
        designId: event.designId,
        kind: 'error',
        payload: {
          message: event.message ?? 'Unknown error',
          ...(event.code ? { code: event.code } : {}),
        },
      });
      // Defensive: clear generation flags so the UI never gets stuck showing
      // "running" if the IPC promise that drives sendPrompt hangs. Only clear
      // when the error belongs to the design the store thinks is generating.
      const s = useCodesignStore.getState();
      if (s.generatingDesignId === event.designId) {
        useCodesignStore.setState({
          isGenerating: false,
          generatingDesignId: null,
          generationStage: 'error',
          streamingAssistantText: null,
          streamingThinking: null,
          streamingToolDraft: null,
          chunkProgress: null,
          agentLiveness: null,
        });
      }
    };

    const handleAgentEnd = (event: AgentStreamEvent) => {
      // Phase 2 — final flush for any leftover thinking buffer at the
      // end of a run (rare, but agent_end can land without a preceding
      // text_delta or tool transition).
      rollupThinkingIfPending();
      // Flush any throttled fs_updated payload synchronously so the preview
      // store reflects the final html before we read it back for persistence.
      const slot = fsThrottle.current;
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      const pending = slot.pending;
      slot.pending = null;
      if (pending) {
        slot.lastFlushAt = Date.now();
        setPreviewHtmlFromAgent(pending);
      }
      // Compute the run's net byte delta and emit a "preview updated" event
      // for the UI pill + iframe pulse animation. Without this, a long
      // multi-section refactor produces no perceptible change above the
      // fold (e.g. the drone-portfolio run on 2026-04-28 added 5 sections
      // below the hero — the user saw the same hero and assumed nothing
      // changed). Skip when delta is 0 so chat-only runs (no edits) don't
      // flash the pill.
      const baseline = inFlight.current?.baselineBytes ?? 0;
      const finalBytes = (useCodesignStore.getState().previewHtml ?? '').length;
      const bytesDelta = finalBytes - baseline;
      if (bytesDelta !== 0) {
        setPreviewUpdatedAt({ designId: event.designId, ts: Date.now(), bytesDelta });
      }
      const finalText = inFlight.current?.lastPersistedText ?? undefined;
      void persistAgentRunSnapshot({
        designId: event.designId,
        ...(finalText ? { finalText } : {}),
      });
      inFlight.current = null;
      // Defensive: clear in-flight flags so the spinner stops. We do NOT
      // touch `generationStage` here — that's driven by the sendPrompt
      // Promise's resolve/reject so a no-output run (e.g. extended-thinking
      // burned the whole output budget → IPC rejects with
      // MODEL_RETURNED_ONLY_THINKING) lands as 'error', not a misleading
      // 'done' that races with the upcoming reject. Belt-and-suspenders
      // applies to isGenerating only — generation stage is settled by the
      // IPC layer.
      const s = useCodesignStore.getState();
      if (s.generatingDesignId === event.designId) {
        useCodesignStore.setState({
          isGenerating: false,
          generatingDesignId: null,
          streamingAssistantText: null,
          streamingThinking: null,
          streamingToolDraft: null,
          chunkProgress: null,
          agentLiveness: null,
        });
      }
      // Fire the auto-polish follow-up exactly once per design. Delay so the
      // isGenerating flag and persisted assistant_text row have settled before
      // sendPrompt inspects them. The guard inside tryAutoPolish dedupes.
      const designId = event.designId;
      setTimeout(() => {
        // Locale is read from the i18n module the renderer already initialised.
        // Fall back to 'en' if i18next isn't ready yet (shouldn't happen in
        // practice — agent_end implies the UI has been running for a while).
        let locale = 'en';
        try {
          const i18n = (globalThis as { i18next?: { language?: string } }).i18next;
          if (i18n?.language) locale = i18n.language;
        } catch {
          /* noop */
        }
        useCodesignStore.getState().tryAutoPolish(designId, locale);
      }, 1200);
      // v8 — opportunistic Decompose at the end of a chain. The internal
      // guards in tryAutoDecompose (game-mode only, no
      // continuation_pending row open, hash unchanged → no-op) make this
      // safe to call after every agent_end. We schedule slightly behind
      // tryAutoPolish so the snapshot persistence pipeline has flushed
      // and any auto_continue event has already arrived. Auto-continue
      // chains are skipped naturally: hasFreshContinuationPending
      // returns true while the chain is open.
      setTimeout(() => {
        void useCodesignStore.getState().tryAutoDecompose(designId);
      }, 1500);
      // Backlog-3 §10 — budget threshold check. Fire-and-forget; the
      // toast is informational. We compare today's daily_usage total
      // against the user's saved daily limit and toast at the
      // configured percentage.
      void (async () => {
        const api = window.codesign;
        if (!api?.getBudget || !api.getDailyUsage) return;
        try {
          const [budget, days] = await Promise.all([api.getBudget('global'), api.getDailyUsage(1)]);
          if (!budget || budget.dailyLimitUsd === null || budget.dailyLimitUsd <= 0) return;
          const today = days[0];
          if (!today) return;
          const pct = (today.costUsd / budget.dailyLimitUsd) * 100;
          if (pct >= budget.alertAtPct) {
            useCodesignStore.getState().pushToast({
              variant: pct >= 100 ? 'error' : 'info',
              title: pct >= 100 ? 'Daily budget exceeded' : 'Daily budget threshold',
              description: `Today: $${today.costUsd.toFixed(2)} of $${budget.dailyLimitUsd.toFixed(2)} (${Math.round(pct)}%)`,
            });
          }
        } catch {
          /* non-fatal — budget surfacing must not break agent_end */
        }
      })();
    };

    const off = window.codesign.chat.onAgentEvent((event: AgentStreamEvent) => {
      switch (event.type) {
        case 'chunk_start':
          handleChunkStart(event);
          return;
        case 'chunk_end':
          handleChunkEnd(event);
          return;
        case 'turn_start':
          handleTurnStart(event);
          return;
        case 'text_delta':
          handleTextDelta(event);
          return;
        case 'thinking_delta':
          handleThinkingDelta(event);
          return;
        case 'thinking_end':
          handleThinkingEnd();
          return;
        case 'tool_draft_start':
          handleToolDraftStart(event);
          return;
        case 'tool_draft_delta':
          handleToolDraftDelta(event);
          return;
        case 'turn_end':
          handleTurnEnd(event);
          return;
        case 'tool_call_start':
          handleToolCallStart(event);
          return;
        case 'tool_call_result':
          handleToolCallResult(event);
          return;
        case 'tool_result_delta':
          // Backlog-3 §4 — partial result delta. Accumulate into the
          // streamingToolResults Zustand slice, keyed by toolCallId.
          // The closing `tool_call_result` event drains the entry (see
          // handleToolCallResult below for the drain hook).
          if (event.toolCallId !== undefined) {
            const patch: { byteCount?: number; preview?: string; progressPct?: number } = {};
            if (event.byteCount !== undefined) patch.byteCount = event.byteCount;
            if (event.resultPreview !== undefined) patch.preview = event.resultPreview;
            if (event.progressPct !== undefined) patch.progressPct = event.progressPct;
            useCodesignStore.getState().patchStreamingToolResult(event.toolCallId, patch);
          }
          return;
        case 'fs_updated':
          handleFsUpdated(event);
          return;
        case 'agent_end':
          handleAgentEnd(event);
          return;
        case 'heartbeat':
          handleHeartbeat(event);
          return;
        case 'auto_continue':
          handleAutoContinue(event);
          return;
        case 'error':
          handleError(event);
          return;
      }
    });
    return () => {
      off();
      const slot = fsThrottle.current;
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      slot.pending = null;
    };
  }, [
    appendChatMessage,
    setStreamingAssistantText,
    setStreamingThinking,
    setStreamingToolDraft,
    setPreviewUpdatedAt,
    setPreviewHtmlFromAgent,
    updateChatToolStatus,
    persistAgentRunSnapshot,
    setEditCursor,
  ]);
}
