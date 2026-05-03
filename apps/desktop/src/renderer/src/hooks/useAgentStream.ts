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

import { useEffect, useRef } from 'react';
import type { AgentStreamEvent } from '../../../preload/index';
import { useCodesignStore } from '../store';

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
      tickLiveness({
        lastTurnStartAt: Date.now(),
        chunkTransitioning: false,
        turnCount: nextTurnCount,
        turnCountGenerationId: event.generationId,
      });
    };

    const handleTextDelta = (event: AgentStreamEvent) => {
      if (!inFlight.current || typeof event.delta !== 'string') return;
      inFlight.current.textBuffer += event.delta;
      // Once the model emits real assistant text, the thinking summary is
      // no longer informative — clear it so the chat shows the answer, not
      // both at once.
      if (inFlight.current.thinkingBuffer.length > 0) {
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
      inFlight.current.thinkingBuffer += event.delta;
      setStreamingThinking({
        designId: inFlight.current.designId,
        text: inFlight.current.thinkingBuffer,
      });
      tickLiveness({ lastTextDeltaAt: Date.now() });
    };

    const handleThinkingEnd = () => {
      // Keep the buffer visible until the first text_delta or tool_call_start
      // of the same turn — that's when the panel naturally fades out and is
      // replaced by either the answer or the tool stream. Clearing here would
      // flicker the panel off briefly between thinking_end and the next
      // visible event.
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
      // reasoning is no longer the active narrative.
      if (!inFlight.current) return;
      if (inFlight.current.thinkingBuffer.length > 0) {
        inFlight.current.thinkingBuffer = '';
        setStreamingThinking(null);
      }
      const toolName = event.toolName ?? '';
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
      // card takes over.
      if (current && current.thinkingBuffer.length > 0) {
        current.thinkingBuffer = '';
        setStreamingThinking(null);
      }
      setStreamingToolDraft(null);
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
      if (event.isFailure === true) {
        const cur = useCodesignStore.getState().agentLiveness;
        const sameGen = cur?.runFailureGenerationId === event.generationId;
        const nextCount = sameGen ? (cur?.runFailureCount ?? 0) + 1 : 1;
        tickLiveness({
          runFailureCount: nextCount,
          runFailureGenerationId: event.generationId,
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
      // Defensive: clear generation flags. The sendPrompt Promise resolution
      // would normally clear them shortly after, but if the main-process IPC
      // hangs for any reason the UI would be stuck in "running" forever.
      // Mirror the happy-path terminal state here as a belt-and-suspenders.
      const s = useCodesignStore.getState();
      if (s.generatingDesignId === event.designId) {
        useCodesignStore.setState({
          isGenerating: false,
          generatingDesignId: null,
          generationStage: 'done',
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
        case 'fs_updated':
          handleFsUpdated(event);
          return;
        case 'agent_end':
          handleAgentEnd(event);
          return;
        case 'heartbeat':
          handleHeartbeat(event);
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
