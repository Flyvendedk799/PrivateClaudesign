import { i18n } from '@open-codesign/i18n';
import type {
  ChatAppendInput,
  ChatMessage,
  ChatMessageRow,
  ChatToolCallPayload,
  CommentKind,
  CommentRect,
  CommentRow,
  CommentScope,
  Design,
  DiagnosticEventRow,
  DiagnosticHypothesis,
  LocalInputFile,
  ModelRef,
  OnboardingState,
  PromptAssistMetadata,
  ReportEventInput,
  ReportEventResult,
  ReportableError,
  SelectedElement,
} from '@open-codesign/shared';
import { diagnoseGenerateFailure, looksLikeTruncatedStream } from '@open-codesign/shared';
import { computeFingerprint } from '@open-codesign/shared/fingerprint';
import { create } from 'zustand';
import type { StoreApi } from 'zustand';
import type { CodesignApi, ExportFormat } from '../../preload/index';
import { recordAction, snapshotTimeline } from './lib/action-timeline';
import {
  type ArtifactPattern,
  PROMPT_COMMAND_HELP,
  detectGameModeFromPrompt,
  parsePromptCommand,
} from './lib/prompt-commands';
import { rendererLogger } from './lib/renderer-logger';

declare global {
  interface Window {
    codesign?: CodesignApi;
  }
}

export type GenerationStage =
  | 'idle'
  | 'sending'
  | 'thinking'
  | 'streaming'
  | 'parsing'
  | 'rendering'
  | 'done'
  | 'error';

export type ToastVariant = 'success' | 'error' | 'info';

/** Cap on the in-memory ReportableError ring. Dropping the oldest entries keeps
 *  the store bounded during long sessions while still covering every recent
 *  user-visible error — the Report dialog only needs whatever is on-screen. */
export const MAX_REPORTABLE = 100;

/**
 * Input to `createReportableError`. Mirrors ReportableError minus the fields
 * the store fills in synchronously (`localId`, `ts`, `fingerprint`,
 * `persistedEventId`, `persistedFingerprint`).
 */
export interface CreateReportableErrorInput {
  code: string;
  scope: string;
  message: string;
  stack?: string;
  runId?: string;
  context?: Record<string, unknown>;
}

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  /**
   * Pointer into `reportableErrors` for the Report button. Set when a
   * ReportableError was constructed alongside this toast (every error toast
   * should have one — see `createReportableError`). Missing for info/success
   * toasts that don't need a Report affordance.
   */
  localId?: string;
  /**
   * Optional secondary action rendered as a button inside the toast. Used
   * to turn diagnostic toasts into actionable ones — e.g. a "no API key"
   * generate error becomes a toast with "Open Settings" that jumps the
   * user to the fix. `onClick` is called before the toast is dismissed.
   */
  action?: {
    label: string;
    onClick: () => void;
  };
}

/**
 * Input to `reportableErrorToast`. Mirrors `Toast` minus the auto-filled
 * fields (id, variant, localId) plus the ReportableError triage fields
 * the store uses to build a richer record than pushToast's auto-wrap.
 */
export interface ReportableErrorToastSpec {
  title: string;
  description?: string;
  action?: Toast['action'];
  code: string;
  scope: string;
  stack?: string;
  runId?: string;
  context?: Record<string, unknown>;
  /**
   * When false, the toast is shown without recording a ReportableError,
   * so the Toast UI does NOT render the "Report" button. Use this for
   * expected user-facing errors (missing config files, declined imports)
   * where prompting the user to file a bug report would just be noise.
   */
  reportable?: boolean;
}

export type Theme = 'light' | 'dark';
export type AppView = 'hub' | 'workspace' | 'settings';
export type SettingsTab =
  | 'models'
  | 'appearance'
  | 'storage'
  | 'diagnostics'
  | 'advanced'
  // Backlog-3 §10 — budget & cost dashboard tab.
  | 'budgets';
export type HubTab = 'recent' | 'your' | 'examples' | 'designSystems' | 'skills';
export type InteractionMode = 'default' | 'comment' | 'skill-extract';

export type PreviewViewport = 'desktop' | 'tablet' | 'mobile';

/** A6.x — game-mode preview aspect presets. Swap in for the
 *  desktop/tablet/mobile triplet on game-mode designs since device
 *  form factors don't map cleanly to game canvases. The renderer
 *  applies these as max-width / max-height constraints on the
 *  iframe wrapper. */
export type GameAspect = '16:9' | '4:3' | '1:1' | '9:16';

/** Pixel dimensions used to size the preview wrapper for each aspect.
 *  Width is always the larger axis except for 9:16 (portrait). The
 *  iframe scales to its parent so these are upper bounds, not fixed
 *  viewports. */
export const GAME_ASPECT_DIMS: Record<GameAspect, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 1024, height: 768 },
  '1:1': { width: 800, height: 800 },
  '9:16': { width: 540, height: 960 },
};

// Workstream G — canvas tabs.
// 'files' is the pinned tab that hosts the file list + inline preview; 'file'
// tabs wrap a single file preview opened by double-clicking the list. Closing
// a 'file' tab is purely UI state — it does NOT delete anything.
export type CanvasTab = { kind: 'files' } | { kind: 'file'; path: string };

export const FILES_TAB: CanvasTab = { kind: 'files' };

// Pure reducers, exported for unit tests so we don't need RTL for slice logic.
export function openFileTab(tabs: CanvasTab[], path: string): { tabs: CanvasTab[]; index: number } {
  const existing = tabs.findIndex((t) => t.kind === 'file' && t.path === path);
  if (existing !== -1) return { tabs, index: existing };
  const next: CanvasTab[] = [...tabs, { kind: 'file', path }];
  return { tabs: next, index: next.length - 1 };
}

export function closeTabAt(
  tabs: CanvasTab[],
  activeIndex: number,
  target: number,
): { tabs: CanvasTab[]; activeIndex: number } {
  const tab = tabs[target];
  if (!tab) return { tabs, activeIndex };
  // The pinned 'files' tab cannot be closed — it always anchors index 0.
  if (tab.kind === 'files') return { tabs, activeIndex };
  const next = tabs.filter((_, i) => i !== target);
  let nextActive = activeIndex;
  if (activeIndex === target) {
    nextActive = Math.max(0, target - 1);
  } else if (activeIndex > target) {
    nextActive = activeIndex - 1;
  }
  return { tabs: next, activeIndex: nextActive };
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Phase 1 — input tokens served from the prompt cache (cache_read).
   *  inputTokens already includes these; this field surfaces the breakdown
   *  so the UI can show a hit ratio. */
  cachedInputTokens: number;
  /** Phase 1 — input tokens written to the prompt cache (cache_creation).
   *  Charged at 1.25× normal input on Anthropic; included in inputTokens. */
  cacheCreationInputTokens: number;
}

interface PromptRequest {
  prompt: string;
  attachments: LocalInputFile[];
  referenceUrl?: string | undefined;
}

interface CodesignState {
  previewHtml: string | null;
  /** LRU cache of `previewHtml` per design id, capped to PREVIEW_POOL_LIMIT.
   *  PreviewPane renders one (display:none) iframe per entry so switching back
   *  to a recently visited design is instant — no IPC, no srcDoc reparse. */
  previewHtmlByDesign: Record<string, string>;
  /** Most-recent-first list of design ids in the preview pool. */
  recentDesignIds: string[];
  isGenerating: boolean;
  activeGenerationId: string | null;
  /** True when the in-flight generation is a follow-up against a design that
   *  already has prior history (i.e. iteration, not first prompt). The chat
   *  header + UserMessage row use this to show a "Refining existing design"
   *  cue so the user knows the agent is aware of prior context. Cleared on
   *  agent_end / error. */
  currentRunIsRefinement: boolean;
  /** Design id that owns the in-flight generation. Lets the user switch to
   *  another design while a generation runs (it stays bound to its origin
   *  design via designIdAtStart) — UI only shows "generating" affordances on
   *  the design that actually has the run. */
  generatingDesignId: string | null;
  generationStage: GenerationStage;
  /** Live assistant text buffered during the current agent turn. Rendered as
   *  an ephemeral chat bubble so the UI shows incremental output instead of
   *  waiting for the turn to settle. Cleared on turn_end (the persisted
   *  chat row takes over). */
  streamingAssistantText: { designId: string; text: string } | null;
  /** Per-turn live thinking buffer (Claude's summarized reasoning). Streams
   *  in real-time during turn 2+ (when thinkingEnabled=true on the agent).
   *  Reset on turn_start; cleared on thinking_end. The chat sidebar shows
   *  this as a faded "Thinking…" panel that updates live so the user can
   *  see the model is working — without it, turns with adaptive thinking
   *  show only a static dot animation for 30–60 s. */
  streamingThinking: { designId: string; text: string } | null;
  /** In-flight tool-call composition. Set when the model emits
   *  `toolcall_start` (the LLM has begun streaming the tool args), updated
   *  on each `toolcall_delta`, cleared when the runtime fires the real
   *  `tool_call_start` (full args ready, tool about to execute). Bridges
   *  the 1–3 s gap between thinking ending and the tool card appearing —
   *  the gap previously read as "the run stalled". The renderer shows a
   *  "drafting" card with the tool icon + animated dots + a byte counter
   *  hinting at the args length. */
  streamingToolDraft: {
    designId: string;
    toolName: string;
    toolCallId: string;
    bytes: number;
  } | null;
  /** Backlog-3 §4 — partial tool results streamed via `tool_result_delta`.
   *  Keyed by toolCallId; each entry carries cumulative bytes, an
   *  optional preview head, and an optional progress % (synthetic for
   *  tools that don't ship bytes incrementally — e.g. image gen).
   *  Cleared per-toolCallId on the closing `tool_call_result`. */
  streamingToolResults: Record<
    string,
    { byteCount?: number; preview?: string; progressPct?: number }
  >;
  /** Wall-clock ms when the preview iframe content most recently changed
   *  via an agent run (set on agent_end if the file delta was non-zero).
   *  Drives the "Preview updated · 12 s ago" pill in PreviewPane and a
   *  brief ring-pulse animation around the active iframe so a structural
   *  rewrite is visually unmissable — without this, after a long
   *  multi-section refactor the user sees the same hero/above-the-fold
   *  view and assumes nothing changed. Cleared by switchDesign /
   *  startNewDesign so each design tracks its own freshness. */
  previewUpdatedAt: { designId: string; ts: number; bytesDelta: number } | null;
  /** Monotonic counter used as a React `key` suffix on the active preview
   *  iframe. Incremented by the manual "Refresh preview" button so React
   *  unmounts and remounts the iframe — guaranteeing the document is
   *  re-parsed from the latest srcdoc even when the underlying html
   *  string didn't change (e.g. iframe got into a stuck state, async
   *  resource hiccup, user wants a clean re-render). */
  previewReloadTick: number;
  /** Live chunk progress emitted by the auto-continue IPC loop. Drives the
   *  ChatStatusHeader pill ("Chunk 2 of 5 · 1:34 elapsed"). Cleared on
   *  agent_end (any path) or when isGenerating goes false. */
  chunkProgress: {
    designId: string;
    generationId: string;
    chunkIndex: number;
    chunkCap: number;
    chunkBudgetMs: number;
    chunkStartedAt: number;
    /** Set when chunk_end fires for this chunk. Drives the header's
     *  "auto-resuming…" label between chunks. */
    lastChunkInterrupted: boolean | null;
  } | null;
  /** Per-event liveness tracker for the chat status header. Updated on
   *  every inbound agent:event:v1 by useAgentStream so the header can
   *  show "Waiting for X…" with elapsed seconds instead of a frozen
   *  "Thinking…" between events. Cleared on agent_end / error.
   *
   *  Fixes the "looks stale" UX problem during the 30-90s chunk
   *  transition window (deferred-abort settle, DB history reload,
   *  fresh AbortController + GENERATION_TIMEOUT, prompt synthesis,
   *  first-token wait) where no events fire and the header would
   *  otherwise freeze on the previous tool's verb. */
  agentLiveness: {
    /** Most recent event of any kind. Used as a "definitely alive" timestamp. */
    lastEventAt: number;
    /** Most recent text_delta — used to detect "Streaming…" state. */
    lastTextDeltaAt: number | null;
    /** Most recent turn_start — used to detect "Waiting for first token…". */
    lastTurnStartAt: number | null;
    /** True between chunk_start and the first turn_start of that chunk,
     *  AND between chunk_end and the next chunk_start. Drives the
     *  "Transitioning between chunks…" narrative. */
    chunkTransitioning: boolean;
    /** Count of turn_start events in the current run (reset when generationId
     *  changes). Surfaced as "· turn N" in the status header once the run
     *  passes a threshold so long iterative runs (the 2026-04-29 trace hit
     *  30 turns / 6m40s) stop reading as "stuck". */
    turnCount: number;
    /** generationId tied to the current turnCount — used to detect a fresh
     *  run and reset the counter. */
    turnCountGenerationId: string | null;
    /** Cumulative count of tool_call_result events with isFailure=true in
     *  the current run. Resets when generationId changes. The status header
     *  surfaces "N retries this run" past a threshold (default 3) so the
     *  user can spot a thrashing run mid-flight, not after the fact. */
    runFailureCount: number;
    /** generationId tied to the runFailureCount — same reset pattern as
     *  turnCountGenerationId. */
    runFailureGenerationId: string | null;
    /** Improver1 §10 — total tool_call_start events in the current run.
     *  Drives the "tools-per-turn" health metric. Resets per-run via
     *  the same generationId guard. */
    runToolCount: number;
    /** Improver1 §10 — rolling buffer of per-turn metrics (last
     *  HEALTH_LOOKBACK = 10 turns). Each entry summarises a single
     *  agent turn so the header can compute edits-per-turn and
     *  failure-rate over the trailing window without re-walking the
     *  full chat_messages list. */
    recentTurns: Array<{
      tools: number;
      edits: number;
      failures: number;
    }>;
    /** In-progress accumulators for the CURRENT (still-running) turn.
     *  Folded into recentTurns + reset on each turn_start. */
    currentTurnTools: number;
    currentTurnEdits: number;
    currentTurnFailures: number;
  } | null;
  lastUsage: UsageSnapshot | null;
  errorMessage: string | null;
  lastError: string | null;
  config: OnboardingState | null;
  configLoaded: boolean;
  toastMessage: string | null;

  designs: Design[];
  currentDesignId: string | null;
  designsLoaded: boolean;
  designsViewOpen: boolean;
  newDesignDialogOpen: boolean;
  designToDelete: Design | null;
  designToRename: Design | null;
  /** gameplan §A6 — mode/engine carried from the New-design dialog into the
   *  next generate request. The dialog writes these on submit; the next
   *  payload construction reads + clears them. Last-picked mode also
   *  persists to preferences.json so the dialog opens to the right tab.
   */
  pendingArtifactMode: 'design' | 'game' | null;
  pendingGameEngine: 'three' | 'phaser' | 'pygame' | 'godot' | null;
  /** A6.x — engine of the currently-loaded design, populated from the
   *  latest snapshot when a design is opened (and from pendingGameEngine
   *  when a fresh game design starts generating). null for design-mode
   *  designs and for design-mode flows. PreviewPane uses this to switch
   *  the iframe to game-files:// resolution; PreviewToolbar shows the
   *  Godot "Build web preview" button when the value === 'godot'. */
  currentDesignEngine: 'three' | 'phaser' | 'pygame' | 'godot' | null;
  /** A6.x — per-design Godot web-preview state. Default ('project') points
   *  the iframe at the project tree; ('build') points it at _build/index.html
   *  after a successful `codesign:v1:godot-web-build`. Toolbar's "Build web
   *  preview" button flips a design from 'project' to 'build'. */
  godotPreviewByDesign: Record<string, 'project' | 'build'>;
  /** A6.x — per-design Godot build status: 'idle' | 'building' | 'failed' |
   *  'ok'. Toolbar uses this to render the spinner / error / success state. */
  godotBuildStatusByDesign: Record<
    string,
    | { status: 'idle' }
    | { status: 'building'; phase: string; line?: string }
    | { status: 'failed'; reason: string; detail: string }
    | { status: 'ok' }
  >;
  /** Last-picked mode in the New-design dialog. Hydrated from preferences.json
   *  at boot; updated on every dialog submit. Defaults to 'design'. */
  lastPickedMode: 'design' | 'game';
  /** Workspace rebind confirmation state: { design, newPath } when user picks a different folder */
  workspaceRebindPending: { design: Design; newPath: string } | null;

  theme: Theme;
  view: AppView;
  previousView: AppView;
  /** When non-null, Settings reads this on mount to auto-select the tab
   *  then calls clearSettingsTab() so future opens are unbiased. */
  settingsTab: SettingsTab | null;
  hubTab: HubTab;
  previewViewport: PreviewViewport;
  /** A6.x — selected aspect for game-mode previews. Defaults to 16:9. */
  gameAspect: GameAspect;
  toasts: Toast[];
  iframeErrors: string[];

  inputFiles: LocalInputFile[];
  referenceUrl: string;
  lastPromptInput: PromptRequest | null;
  selectedElement: SelectedElement | null;
  previewZoom: number;
  interactionMode: InteractionMode;

  // Sidebar v2 chat state
  chatMessages: ChatMessageRow[];
  chatLoaded: boolean;
  currentChatSessionId: number;
  /** In-flight tool calls that haven't completed yet. Purely in-memory —
   *  only persisted to SQLite when the result arrives (done/error). */
  pendingToolCalls: ChatToolCallPayload[];
  sidebarCollapsed: boolean;

  // Workstream D — comments
  comments: CommentRow[];
  commentsLoaded: boolean;
  commentBubble: CommentBubbleAnchor | null;
  /** Id of the snapshot currently visible in the preview — pins filter by it. */
  currentSnapshotId: string | null;
  /** Live, iframe-viewport-relative rects keyed by selector. Updated on
   *  every iframe scroll/resize so pins and bubbles track their anchor
   *  element even when the design scrolls inside the sandbox. Consumers
   *  prefer this over the stored rect when present. Unscaled — callers
   *  apply zoom themselves. */
  liveRects: Record<string, CommentRect>;

  /** Follow-the-edit cursor anchor — driven by `tool_call_result` events
   *  carrying `editStartLine`/`editEndLine`. The renderer pushes those line
   *  numbers into the iframe via `HIGHLIGHT_SRC_LINE`; the iframe broadcasts
   *  the matching DOM element's rect under `liveRects['__edit_cursor__']`.
   *  This slice tracks the cursor's overlay metadata (label + key for CSS
   *  re-trigger), not the rect itself — read the rect from `liveRects`. */
  editCursor: {
    /** Bumped on each new edit so the overlay can re-trigger CSS animations
     *  even when consecutive edits land on the same DOM element. */
    key: number;
    /** Short label rendered in the cursor pill, e.g. "Editing line 412". */
    toolLabel: string;
    /** Source-line range from the agent's str_replace/insert metadata.
     *  PreviewPane forwards these into the iframe via HIGHLIGHT_SRC_LINE so
     *  the overlay can resolve them to a DOM element. */
    startLine: number;
    endLine: number;
    /** perf.now() + 1400. The overlay component clears itself when expired
     *  so a stalled run doesn't leave a stale halo on the preview. */
    expiresAt: number;
  } | null;
  setEditCursor: (next: { toolLabel: string; startLine: number; endLine: number }) => void;
  clearEditCursor: () => void;

  // Workstream G — canvas file tabs
  canvasTabs: CanvasTab[];
  activeCanvasTab: number;

  // PR4 — diagnostics slice. Pull-based: Diagnostics panel + error UI call
  // `refreshDiagnosticEvents` on mount / when a failure surfaces. No polling.
  recentEvents: DiagnosticEventRow[];
  unreadErrorCount: number;
  /** Timestamp of the last time the user opened the Diagnostics panel.
   *  `unreadErrorCount` counts error-level events whose `ts > lastReadTs`. */
  lastReadTs: number;
  /** Guard so we only hydrate `lastReadTs` from persisted preferences once
   *  per session — first `refreshDiagnosticEvents` call does the read. */
  diagnosticsPrefsHydrated: boolean;
  refreshDiagnosticEvents: () => Promise<void>;
  markDiagnosticsRead: () => void;
  reportDiagnosticEvent: (
    input: Omit<ReportEventInput, 'schemaVersion' | 'timeline' | 'error'> & {
      error: ReportableError;
    },
  ) => Promise<ReportEventResult>;

  /**
   * Canonical in-memory registry of every error the renderer has surfaced to
   * the user. Capped at MAX_REPORTABLE; oldest entries drop first. The Report
   * dialog reads from here directly so it opens instantly, without an IPC
   * round-trip to the diagnostic_events DB.
   */
  reportableErrors: ReportableError[];
  /**
   * Register a ReportableError in-memory (synchronous) and kick off a fire-
   * and-forget `recordRendererError` IPC to persist it into diagnostic_events.
   * Returns the newly minted `localId` so callers can stamp it on the toast
   * or dialog invocation.
   */
  createReportableError: (partial: CreateReportableErrorInput) => string;
  getReportableError: (localId: string) => ReportableError | undefined;

  /** localId of the ReportableError whose Report dialog is currently open, or
   *  null if no dialog is active. Hoisted to the store so only one dialog
   *  ever mounts — multiple error toasts can't stack overlapping modals. */
  activeReportLocalId: string | null;
  openReportDialog: (localId: string) => void;
  closeReportDialog: () => void;

  loadConfig: () => Promise<void>;
  completeOnboarding: (next: OnboardingState) => void;
  sendPrompt: (input: {
    prompt: string;
    attachments?: LocalInputFile[] | undefined;
    referenceUrl?: string | undefined;
    /** Silent prompts skip the user chat bubble and the auto-rename trigger.
     *  Used by the auto-polish flow so the injected "deepen" request isn't
     *  visible as a user message — the agent still receives it and responds
     *  normally, but the chat transcript reads as one continuous run. */
    silent?: boolean | undefined;
    /** Internal: set by the prompt-assist dialog after the user picks
     *  constraints, so the second-pass sendPrompt skips the dialog
     *  intercept (the design now has metadata). */
    skipPromptAssist?: boolean | undefined;
    /** Internal: set when the auto-retry path re-issues a prompt that
     *  hit a transient stream cut on its first attempt. Caps retries to 1
     *  so a genuinely broken request can't loop forever. (B1 — see
     *  applyGenerateError for the trigger.) */
    _autoRetried?: boolean | undefined;
  }) => Promise<void>;
  /** Pending short-prompt submission queued behind the prompt-assist
   *  interstitial. The dialog reads this; when null, the dialog is closed.
   *  See backlog-1 #9. */
  promptAssistPending: {
    designId: string;
    input: {
      prompt: string;
      attachments?: LocalInputFile[] | undefined;
      referenceUrl?: string | undefined;
    };
  } | null;
  /** Persist the user's chip picks to the design (or null on skip), close
   *  the dialog, and resume the original sendPrompt. */
  resolvePromptAssist: (picks: PromptAssistMetadata | null) => Promise<void>;
  /** Cancel the pending submission entirely (Esc / overlay click). */
  cancelPromptAssist: () => void;
  /** Set of designIds for which the automatic polish / deepen follow-up has
   *  already fired. Prevents infinite loops (polish round would otherwise
   *  also end in agent_end and trigger itself). Cleared when a design is
   *  deleted or the app restarts. */
  /** Feature flag for the auto-polish second-loop injection. When true,
   *  `tryAutoPolish` fires a canned "deepen this design" follow-up after the
   *  first successful run of a design. Set to false for now because the
   *  second round doubles run time and the gain isn't worth the wait while
   *  context management is still settling. Flip back to true once polish
   *  runs are faster / cheaper. Can also be toggled at runtime via
   *  `useCodesignStore.setState({ autoPolishEnabled: true })` from devtools. */
  autoPolishEnabled: boolean;
  autoPolishFired: Set<string>;
  /** Fire the canned "deepen this design" follow-up prompt once per design,
   *  if the condition is met (first round succeeded, no prior polish). Call
   *  from useAgentStream's agent_end handler. */
  tryAutoPolish: (designId: string, locale: string) => void;
  cancelGeneration: (asCheckpoint?: boolean) => void;
  /** Backlog-3 §5 — resume from a previously-saved checkpoint. Builds
   *  a synthetic continue prompt and calls sendPrompt. The agent's
   *  history is naturally preserved in chat_messages, so resume = a
   *  fresh continue against the existing transcript. */
  resumeFromCheckpoint: () => Promise<void>;
  /** Push a "wrap up now" steer into the agent's pending queue. The
   *  agent picks it up at the next turn_end and converges to `done`
   *  immediately. UI surface: the "Wrap up" button next to the Stop
   *  button in the prompt input. No-op if nothing's generating. */
  requestWrapUp: () => Promise<void>;
  /**
   * Start a fresh conversation in the active design. Bumps the
   * design's session_id pointer so subsequent prompts ship an empty
   * history to the LLM (saves tokens, frees up context, fresh cache),
   * while leaving the design itself, preview, snapshots, files, and
   * past chat rows intact. Past sessions remain visible in the chat
   * list rendered with a divider. No-op if a generation is in flight.
   *
   * Returns the new sessionId; toasts on success/failure.
   */
  requestNewSession: () => Promise<number | null>;
  retryLastPrompt: () => Promise<void>;
  applyInlineComment: (comment: string) => Promise<void>;
  clearError: () => void;
  clearIframeErrors: () => void;
  pushIframeError: (message: string) => void;
  exportActive: (format: ExportFormat) => Promise<void>;

  pickInputFiles: () => Promise<void>;
  removeInputFile: (path: string) => void;
  clearInputFiles: () => void;
  setReferenceUrl: (value: string) => void;
  pickDesignSystemDirectory: () => Promise<void>;
  clearDesignSystem: () => Promise<void>;

  selectCanvasElement: (selection: SelectedElement) => void;
  clearCanvasElement: () => void;
  setPreviewZoom: (zoom: number) => void;
  setInteractionMode: (mode: InteractionMode) => void;

  /** Skill-extract draft state — set when the user has dragged a region
   *  but hasn't yet submitted the description. Drives the prompt-input
   *  dialog inside the overlay. See backlog-2 #7 region capture. */
  skillExtractDraft: { rect: CommentRect; designId: string; snapshotId: string } | null;
  /** Switch the workspace into region-capture mode. Returns false when
   *  no design is currently open or no snapshot exists; the caller can
   *  surface a toast in that case. */
  beginSkillExtract: () => boolean;
  /** Stash a freshly drawn rectangle while the user types the description. */
  setSkillExtractRect: (rect: CommentRect) => void;
  /** Submit the captured region + description to the extractor IPC.
   *  Returns the new skill on success; throws on failure (caller toasts). */
  submitSkillExtract: (userPrompt: string) => Promise<import('@open-codesign/shared').UserSkill>;
  /** Drop the in-progress capture and exit skill-extract mode. */
  cancelSkillExtract: () => void;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setView: (view: AppView) => void;
  /** Open Settings and select a specific tab. Used by the topbar unread-error
   *  badge to jump straight to the Diagnostics panel. Setting to null clears
   *  the hint (Settings falls back to its own default tab). */
  openSettingsTab: (tab: SettingsTab) => void;
  clearSettingsTab: () => void;
  setHubTab: (tab: HubTab) => void;
  setPreviewViewport: (viewport: PreviewViewport) => void;
  setGameAspect: (aspect: GameAspect) => void;

  loadDesigns: () => Promise<void>;
  ensureCurrentDesign: () => Promise<void>;
  openNewDesignDialog: () => void;
  closeNewDesignDialog: () => void;
  /** gameplan §A6 — set by the New-design dialog on submit; consumed by
   *  the next runGenerate payload construction. */
  setPendingGameSelection: (
    mode: 'design' | 'game',
    engine: 'three' | 'phaser' | 'pygame' | 'godot' | null,
  ) => void;
  clearPendingGameSelection: () => void;
  /** A6.x — kick off `codesign:v1:godot-web-build` for a given design,
   *  stream progress into godotBuildStatusByDesign, flip
   *  godotPreviewByDesign[id] to 'build' on success. Renders nothing
   *  visible itself; the toolbar button calls this and reads the status
   *  back to render its UI. */
  buildGodotWebPreview: (designId: string) => Promise<void>;
  createNewDesign: (workspacePath?: string | null) => Promise<Design | null>;
  switchDesign: (id: string) => Promise<void>;
  renameCurrentDesign: (name: string) => Promise<void>;
  renameDesign: (id: string, name: string) => Promise<void>;
  duplicateDesign: (id: string) => Promise<Design | null>;
  softDeleteDesign: (id: string) => Promise<void>;
  openDesignsView: () => void;
  closeDesignsView: () => void;
  requestDeleteDesign: (design: Design | null) => void;
  requestRenameDesign: (design: Design | null) => void;

  requestWorkspaceRebind: (design: Design, newPath: string) => void;
  cancelWorkspaceRebind: () => void;
  confirmWorkspaceRebind: (migrateFiles: boolean) => Promise<void>;

  pushToast: (toast: Omit<Toast, 'id'>) => string;
  /**
   * Convenience wrapper that pairs `createReportableError` with `pushToast`
   * so callers don't have to stitch them together. Prefer this over raw
   * `pushToast({ variant: 'error', ... })` at any site where a meaningful
   * `code` + `scope` can be supplied — the Report dialog then gets real
   * triage fields instead of the generic RENDERER_ERROR / renderer pair
   * that `pushToast`'s auto-wrap falls back to.
   */
  reportableErrorToast: (spec: ReportableErrorToastSpec) => string;
  dismissToast: (id?: string) => void;

  // Sidebar v2 chat actions
  loadChatForCurrentDesign: () => Promise<void>;
  appendChatMessage: (input: ChatAppendInput) => Promise<ChatMessageRow | null>;
  clearChatLocal: () => void;
  switchChatSession: (sessionId: number) => Promise<boolean>;
  setStreamingAssistantText: (value: { designId: string; text: string } | null) => void;
  setStreamingThinking: (value: { designId: string; text: string } | null) => void;
  setStreamingToolDraft: (
    value: { designId: string; toolName: string; toolCallId: string; bytes: number } | null,
  ) => void;
  /** Backlog-3 §4 — accumulate or close a streaming tool result entry. */
  patchStreamingToolResult: (
    toolCallId: string,
    patch: { byteCount?: number; preview?: string; progressPct?: number } | null,
  ) => void;
  setPreviewUpdatedAt: (value: { designId: string; ts: number; bytesDelta: number } | null) => void;
  bumpPreviewReload: () => void;
  pushPendingToolCall: (designId: string, call: ChatToolCallPayload) => void;
  resolvePendingToolCall: (
    designId: string,
    toolName: string,
    result?: string,
    durationMs?: number,
  ) => void;
  /** Patch a persisted tool_call row's status and merge into local state.
   *  Called when the agent's tool_call_result event lands after the row was
   *  already inserted as 'running' at tool_call_start time. */
  updateChatToolStatus: (input: {
    designId: string;
    seq: number;
    status: 'done' | 'error';
    result?: unknown;
    durationMs?: number;
    errorMessage?: string;
  }) => Promise<void>;
  /** Live preview update from the agent's virtual fs (text_editor tool).
   *  Gated by designId match against the active or generating design so a
   *  background run cannot stomp the preview the user is currently viewing. */
  setPreviewHtmlFromAgent: (input: { designId: string; content: string }) => void;
  /** Persist the current in-memory `previewHtml` for a finished agentic run as
   *  a SQLite snapshot row. Without this, agentic runs never write to disk
   *  and reload boots back into the empty welcome state even when the agent
   *  produced a valid index.html. Fires-and-forgets — failures are toasted. */
  persistAgentRunSnapshot: (input: { designId: string; finalText?: string }) => Promise<void>;
  /** Replace the current preview source verbatim. Used by the host's tweak
   *  panel to write a re-serialized EDITMODE block back into the artifact. */
  setPreviewHtml: (content: string) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // Workstream D — comments
  loadCommentsForCurrentDesign: () => Promise<void>;
  openCommentBubble: (anchor: CommentBubbleAnchor) => void;
  closeCommentBubble: () => void;
  addComment: (input: {
    kind: CommentKind;
    selector: string;
    tag: string;
    outerHTML: string;
    rect: CommentRect;
    text: string;
    scope?: CommentScope;
    parentOuterHTML?: string;
  }) => Promise<CommentRow | null>;
  updateComment: (id: string, patch: { text?: string }) => Promise<CommentRow | null>;
  /** Single entry point used by CommentBubble. If `existingCommentId` is set,
   *  routes to updateComment (editing a saved comment); otherwise addComment
   *  (creating a new one). Returns the resulting row on success, null on
   *  failure — callers must check before closing UI so drafts aren't lost. */
  submitComment: (input: {
    existingCommentId?: string;
    kind: CommentKind;
    selector: string;
    tag: string;
    outerHTML: string;
    rect: CommentRect;
    text: string;
    scope?: CommentScope;
    parentOuterHTML?: string;
  }) => Promise<CommentRow | null>;
  removeComment: (id: string) => Promise<void>;
  /** Replace the live rects map — called from PreviewPane when the sandbox
   *  broadcasts an ELEMENT_RECTS message. Entries are iframe-viewport-relative
   *  and unscaled. */
  applyLiveRects: (entries: Array<{ selector: string; rect: CommentRect }>) => void;
  /** Reset live rects — call on design/snapshot switch to avoid stale
   *  overlays pointing at the previous iframe's layout. */
  clearLiveRects: () => void;

  // Workstream G — canvas file tabs
  openCanvasFileTab: (path: string) => void;
  closeCanvasTab: (index: number) => void;
  setActiveCanvasTab: (index: number) => void;
  resetCanvasTabs: () => void;
}

export interface CommentBubbleAnchor {
  selector: string;
  tag: string;
  outerHTML: string;
  rect: CommentRect;
  /** v2 enrichment — parent element outerHTML, truncated. */
  parentOuterHTML?: string;
  /** If set, the bubble is editing an existing saved comment. */
  existingCommentId?: string;
  initialText?: string;
  initialScope?: CommentScope;
}

const THEME_STORAGE_KEY = 'open-codesign:theme';

// PreviewPane keeps an iframe per recently-visited design alive so switching
// back is instant. Bound the pool so memory stays small for users with lots
// of designs — 5 covers the typical "compare two or three" workflow with
// headroom and only costs a few MB of iframe documents.
const PREVIEW_POOL_LIMIT = 5;

function recordPreviewInPool(
  prevCache: Record<string, string>,
  prevRecent: string[],
  designId: string,
  html: string | null,
): { cache: Record<string, string>; recent: string[] } {
  const recent = [designId, ...prevRecent.filter((x) => x !== designId)].slice(
    0,
    PREVIEW_POOL_LIMIT,
  );
  const merged = html !== null ? { ...prevCache, [designId]: html } : prevCache;
  const cache: Record<string, string> = {};
  for (const id of recent) {
    if (merged[id] !== undefined) cache[id] = merged[id];
  }
  return { cache, recent };
}

function isFiniteUsageNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export function coerceUsageSnapshot(result: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  costUsd?: unknown;
  cachedInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
}): { usage: UsageSnapshot; rejected: string[] } {
  const rejected: string[] = [];
  const pick = (label: string, v: unknown): number => {
    if (v === undefined) return 0;
    if (isFiniteUsageNumber(v)) return v;
    rejected.push(label);
    return 0;
  };
  return {
    usage: {
      inputTokens: pick('inputTokens', result.inputTokens),
      outputTokens: pick('outputTokens', result.outputTokens),
      costUsd: pick('costUsd', result.costUsd),
      cachedInputTokens: pick('cachedInputTokens', result.cachedInputTokens),
      cacheCreationInputTokens: pick('cacheCreationInputTokens', result.cacheCreationInputTokens),
    },
    rejected,
  };
}

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'light';
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

function persistTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function modelRef(provider: string, modelId: string): ModelRef {
  return { provider, modelId };
}

function normalizeReferenceUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function uniqueFiles(files: LocalInputFile[]): LocalInputFile[] {
  const seen = new Set<string>();
  const result: LocalInputFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}

function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options ?? {}) as string;
}

type SetState = StoreApi<CodesignState>['setState'];
type GetState = StoreApi<CodesignState>['getState'];

/**
 * Quick sanity gate for artifact content before we overwrite the design's
 * latest snapshot. Catches the dominant failure mode: an agent run that was
 * interrupted mid-edit (context blowup, provider 400, autopolish crash, user
 * cancel) leaves a truncated JSX file in the virtual FS — its tail is missing
 * the `ReactDOM.createRoot(...).render(<App/>)` line and braces are wildly
 * unbalanced. Persisting that as the new snapshot would blank the hub
 * thumbnail and lose the previous good state. The check is intentionally
 * tolerant (±2 on bracket count) so whitespace quirks in valid artifacts pass.
 */
function looksRunnableArtifact(src: string): boolean {
  const trimmed = src.trim();
  if (trimmed.length === 0) return false;
  // HTML artifacts (legacy paste) don't need the JSX gate — accept anything
  // that at least has an <html> or <body>.
  if (/<html[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed)) return true;
  // JSX contract: must end with a mount call. Without it the iframe renders
  // nothing and the thumbnail stays blank.
  if (!/ReactDOM\.createRoot\s*\([\s\S]*?\)\s*\.render\s*\(/.test(trimmed)) return false;
  // Rough brace / paren balance. Not string-aware (that's overkill for a
  // truncation gate) — the ±2 tolerance absorbs the usual legitimate drift
  // inside template literals or comments.
  const opens = (trimmed.match(/\{/g) ?? []).length;
  const closes = (trimmed.match(/\}/g) ?? []).length;
  if (Math.abs(opens - closes) > 2) return false;
  const popens = (trimmed.match(/\(/g) ?? []).length;
  const pcloses = (trimmed.match(/\)/g) ?? []).length;
  if (Math.abs(popens - pcloses) > 2) return false;
  return true;
}

function autoNameFromPrompt(prompt: string): string {
  const condensed = prompt.replace(/\s+/g, ' ').trim();
  if (condensed.length === 0) return 'Untitled design';
  return condensed.length > 40 ? `${condensed.slice(0, 40).trimEnd()}…` : condensed;
}

function isDefaultDesignName(name: string): boolean {
  return name === 'Untitled design' || /^Untitled design \d+$/.test(name);
}

// Core emits 'html' | 'svg' | 'slides' | 'bundle' | 'game' (gameplan §A1)
// but the snapshots schema only stores 'html' | 'react' | 'svg' | 'game'
// (see DesignSnapshotV1). 'slides'/'bundle' fold into 'html' because their
// on-disk source is HTML — keeping the column constraint stable means we
// don't need a schema migration to persist them. 'game' carries through
// directly so the renderer can branch the preview pipeline on it.
// Unknown types throw so a new core ArtifactType doesn't silently round-trip
// as the wrong renderer.
export function toSnapshotArtifactType(
  coreType: string | undefined,
): 'html' | 'react' | 'svg' | 'game' {
  switch (coreType) {
    case undefined:
    case 'html':
    case 'slides':
    case 'bundle':
      return 'html';
    case 'svg':
      return 'svg';
    case 'react':
      return 'react';
    case 'game':
      return 'game';
    default:
      throw new Error(`Unsupported artifact type for snapshot persistence: ${coreType}`);
  }
}

interface PersistArtifact {
  type: string | undefined;
  content: string;
  prompt: string | null;
  message: string | null;
}

function artifactFromResult(
  source: { type?: string; content: string } | undefined,
  prompt: string | null,
  message: string | null,
): PersistArtifact | null {
  if (!source) return null;
  return { type: source.type, content: source.content, prompt, message };
}

// Per-designId serialization queue. A single generate run reaches this
// function twice — once from applyGenerateResult → persistDesignState and once
// from the agent_end handler → persistAgentRunSnapshot. Without serialization
// both callers race on `snapshots.list`, see zero rows, and both write a fresh
// parent-less 'initial' snapshot. Chaining per design collapses the race and
// lets the content-based dedupe below drop the second write cleanly.
const snapshotPersistLocks = new Map<string, Promise<unknown>>();

async function persistArtifactSnapshot(
  designId: string,
  artifact: PersistArtifact,
): Promise<string | null> {
  if (!window.codesign) return null;
  const prior = snapshotPersistLocks.get(designId) ?? Promise.resolve();
  const run = prior.then(async () => {
    if (!window.codesign) return null;
    const existing = await window.codesign.snapshots.list(designId);
    const parent = existing[0] ?? null;
    // Dedupe by content: the agent_end path and the generate-result path both
    // fire at the tail of a run and often hold identical html. Returning the
    // existing id avoids duplicate rows without making either caller aware of
    // the other.
    if (parent !== null && parent.artifactSource === artifact.content) {
      return parent.id;
    }
    const created = await window.codesign.snapshots.create({
      designId,
      parentId: parent?.id ?? null,
      type: parent ? 'edit' : 'initial',
      prompt: artifact.prompt,
      artifactType: toSnapshotArtifactType(artifact.type),
      artifactSource: artifact.content,
      ...(artifact.message ? { message: artifact.message } : {}),
    });
    return created?.id ?? null;
  });
  snapshotPersistLocks.set(
    designId,
    run.catch(() => {}),
  );
  return run;
}

/**
 * Rebuild the agent-facing history from chat_messages (single source of truth
 * for the sidebar chat). Only user + assistant_text rows contribute — tool_call
 * / artifact_delivered / error are dropped because the agent re-reads live file
 * state via text_editor.view(). seedFromSnapshots first so legacy designs with
 * only snapshot-era user prompts get backfilled. Falls back to [] when designId
 * is null or IPC is unavailable (renderer tests).
 */
/** Last N user-prompt turns whose tool transcript we ship verbatim.
 *  Older turns get summarised. The agent only needs full-fidelity for
 *  the immediate context — earlier rounds collapse to one assistant
 *  text + a one-line tool count summary. */
const FULL_TRANSCRIPT_TURN_COUNT = 2;

/** Total tool-history payload byte cap. ~120 KB ≈ 30 K tokens — well
 *  inside Anthropic's safe-cache window without dominating the prompt
 *  budget. When exceeded we drop the oldest tool transcript first. */
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

/** Stringify the tool result into a compact text block the agent sees
 *  on the next turn. Truncates very long bodies with a clear marker so
 *  the model knows it was clipped. Mirrors pi-ai's expected
 *  `ToolResultMessage.content` shape. */
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

/** Render a one-line summary of a turn's tool transcript so older
 *  rounds collapse without losing the bookkeeping signal. */
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

/** Pure history-builder for testing. Takes raw chat rows (as the IPC
 *  returns them) and produces the ChatMessage[] history payload the
 *  agent sees on the next turn. Exposed separately from
 *  buildHistoryFromChat (which does the IPC fetch + seeding) so tests
 *  can pass a fixture without mocking window.codesign.
 *
 *  `opts.sessionId` filters rows to a single session so previous
 *  conversations (from before the user clicked New Session) don't leak
 *  into the LLM history payload. Rows without a sessionId field — or
 *  with sessionId === undefined — are treated as session 0 to match
 *  the DB default. Omitting the filter returns rows from all sessions
 *  (used by the chat-list UI). */
export function buildHistoryFromChatRows(
  inputRows: ReadonlyArray<{ kind: string; payload?: unknown; sessionId?: number | undefined }>,
  opts: { sessionId?: number } = {},
): ChatMessage[] {
  const rows: ReadonlyArray<{
    kind: string;
    payload?: unknown;
    sessionId?: number | undefined;
  }> =
    opts.sessionId === undefined
      ? inputRows
      : inputRows.filter((r) => (r.sessionId ?? 0) === opts.sessionId);
  // First pass — split rows into per-user-prompt turns. A "turn" starts
  // at each `kind=user` row and ends at the next user row (or end of
  // history). This gives us the bracket inside which a single agent
  // run did its tool work + emitted text.
  type Turn = {
    userText: string;
    toolPayloads: ToolCallPayload[];
    assistantText: string[];
  };
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

  // Second pass — full transcript for the most recent N turns,
  // condensed for everything older. Apply a global byte budget by
  // dropping the oldest tool transcripts first if total exceeds cap.
  const out: ChatMessage[] = [];
  const fullStart = Math.max(0, turns.length - FULL_TRANSCRIPT_TURN_COUNT);
  let totalToolBytes = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;

    out.push({ role: 'user', content: turn.userText });

    const isFullDetailTurn = i >= fullStart;
    if (!isFullDetailTurn) {
      // Older turn — collapse tool transcript to a one-line marker so
      // the model still sees the shape of what happened without
      // paying the byte tax. The assistant's `done` summary remains.
      const summary = summariseToolBatch(turn.toolPayloads);
      const assistantTail = turn.assistantText[turn.assistantText.length - 1] ?? '';
      const condensed = [summary, assistantTail].filter((s) => s.length > 0).join('\n\n');
      if (condensed.length > 0) {
        out.push({ role: 'assistant', content: condensed });
      }
      continue;
    }

    // Recent turn — emit each tool call as an assistant message with
    // tool-call refs, paired with its tool-result message. Inter-tool
    // assistant text rolls up into a leading text bundle on the
    // assistant message that owned the first tool call (kept compact;
    // narration is filtered separately in Phase 3).
    const leadingText = turn.assistantText.join('\n\n').trim();
    if (turn.toolPayloads.length === 0) {
      if (leadingText.length > 0) out.push({ role: 'assistant', content: leadingText });
      continue;
    }

    // Pair each tool call with its summarised result. Group calls
    // 1-to-1 with results; if the agent emitted text alongside a
    // tool call (rare but possible in pi-ai), surface it as the
    // assistant message's text content.
    let prefixUsed = false;
    for (const p of turn.toolPayloads) {
      if (p.toolCallId === undefined || p.toolName === undefined) continue;
      const argsJson = JSON.stringify(p.args ?? {});
      const assistantContent = !prefixUsed && leadingText.length > 0 ? leadingText : '';
      prefixUsed = true;
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantContent,
        toolCalls: [{ id: p.toolCallId, name: p.toolName, argsJson }],
      };
      const summary = summariseToolResult(p);
      const toolMsg: ChatMessage = {
        role: 'tool',
        content: summary.text,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        isError: summary.isError,
      };
      const pairBytes = assistantContent.length + argsJson.length + summary.text.length;
      if (totalToolBytes + pairBytes > TOOL_TRANSCRIPT_BYTE_BUDGET) {
        // Budget exhausted on this turn — drop remaining tool calls
        // for THIS turn and collapse the rest into a one-line tail.
        // Recent turns are kept whole when possible; we only collapse
        // when we'd blow the cap.
        out.push({
          role: 'assistant',
          content: `[tool transcript clipped — ${turn.toolPayloads.length} more tool calls omitted to stay under budget]`,
        });
        break;
      }
      out.push(assistantMsg);
      out.push(toolMsg);
      totalToolBytes += pairBytes;
    }
  }

  return out;
}

/** Cap history to the most recent `cap` messages, but never start the
 *  result mid-pair. A raw slice(-cap) can land between an
 *  assistant-with-toolCalls and its paired tool result, leaving the
 *  array starting with a `tool` row — Anthropic rejects that with
 *  "tool_result without preceding tool_use". We slice, then drop
 *  leading non-`user` rows so the array always begins on a turn
 *  boundary. */
export function capHistoryToTurnBoundary(
  history: ReadonlyArray<ChatMessage>,
  cap: number,
): ChatMessage[] {
  const sliced = history.length > cap ? history.slice(-cap) : history.slice();
  let firstUser = 0;
  while (firstUser < sliced.length && sliced[firstUser]?.role !== 'user') firstUser += 1;
  return firstUser === 0 ? sliced : sliced.slice(firstUser);
}

async function buildHistoryFromChat(designId: string | null): Promise<ChatMessage[]> {
  if (!designId || !window.codesign) return [];
  try {
    await window.codesign.chat.seedFromSnapshots(designId);
    const [rows, current] = await Promise.all([
      window.codesign.chat.list(designId),
      // Fetch the design's active session pointer so the agent only sees
      // rows from the current conversation. Older sessions remain in the
      // chat list (rendered with a divider) but pay zero token cost.
      // Falls back to 0 if the IPC isn't available (legacy preload).
      typeof window.codesign.chat.currentSession === 'function'
        ? window.codesign.chat.currentSession(designId).catch(() => ({ sessionId: 0 }))
        : Promise.resolve({ sessionId: 0 }),
    ]);
    return buildHistoryFromChatRows(rows, { sessionId: current.sessionId });
  } catch {
    return [];
  }
}

async function persistDesignState(
  get: GetState,
  designId: string,
  previewHtml: string | null,
  artifact: PersistArtifact | null,
): Promise<string | null> {
  if (!window.codesign) return null;
  try {
    let newSnapshotId: string | null = null;
    if (artifact !== null) {
      newSnapshotId = await persistArtifactSnapshot(designId, artifact);
    }
    if (previewHtml !== null) {
      // Thumbnail text = first user prompt ever on this design, sourced from
      // chat_messages (canonical) instead of the removed store.messages mirror.
      let thumbText: string | null = null;
      try {
        const rows = await window.codesign.chat.list(designId);
        const firstUser = rows.find((r) => r.kind === 'user');
        const raw = (firstUser?.payload as { text?: string } | null)?.text;
        if (typeof raw === 'string' && raw.length > 0) thumbText = raw.slice(0, 200);
      } catch {
        // Non-fatal — thumbnail stays unchanged.
      }
      await window.codesign.snapshots.setThumbnail(designId, thumbText);
    }
    await get().loadDesigns();
    return newSnapshotId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : tr('errors.unknown');
    get().pushToast({
      variant: 'error',
      title: tr('projects.notifications.saveFailed'),
      description: msg,
    });
    throw err instanceof Error ? err : new Error(msg);
  }
}

async function maybeAutoRename(
  get: GetState,
  designId: string,
  firstPrompt: string,
): Promise<void> {
  if (!window.codesign) return;
  const design = get().designs.find((d) => d.id === designId);
  if (!design || !isDefaultDesignName(design.name)) return;
  // Try an LLM-generated title first; fall back to a truncation of the prompt
  // if the model call fails (missing key, offline, etc). The fallback is
  // synchronous so the design never stays on "Untitled design N".
  let newName = autoNameFromPrompt(firstPrompt);
  try {
    const api = window.codesign as unknown as {
      generateTitle?: (prompt: string) => Promise<string>;
    };
    if (typeof api.generateTitle === 'function') {
      const generated = await api.generateTitle(firstPrompt);
      const trimmed = generated.trim();
      if (trimmed.length > 0) newName = trimmed;
    }
  } catch (err) {
    // Fall through to the truncation fallback — don't surface a toast; the
    // name itself is a nice-to-have and the user can always rename manually.
    // But DO log the failure so we can see why in the main-process log.
    rendererLogger.warn('store', '[title] generateTitle failed, using prompt fallback', {
      designId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await window.codesign.snapshots.renameDesign(designId, newName);
    await get().loadDesigns();
  } catch (err) {
    const msg = err instanceof Error ? err.message : tr('errors.unknown');
    get().pushToast({
      variant: 'error',
      title: tr('projects.notifications.renameFailed'),
      description: msg,
    });
    throw err instanceof Error ? err : new Error(msg);
  }
}

function triggerAutoRenameIfFirst(get: GetState, isFirstPrompt: boolean, prompt: string): void {
  if (!isFirstPrompt) return;
  const designId = get().currentDesignId;
  if (designId) void maybeAutoRename(get, designId, prompt);
}

interface ReadyConfig extends OnboardingState {
  hasKey: true;
  provider: string;
  modelPrimary: string;
}

function isReadyConfig(cfg: OnboardingState | null): cfg is ReadyConfig {
  if (cfg === null) return false;
  return cfg.hasKey && cfg.provider !== null && cfg.modelPrimary !== null;
}

function finishIfCurrent(
  set: SetState,
  generationId: string,
  update: (state: CodesignState) => Partial<CodesignState>,
): void {
  set((state) => (state.activeGenerationId === generationId ? update(state) : {}));
}

function applyGenerateSuccess(
  set: SetState,
  get: GetState,
  generationId: string,
  prompt: string,
  result: {
    artifacts: Array<{ type?: string; content: string }>;
    message: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
  designIdAtStart: string | null,
): void {
  const firstArtifact = result.artifacts[0];
  const assistantMessage = result.message || tr('common.done');
  const { usage, rejected: rejectedUsageFields } = coerceUsageSnapshot(result);
  let didApply = false;
  finishIfCurrent(set, generationId, (_state) => {
    didApply = true;
    const nextHtml = firstArtifact?.content ?? _state.previewHtml;
    const pool =
      _state.currentDesignId !== null && nextHtml !== null
        ? recordPreviewInPool(
            _state.previewHtmlByDesign,
            _state.recentDesignIds,
            _state.currentDesignId,
            nextHtml,
          )
        : { cache: _state.previewHtmlByDesign, recent: _state.recentDesignIds };
    return {
      previewHtml: nextHtml,
      previewHtmlByDesign: pool.cache,
      recentDesignIds: pool.recent,
      isGenerating: false,
      activeGenerationId: null,
      currentRunIsRefinement: false,
      generatingDesignId: null,
      generationStage: 'done' as GenerationStage,
      lastUsage: usage,
    };
  });
  // If the user switched designs mid-generation, didApply is false but we
  // still want the fresh artifact in the pool so the design they generated
  // for shows the new content the next time they switch back to it.
  if (!didApply && firstArtifact?.content && designIdAtStart !== null) {
    const state = get();
    const pool = recordPreviewInPool(
      state.previewHtmlByDesign,
      state.recentDesignIds,
      designIdAtStart,
      firstArtifact.content,
    );
    set({ previewHtmlByDesign: pool.cache, recentDesignIds: pool.recent });
  }
  if (didApply) {
    // Workstream G — auto-open the generated file as a tab so the user sees
    // the preview immediately. For Phase 1 the only file is `index.html`;
    // post-Workstream E we'll use the file the agent actually wrote.
    if (firstArtifact) {
      get().openCanvasFileTab('index.html');
    }
    // Prefer the designId captured when the prompt was sent — if the user
    // switched designs mid-generation, get().currentDesignId would now point
    // at the new one and we'd write the artifact + assistant text into the
    // wrong chat. Fall back to current only when caller didn't pass one
    // (legacy paths).
    const designId = designIdAtStart ?? get().currentDesignId;
    if (designId) {
      const artifact = artifactFromResult(firstArtifact, prompt, assistantMessage);
      if (artifact !== null) {
        void persistDesignState(get, designId, get().previewHtml, artifact);
      }
      // Sidebar v2: append chat rows for artifact delivery.
      // When agent runtime is active (tool_call rows exist), useAgentStream
      // already persists assistant_text on turn_end with artifact stripping.
      // Skip the legacy assistant_text append entirely to avoid duplicates
      // and raw HTML leaking into chat.
      const agentRuntimeActive = get().chatMessages.some((m) => m.kind === 'tool_call');
      if (!agentRuntimeActive && assistantMessage.trim().length > 0) {
        void get().appendChatMessage({
          designId,
          kind: 'assistant_text',
          payload: { text: assistantMessage },
        });
      }
      if (firstArtifact) {
        void get().appendChatMessage({
          designId,
          kind: 'artifact_delivered',
          payload: { createdAt: new Date().toISOString() },
        });
      }
    }
    if (rejectedUsageFields.length > 0) {
      const detail = rejectedUsageFields.join(', ');
      console.warn('[open-codesign] dropped non-finite usage values from provider:', detail);
    }
  }
}

/**
 * Read a `code` string off a CodesignError-shaped value crossing IPC. Structured-
 * clone strips the prototype but preserves own enumerable properties in Electron
 * 28+; we read defensively. Returns undefined for anything that doesn't carry a
 * non-empty string code so callers can fall back to their scope-specific default.
 */
export function extractCodesignErrorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  return undefined;
}

/**
 * Pull NormalizedProviderError-shaped upstream fields off a caught error so the
 * Report dialog's "Upstream context" block can render them. Returns undefined
 * when none of the expected keys are present — callers then omit `context`
 * rather than attaching an empty object.
 */
export function extractUpstreamContext(err: unknown): Record<string, unknown> | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const rec = err as Record<string, unknown>;
  const keys = [
    'upstream_provider',
    'upstream_status',
    'upstream_code',
    'upstream_message',
    'upstream_request_id',
    'retry_count',
    'redacted_body_head',
    'original_error_name',
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = rec[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Pull an HTTP status code off a caught generate error. Looks at the
 * `upstream_status` field main/index.ts attaches first, then falls back to
 * common SDK locations, and finally regex-scans `err.message` for the
 * #130-style "404 page not found" text that arrives with no structured status.
 */
export function extractGenerateStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const rec = err as Record<string, unknown>;
  const candidates: unknown[] = [
    rec['upstream_status'],
    rec['status'],
    rec['statusCode'],
    (rec['response'] as { status?: unknown } | undefined)?.status,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 100 && c < 600) return c;
  }
  if (err instanceof Error) {
    const m = /\b([45]\d{2})\b/.exec(err.message);
    if (m?.[1]) return Number(m[1]);
  }
  return undefined;
}

/**
 * Pick an upstream-* string field off an err, guarding the "wrong type"
 * and "empty string" cases so callers can use `?? fallback`.
 */
function pickUpstreamString(err: unknown, key: string): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const v = (err as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function applyGenerateError(
  get: GetState,
  set: SetState,
  generationId: string,
  err: unknown,
  designIdAtStart: string | null,
): void {
  const msg = err instanceof Error ? err.message : tr('errors.unknown');
  if (get().activeGenerationId !== generationId) return;
  // TODO: replace with rendererLogger once renderer-logger lands
  console.error('[store] applyGenerateError', {
    generationId,
    designId: designIdAtStart,
    message: msg,
  });
  const code = extractCodesignErrorCode(err) ?? 'GENERATION_FAILED';

  finishIfCurrent(set, generationId, () => ({
    isGenerating: false,
    activeGenerationId: null,
    currentRunIsRefinement: false,
    generatingDesignId: null,
    streamingAssistantText: null,
    streamingThinking: null,
    streamingToolDraft: null,
    streamingToolResults: {},
    previewUpdatedAt: null,
    previewReloadTick: 0,
    errorMessage: msg,
    lastError: msg,
    generationStage: 'error' as GenerationStage,
  }));
  const designId = designIdAtStart ?? get().currentDesignId;
  if (designId) {
    void get().appendChatMessage({
      designId,
      kind: 'error',
      payload: { code, message: msg, runId: generationId },
    });
  }
  const upstream = extractUpstreamContext(err);

  // Bridge the failure into the connection-test diagnostics system so the
  // toast tells the user WHY and WHAT TO TRY instead of just dumping the
  // upstream message. Fixes #130 (404 → "add /v1") and gives #158 / #134 a
  // home for gateway / instructions-required hints.
  const cfg = get().config;
  const hypothesis = deriveGenerateHypothesis(err, cfg);
  const description = buildGenerateErrorDescription(msg, hypothesis);
  const action = buildGenerateFixAction(get, set, hypothesis, err, cfg);

  get().pushToast({
    variant: 'error',
    title: tr('notifications.generationFailed'),
    description,
    ...(action !== undefined ? { action } : {}),
    localId: get().createReportableError({
      code,
      scope: 'generate',
      message: msg,
      ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
      runId: generationId,
      ...(upstream !== undefined ? { context: upstream } : {}),
    }),
  });
}

function deriveGenerateHypothesis(
  err: unknown,
  cfg: OnboardingState | null,
): DiagnosticHypothesis | undefined {
  const provider = pickUpstreamString(err, 'upstream_provider') ?? cfg?.provider ?? 'unknown';
  const baseUrl = pickUpstreamString(err, 'upstream_baseurl') ?? cfg?.baseUrl ?? undefined;
  const wire = pickUpstreamString(err, 'upstream_wire');
  const status = extractGenerateStatus(err);
  const message = err instanceof Error ? err.message : undefined;
  const keyKindRaw = pickUpstreamString(err, 'key_kind');
  const keyKind: 'oauth' | 'static' | undefined =
    keyKindRaw === 'oauth' || keyKindRaw === 'static' ? keyKindRaw : undefined;
  const ctx = {
    provider,
    ...(baseUrl !== undefined && baseUrl !== null ? { baseUrl } : {}),
    ...(wire !== undefined ? { wire } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(keyKind !== undefined ? { keyKind } : {}),
  } satisfies Parameters<typeof diagnoseGenerateFailure>[0];
  const hypotheses = diagnoseGenerateFailure(ctx);
  const primary = hypotheses[0];
  // Skip the bare "unknown" hypothesis — appending "Unknown error" to a
  // toast that already shows the upstream message is just noise.
  if (primary === undefined || primary.cause === 'diagnostics.cause.unknown') {
    return undefined;
  }
  return primary;
}

function buildGenerateErrorDescription(
  originalMessage: string,
  hypothesis: DiagnosticHypothesis | undefined,
): string {
  if (hypothesis === undefined) return originalMessage;
  const hint = tr(hypothesis.cause);
  // When the i18n key was missing, tr() falls back to returning the key
  // itself; don't double up "diagnostics.cause.x" in the toast.
  if (hint === hypothesis.cause) return originalMessage;
  return `${originalMessage}\n\n${tr('diagnostics.mostLikelyCause')} ${hint}`;
}

function buildGenerateFixAction(
  get: GetState,
  set: SetState,
  hypothesis: DiagnosticHypothesis | undefined,
  err: unknown,
  cfg: OnboardingState | null,
): Toast['action'] | undefined {
  // Claude Code OAuth re-import: when the refresh helper bubbles the
  // terminal CLAUDE_CODE_REIMPORT_REQUIRED code (revoked/expired refresh
  // token), give the user a one-click action that runs the existing
  // import IPC. No baseUrl manipulation involved.
  const code = extractCodesignErrorCode(err);
  if (code === 'CLAUDE_CODE_REIMPORT_REQUIRED') {
    return {
      label: tr('notifications.claudeCodeReimport'),
      onClick: () => {
        void applyClaudeCodeReimport(get, set);
      },
    };
  }
  const fix = hypothesis?.suggestedFix;
  if (fix === undefined) return undefined;
  if (fix.baseUrlTransform === undefined) return undefined;
  const providerId = pickUpstreamString(err, 'upstream_provider') ?? cfg?.provider;
  const baseUrl = pickUpstreamString(err, 'upstream_baseurl') ?? cfg?.baseUrl ?? null;
  if (
    providerId === undefined ||
    providerId === null ||
    baseUrl === null ||
    !/^https?:\/\/\S+/i.test(baseUrl.trim())
  ) {
    return undefined;
  }
  const nextBaseUrl = fix.baseUrlTransform(baseUrl);
  if (nextBaseUrl === baseUrl) return undefined;
  return {
    label: tr('notifications.generationFailedApplyFix'),
    onClick: () => {
      void applyGenerateBaseUrlFix(get, set, providerId, nextBaseUrl);
    },
  };
}

async function applyClaudeCodeReimport(get: GetState, set: SetState): Promise<void> {
  const api = window.codesign?.config?.importClaudeCodeConfig;
  if (api === undefined) {
    get().reportableErrorToast({
      code: 'CLAUDE_CODE_REIMPORT_UNAVAILABLE',
      scope: 'generate',
      title: tr('notifications.claudeCodeReimportUnavailable'),
      description: tr('notifications.claudeCodeReimportUnavailableDescription'),
    });
    return;
  }
  try {
    const next = await api();
    set({ config: next });
    get().pushToast({
      variant: 'success',
      title: tr('notifications.claudeCodeReimportSucceeded'),
    });
  } catch (err) {
    get().reportableErrorToast({
      code: 'CLAUDE_CODE_REIMPORT_FAILED',
      scope: 'generate',
      title: tr('notifications.claudeCodeReimportFailed'),
      description: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
    });
  }
}

export async function applyGenerateBaseUrlFix(
  get: GetState,
  set: SetState,
  providerId: string,
  nextBaseUrl: string,
): Promise<void> {
  const api = window.codesign?.config?.updateProvider;
  // Don't silently swallow "this app version lacks the IPC" — surface it as a
  // reportable error so users know why the Apply-fix button did nothing and
  // can fall back to editing baseUrl manually in Settings.
  if (api === undefined) {
    get().reportableErrorToast({
      code: 'GENERATE_FIX_APPLY_UNAVAILABLE',
      scope: 'generate',
      title: tr('notifications.generationFailedFixUnavailable'),
      description: tr('notifications.generationFailedFixUnavailableDescription'),
    });
    return;
  }
  try {
    const next = await api({ id: providerId, baseUrl: nextBaseUrl });
    set({ config: next });
    get().pushToast({
      variant: 'success',
      title: tr('notifications.generationFailedBaseUrlUpdated'),
    });
  } catch (updateErr) {
    get().reportableErrorToast({
      code: 'GENERATE_FIX_APPLY_FAILED',
      scope: 'generate',
      title: tr('notifications.generationFailedFixApplyFailed'),
      description: updateErr instanceof Error ? updateErr.message : String(updateErr),
      ...(updateErr instanceof Error && updateErr.stack !== undefined
        ? { stack: updateErr.stack }
        : {}),
    });
  }
}

function advanceStageIfCurrent(
  get: GetState,
  set: SetState,
  generationId: string,
  stage: GenerationStage,
): void {
  if (get().activeGenerationId === generationId) set({ generationStage: stage });
}

async function runGenerate(
  get: GetState,
  set: SetState,
  generationId: string,
  payload: Parameters<CodesignApi['generate']>[0],
  designIdAtStart: string | null,
): Promise<void> {
  advanceStageIfCurrent(get, set, generationId, 'thinking');
  // Enter streaming stage before the IPC call so the UI shows "receiving response"
  // while the main process communicates with the model provider.
  advanceStageIfCurrent(get, set, generationId, 'streaming');
  const api = window.codesign;
  if (!api) throw new Error(tr('errors.rendererDisconnected'));
  const result = await api.generate(payload);
  // Response fully received — move through parsing → rendering before finalising.
  advanceStageIfCurrent(get, set, generationId, 'parsing');
  advanceStageIfCurrent(get, set, generationId, 'rendering');
  applyGenerateSuccess(
    set,
    get,
    generationId,
    payload.prompt,
    result as {
      artifacts: Array<{ type?: string; content: string }>;
      message: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
    },
    designIdAtStart,
  );
}

function buildPromptRequest(
  input: {
    prompt: string;
    attachments?: LocalInputFile[] | undefined;
    referenceUrl?: string | undefined;
  },
  storeInputFiles: LocalInputFile[],
  storeReferenceUrl: string,
): PromptRequest | null {
  const prompt = input.prompt.trim();
  if (!prompt) return null;
  const refUrl = normalizeReferenceUrl(input.referenceUrl ?? storeReferenceUrl);
  return {
    prompt,
    attachments: uniqueFiles(input.attachments ?? storeInputFiles),
    ...(refUrl ? { referenceUrl: refUrl } : {}),
  };
}

/**
 * Prepend a human-readable summary of the user's pending edit chips to the
 * prompt so the LLM knows which elements to change. Claude Design pins edits
 * to specific elements and lets users accumulate a batch before submitting;
 * this mirrors that "pending changes accumulator" shape.
 */
export interface PendingEditEnrichment {
  selector: string;
  tag: string;
  outerHTML: string;
  text: string;
  scope?: CommentScope | undefined;
  parentOuterHTML?: string | null | undefined;
}

export function buildEnrichedPrompt(
  userPrompt: string,
  pendingEdits: PendingEditEnrichment[],
): string {
  if (pendingEdits.length === 0) return userPrompt;

  const MAX_HTML = 600;
  const truncate = (s: string) => (s.length > MAX_HTML ? `${s.slice(0, MAX_HTML)}…` : s);

  const lines: string[] = [
    '## REQUIRED EDITS — you MUST apply every edit below to index.html',
    '',
    'Each edit targets a specific element identified by its selector and outerHTML.',
    'Use text_editor str_replace to find and modify the element. Do NOT skip any edit.',
    '',
  ];

  pendingEdits.forEach((edit, i) => {
    const scope =
      edit.scope === 'global' ? 'global (apply design-wide)' : 'element (this element only)';
    lines.push(`### Edit ${i + 1}: ${edit.text}`);
    lines.push(`- **Target**: \`<${edit.tag}>\` at \`${edit.selector}\``);
    lines.push(`- **Current HTML**: \`${truncate(edit.outerHTML)}\``);
    if (typeof edit.parentOuterHTML === 'string' && edit.parentOuterHTML.length > 0) {
      lines.push(`- **Parent context**: \`${truncate(edit.parentOuterHTML)}\``);
    }
    lines.push(`- **Scope**: ${scope}`);
    lines.push(`- **Instruction**: ${edit.text}`);
    lines.push('');
  });

  if (userPrompt.trim().length > 0) {
    lines.push('---', '', userPrompt);
  }

  return lines.join('\n');
}

export const useCodesignStore = create<CodesignState>((set, get) => ({
  previewHtml: null,
  previewHtmlByDesign: {},
  recentDesignIds: [],
  isGenerating: false,
  activeGenerationId: null,
  currentRunIsRefinement: false,
  generatingDesignId: null,
  generationStage: 'idle' as GenerationStage,
  streamingAssistantText: null,
  streamingThinking: null,
  streamingToolDraft: null,
  streamingToolResults: {},
  previewUpdatedAt: null,
  previewReloadTick: 0,
  chunkProgress: null,
  agentLiveness: null,
  pendingToolCalls: [],
  lastUsage: null,
  errorMessage: null,
  lastError: null,
  config: null,
  configLoaded: false,
  toastMessage: null,
  autoPolishEnabled: false,
  autoPolishFired: new Set<string>(),
  tryAutoPolish: (designId, locale) => {
    const s = get();
    if (!s.autoPolishEnabled) return;
    if (s.autoPolishFired.has(designId)) return;
    if (s.isGenerating) return;
    // Require that the design has at least one completed assistant_text row
    // for the just-finished round. If the agent ended without producing
    // prose, the run likely errored or was trivial — skip polish.
    const designMessages = s.chatMessages.filter((m) => m.designId === designId);
    const hasAssistantText = designMessages.some((m) => m.kind === 'assistant_text');
    if (!hasAssistantText) return;
    // Don't pile polish onto a failed run. If the latest event on this design
    // is an error (e.g. "prompt too long"), the artifact is broken and a
    // follow-up would only amplify the damage (and burn more tokens).
    const latest = designMessages[designMessages.length - 1];
    if (latest?.kind === 'error') return;
    // Skip polish if there was an error anywhere in the latest chain of
    // events after the most recent user message — same rationale.
    const lastUserIdx = designMessages.map((m) => m.kind).lastIndexOf('user');
    if (lastUserIdx >= 0 && designMessages.slice(lastUserIdx).some((m) => m.kind === 'error')) {
      return;
    }
    // Mark fired *before* sending so a race with a second agent_end in the
    // same tick can't double-trigger.
    const nextFired = new Set(s.autoPolishFired);
    nextFired.add(designId);
    set({ autoPolishFired: nextFired });
    // Local import to avoid a circular include with the hook file at module
    // load time — the store is imported by the hook and vice-versa.
    void import('./hooks/polishPrompt').then(({ pickPolishPrompt }) => {
      const prompt = pickPolishPrompt(locale);
      void get().sendPrompt({ prompt, silent: true });
    });
  },

  theme: readInitialTheme(),
  view: 'hub' as AppView,
  previousView: 'hub' as AppView,
  settingsTab: null as SettingsTab | null,
  hubTab: 'recent' as HubTab,
  previewViewport: 'desktop' as PreviewViewport,
  gameAspect: '16:9' as GameAspect,
  toasts: [],
  iframeErrors: [],

  designs: [],
  currentDesignId: null,
  designsLoaded: false,
  designsViewOpen: false,
  newDesignDialogOpen: false,
  pendingArtifactMode: null,
  pendingGameEngine: null,
  currentDesignEngine: null,
  godotPreviewByDesign: {},
  godotBuildStatusByDesign: {},
  lastPickedMode: 'design',
  designToDelete: null,
  designToRename: null,
  workspaceRebindPending: null,
  promptAssistPending: null,

  inputFiles: [],
  referenceUrl: '',
  lastPromptInput: null,
  selectedElement: null,
  previewZoom: 100,
  interactionMode: 'default' as InteractionMode,
  skillExtractDraft: null,

  chatMessages: [],
  chatLoaded: false,
  currentChatSessionId: 0,
  sidebarCollapsed: false,

  comments: [],
  commentsLoaded: false,
  commentBubble: null,
  currentSnapshotId: null,
  liveRects: {},
  editCursor: null,

  canvasTabs: [FILES_TAB],
  activeCanvasTab: 0,

  recentEvents: [],
  unreadErrorCount: 0,
  lastReadTs: 0,
  diagnosticsPrefsHydrated: false,
  reportableErrors: [],
  activeReportLocalId: null,

  clearIframeErrors() {
    set({ iframeErrors: [] });
  },

  pushIframeError(message) {
    set((s) => {
      const last = s.iframeErrors[s.iframeErrors.length - 1];
      if (last === message) return {};
      const next = [...s.iframeErrors, message];
      return { iframeErrors: next.length > 50 ? next.slice(1) : next };
    });
  },

  async loadConfig() {
    if (!window.codesign) {
      set({
        configLoaded: true,
        errorMessage: tr('errors.rendererDisconnected'),
      });
      return;
    }
    const state = await window.codesign.onboarding.getState();
    set({ config: state, configLoaded: true });
    if (state.hasKey) {
      await get().ensureCurrentDesign();
    }
  },

  completeOnboarding(next: OnboardingState) {
    recordAction({ type: 'onboarding.complete' });
    set({ config: next });
  },

  async pickInputFiles() {
    if (!window.codesign) return;
    const files = await window.codesign.pickInputFiles();
    if (files.length === 0) return;
    set((s) => ({ inputFiles: uniqueFiles([...s.inputFiles, ...files]) }));
  },

  removeInputFile(path) {
    set((s) => ({ inputFiles: s.inputFiles.filter((file) => file.path !== path) }));
  },

  clearInputFiles() {
    set({ inputFiles: [] });
  },

  setReferenceUrl(value) {
    set({ referenceUrl: value });
  },

  async pickDesignSystemDirectory() {
    if (!window.codesign) return;
    try {
      const next = await window.codesign.pickDesignSystemDirectory();
      set({ config: next });
      if (next.designSystem) {
        get().pushToast({
          variant: 'success',
          title: tr('notifications.designSystemLinked'),
          description: next.designSystem.summary,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : tr('errors.generic');
      get().pushToast({
        variant: 'error',
        title: tr('notifications.designSystemScanFailed'),
        description: message,
      });
    }
  },

  async clearDesignSystem() {
    if (!window.codesign) return;
    try {
      const next = await window.codesign.clearDesignSystem();
      set({ config: next });
      get().pushToast({ variant: 'info', title: tr('notifications.designSystemCleared') });
    } catch (err) {
      const message = err instanceof Error ? err.message : tr('errors.generic');
      get().pushToast({
        variant: 'error',
        title: tr('notifications.clearDesignSystemFailed'),
        description: message,
      });
    }
  },

  async sendPrompt(input) {
    recordAction({
      type: 'prompt.submit',
      data: {
        promptLen: input.prompt.length,
        hasAttachments: (input.attachments?.length ?? 0) > 0,
      },
    });
    if (get().isGenerating) return;

    // Gameimprove §4 — drop near-duplicate adjacent submissions. The
    // BRAWL ARENA trace had the same brief at seq 0 AND seq 2 (full
    // wasted agent run). Auto-retry from a transient failure shouldn't
    // be the only path; manual double-clicks deserve the same guard.
    // Skip for silent submissions (auto-polish) and the resolvePromptAssist
    // resume path — those legitimately re-call sendPrompt with the same
    // payload after the dialog cycle.
    if (!input.silent && input._autoRetried !== true && !input.skipPromptAssist) {
      const designId = get().currentDesignId;
      if (designId !== null) {
        const currentSessionId = get().currentChatSessionId;
        const lastUserMsg = [...get().chatMessages]
          .reverse()
          .find(
            (m) =>
              m.designId === designId &&
              m.kind === 'user' &&
              (m.sessionId ?? 0) === currentSessionId,
          );
        if (lastUserMsg !== undefined) {
          const lastText = (lastUserMsg.payload as { text?: string } | null)?.text ?? '';
          const ageMs = Date.now() - new Date(lastUserMsg.createdAt).getTime();
          if (lastText === input.prompt && ageMs < 60_000) {
            recordAction({ type: 'prompt.dedup', data: { ageMs } });
            get().pushToast({
              variant: 'info',
              title: tr('notifications.duplicatePromptTitle', {
                defaultValue: 'Identical prompt — skipped',
              }),
              description: tr('notifications.duplicatePromptBody', {
                defaultValue:
                  'You just submitted the same text. Edit the prompt or wait for the previous run to finish.',
              }),
            });
            return;
          }
        }
      }
    }
    if (!window.codesign) {
      const msg = tr('errors.rendererDisconnected');
      set({ errorMessage: msg, lastError: msg });
      return;
    }
    const cfg = get().config;
    if (!isReadyConfig(cfg)) {
      // Give the user something actionable instead of "Onboarding is not
      // complete." In practice the common path here is "imported a provider
      // but no key" — see runImportClaudeCode for the local-proxy /
      // remote-gateway branches that intentionally create an entry without
      // a key. Tell them which provider is missing a key and where to fix it.
      const msg =
        cfg?.provider != null && cfg.provider.length > 0
          ? tr('errors.providerMissingKey', { provider: cfg.provider })
          : tr('errors.onboardingIncomplete');
      set({ errorMessage: msg, lastError: msg });
      // Also push a toast with a one-click path to the fix. Toast-only UI
      // actions would be lossy (the toast auto-dismisses after 5s), so we
      // keep the inline errorMessage string in state too.
      get().pushToast({
        variant: 'error',
        title: msg,
        action: {
          label: tr('settings.providers.import.claudeCodeOpenSettings'),
          onClick: () => get().setView('settings'),
        },
      });
      return;
    }

    // F1: pre-flight OAuth expiry warning. The active provider's secret
    // may be an OAuth token with a known expiresAt. If we're inside the
    // 5-minute soft-warn window (or already past expiry), surface an
    // info toast BEFORE the request goes out so the user has a chance to
    // re-import or re-auth instead of losing 2-15 minutes to a 401
    // mid-stream. Skipped on auto-retry paths (the user already saw the
    // first attempt's warning) and when expiresAt is null (static API
    // keys). The retry-on-truncated-stream path also skips this since
    // the original surfaced any warning that mattered.
    if (cfg.activeKeyExpiresAt !== null && input.silent !== true && input._autoRetried !== true) {
      const msToExpiry = cfg.activeKeyExpiresAt - Date.now();
      if (msToExpiry < 5 * 60 * 1000) {
        // Past expiry: error-level. Within 5 min: info-level so the
        // run can still proceed (the agent runtime auto-refreshes when
        // the refresh token + clientId are available).
        const minutesLeft = Math.max(0, Math.ceil(msToExpiry / 60_000));
        get().pushToast({
          variant: msToExpiry <= 0 ? 'error' : 'info',
          title:
            msToExpiry <= 0
              ? tr('notifications.oauthExpiredTitle')
              : tr('notifications.oauthExpiringTitle'),
          description:
            msToExpiry <= 0
              ? tr('notifications.oauthExpiredBody')
              : tr('notifications.oauthExpiringBody', { minutes: String(minutesLeft) }),
        });
      }
    }

    // Prompt-assist intercept (backlog-1 #9): a sub-120-char prompt with no
    // existing per-design constraints leaves the model guessing audience /
    // device / vibe / a11y. Open the chip dialog FIRST, then let
    // resolvePromptAssist re-call sendPrompt with skipPromptAssist=true.
    // Skip when silent (auto-polish/retry paths), when no design is bound
    // yet, or when the design already has metadata.
    if (
      input.silent !== true &&
      input.skipPromptAssist !== true &&
      input.prompt.trim().length > 0 &&
      input.prompt.trim().length < 120
    ) {
      const designId = get().currentDesignId;
      if (designId !== null) {
        const design = get().designs.find((d) => d.id === designId);
        const hasMetadata =
          design?.promptAssistMetadata !== undefined && design.promptAssistMetadata !== null;
        if (!hasMetadata) {
          set({
            promptAssistPending: {
              designId,
              input: {
                prompt: input.prompt,
                ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
                ...(input.referenceUrl !== undefined ? { referenceUrl: input.referenceUrl } : {}),
              },
            },
          });
          return;
        }
      }
    }

    // Pending edit chips let the user submit with an empty prompt — we
    // substitute a default trailer so buildPromptRequest still passes.
    const pendingEdits = get().comments.filter((c) => c.kind === 'edit' && c.status === 'pending');
    const trimmedInput = input.prompt.trim();

    // Slash-command parser: `/jsx` / `/vanilla` set the artifact pattern,
    // `/help` short-circuits with a help message and skips generation.
    // Auto-polish + retry paths supply silent prompts; skip slash parsing
    // for them so an internal "[auto-continue]" prompt can't accidentally
    // start with `/something`.
    const parsedCmd =
      input.silent || trimmedInput.length === 0
        ? { prompt: trimmedInput }
        : parsePromptCommand(trimmedInput);
    if (parsedCmd.showHelp) {
      const designIdForHelp = get().currentDesignId;
      if (designIdForHelp) {
        void get().appendChatMessage({
          designId: designIdForHelp,
          kind: 'user',
          payload: { text: trimmedInput },
        });
        void get().appendChatMessage({
          designId: designIdForHelp,
          kind: 'assistant_text',
          payload: { text: PROMPT_COMMAND_HELP },
        });
      } else {
        get().pushToast({
          variant: 'info',
          title: 'Slash commands',
          description: 'Type /jsx, /vanilla, or /help.',
        });
      }
      return;
    }
    const promptForRequest = parsedCmd.prompt;
    const requestedPattern: ArtifactPattern | undefined = parsedCmd.pattern;
    if (promptForRequest.length === 0 && pendingEdits.length === 0) return;
    // Auto-detected pattern: surface a brief toast so the user understands
    // why their default JSX got bumped to vanilla. Manual /vanilla skips
    // this — they already know what they asked for.
    if (parsedCmd.patternSource === 'auto' && requestedPattern === 'vanilla') {
      get().pushToast({
        variant: 'info',
        title: 'Multi-file mode auto-selected',
        description:
          'Detected a complex brief (3D / shader / audio / physics). Building as multi-file vanilla. Override with /jsx if you want the single-file pattern instead.',
      });
    }
    const effectivePrompt =
      promptForRequest.length === 0 ? 'Apply the pending changes.' : promptForRequest;

    const request = buildPromptRequest(
      { ...input, prompt: effectivePrompt },
      get().inputFiles,
      get().referenceUrl,
    );
    if (!request) return;

    const enrichedPrompt = buildEnrichedPrompt(request.prompt, pendingEdits);
    const pendingEditIds = pendingEdits.map((c) => c.id);

    const generationId = newId();
    const designIdAtStart = get().currentDesignId;
    set(() => ({
      isGenerating: true,
      activeGenerationId: generationId,
      generatingDesignId: designIdAtStart,
      generationStage: 'sending',
      streamingAssistantText: null,
      streamingThinking: null,
      streamingToolDraft: null,
      streamingToolResults: {},
      previewUpdatedAt: null,
      previewReloadTick: 0,
      errorMessage: null,
      lastPromptInput: request,
      selectedElement: null,
      iframeErrors: [],
    }));

    // Cap cross-generate history to the most recent turns. The agent re-reads
    // the current HTML via text_editor.view() when needed, so older prose in
    // history offers diminishing value and pushes us toward the token ceiling.
    const HISTORY_CAP = 12;
    // chat_messages is the single source of truth for agent history. Fixes
    // the race where a broken session + "继续" made the agent see a stale or
    // empty history from a legacy mirror and drift off-task.
    const fullHistory = await buildHistoryFromChat(designIdAtStart);
    const history = capHistoryToTurnBoundary(fullHistory, HISTORY_CAP);
    const isFirstPrompt = fullHistory.length === 0;
    // Iteration cue — only set when there's already prior history AND the
    // user typed a real prompt (skip silent auto-polish refinements).
    set({ currentRunIsRefinement: !isFirstPrompt && !input.silent });

    // Append to the new chat_messages table so Sidebar v2 reflects activity
    // even before Workstream B starts emitting streaming tool events. Silent
    // prompts (auto-polish) skip this and the auto-rename: the agent still
    // receives the prompt through runGenerate, but the chat UI reads as one
    // continuous run instead of a second user bubble.
    if (designIdAtStart && !input.silent) {
      void get().appendChatMessage({
        designId: designIdAtStart,
        kind: 'user',
        payload: { text: request.prompt },
      });
    }

    if (!input.silent) {
      triggerAutoRenameIfFirst(get, isFirstPrompt, request.prompt);
    }

    // TODO: replace with rendererLogger once renderer-logger lands
    console.debug('[store] sendPrompt', {
      generationId,
      designId: designIdAtStart,
      promptLen: enrichedPrompt.length,
    });

    try {
      // gameplan §A6 — pull and clear the pending mode/engine the dialog
      // staged. They route into the IPC payload so the main process
      // composes the game-mode prompt + wires deps.gameMode.
      let pendingMode = get().pendingArtifactMode;
      const pendingEngine = get().pendingGameEngine;
      get().clearPendingGameSelection();
      // Auto-route game-genre prompts (FPS / wave defense / platformer /
      // etc.) into game-mode when the user didn't explicitly pick a
      // mode via NewDesignDialog. Without this, prompts like "create a
      // first-person shooter wave defense" land in design-mode JSX with
      // no engine guidance — the model burns its output budget reasoning
      // about which engine + scene structure and frequently never emits
      // a tool call (2026-05-06 FPS run hit max_tokens with 0 tools).
      // Manual NewDesignDialog selection still wins because we only
      // promote when `pendingMode` is null. The chosen engine is
      // undefined here — the agent's `choose_engine` tool resolves it
      // on the first turn.
      if (
        pendingMode === null &&
        pendingEngine === null &&
        get().currentDesignEngine === null &&
        detectGameModeFromPrompt(parsedCmd.prompt)
      ) {
        pendingMode = 'game';
        rendererLogger.info('store', 'auto-routed prompt to game-mode', {
          generationId,
          prompt: parsedCmd.prompt.slice(0, 80),
        });
      }
      // A6.x — surface the engine on the active design immediately so
      // PreviewPane can switch to game-files:// resolution + the toolbar
      // can render engine-specific chrome (Godot build button, future
      // aspect presets) before the first snapshot lands. Falls back to
      // the existing currentDesignEngine when starting a follow-up turn
      // on an existing design (no fresh dialog selection).
      if (pendingEngine !== null) set({ currentDesignEngine: pendingEngine });
      await runGenerate(
        get,
        set,
        generationId,
        {
          prompt: enrichedPrompt,
          history,
          model: modelRef(cfg.provider, cfg.modelPrimary),
          ...(request.referenceUrl ? { referenceUrl: request.referenceUrl } : {}),
          attachments: request.attachments,
          generationId,
          ...(designIdAtStart ? { designId: designIdAtStart } : {}),
          ...(get().previewHtml ? { previousHtml: get().previewHtml as string } : {}),
          ...(requestedPattern ? { pattern: requestedPattern } : {}),
          ...(pendingMode !== null ? { artifactMode: pendingMode } : {}),
          ...(pendingEngine !== null ? { gameEngine: pendingEngine } : {}),
        },
        designIdAtStart,
      );
      // After a successful generate, persistDesignState (called inside
      // applyGenerateSuccess) creates the new snapshot and updates
      // currentSnapshotId via loadCommentsForCurrentDesign. Mark any pending
      // edits that rode along as applied to the newest snapshot, so the pin
      // overlay + chips flip state consistently with the new preview.
      if (pendingEditIds.length > 0 && designIdAtStart && window.codesign) {
        try {
          // Retry fetching the newest snapshot — persistDesignState runs
          // asynchronously, so the snapshot may not be available immediately.
          let appliedIn: string | null = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise((r) => setTimeout(r, attempt * 50));
            const snaps = await window.codesign.snapshots.list(designIdAtStart);
            if (snaps.length > 0 && snaps[0]?.id) {
              appliedIn = snaps[0].id;
              break;
            }
          }
          if (appliedIn) {
            const updated = await window.codesign.comments.markApplied(pendingEditIds, appliedIn);
            if (get().currentDesignId === designIdAtStart && updated.length > 0) {
              set((s) => ({
                comments: s.comments.map((c) => updated.find((u) => u.id === c.id) ?? c),
                currentSnapshotId: appliedIn,
              }));
            }
          }
        } catch (err) {
          console.warn('[open-codesign] markApplied failed:', err);
        }
      }
    } catch (err) {
      // B1: auto-retry on transient stream cut. When (1) the upstream cut
      // mid-stream, (2) the run produced ZERO useful turns (no tool_call
      // landed in chat for the design), and (3) we haven't already
      // retried, re-issue the same prompt once. This makes the most-
      // common 1-in-N "wasted run" failure mode invisible. We don't retry
      // when ANY tool call landed because partial state would either
      // duplicate work or stomp valid edits.
      const errMsg = err instanceof Error ? err.message : String(err);
      const transient = looksLikeTruncatedStream(errMsg);
      const designId = designIdAtStart ?? get().currentDesignId;
      let producedToolCall = false;
      if (designId) {
        // Count tool_calls in chat that came AFTER the most recent user
        // message of this run. If there are none, the run was 0-progress.
        const msgs = get().chatMessages.filter((m) => m.designId === designId);
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          const m = msgs[i];
          if (!m) continue;
          if (m.kind === 'user') break;
          if (m.kind === 'tool_call') {
            producedToolCall = true;
            break;
          }
        }
      }
      const canAutoRetry = transient && !producedToolCall && input._autoRetried !== true;
      if (canAutoRetry) {
        // Surface the retry attempt as a low-key info toast so the user
        // sees what's happening but doesn't get a scary error first.
        get().pushToast({
          variant: 'info',
          title: tr('notifications.transientRetryTitle'),
          description: tr('notifications.transientRetryBody'),
        });
        // Reset isGenerating flags so the retry can claim them.
        set({
          isGenerating: false,
          generatingDesignId: null,
          generationStage: 'idle' as GenerationStage,
          activeGenerationId: null,
        });
        try {
          await get().sendPrompt({
            ...input,
            _autoRetried: true,
            // Suppress the chat user-bubble on retry — the original is
            // already visible. Same intent as the polish path.
            silent: true,
          });
          return;
        } catch (retryErr) {
          // Fall through to the normal error path with the retry's error
          // (more accurate than re-surfacing the original).
          applyGenerateError(get, set, generationId, retryErr, designIdAtStart);
          return;
        }
      }
      applyGenerateError(get, set, generationId, err, designIdAtStart);
    }
  },

  cancelGeneration(asCheckpoint = false) {
    recordAction({ type: 'prompt.cancel' });
    const id = get().activeGenerationId;
    if (!id) return;
    // Backlog-3 §5 — when the user opts to cancel-with-checkpoint,
    // append a chat_messages row marking the cancel point with enough
    // context for a Resume CTA. The row carries turn count, elapsed
    // ms, last assistant text preview, and the designId so the
    // checkpoint survives across app restarts.
    if (asCheckpoint) {
      const designId = get().generatingDesignId;
      const turnCount = get().agentLiveness?.turnCount ?? 0;
      const lastAssistantText = (get().streamingAssistantText?.text ?? '').slice(0, 200);
      const startedAt = get().agentLiveness?.lastTurnStartAt ?? Date.now();
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      if (designId !== null) {
        void get().appendChatMessage({
          designId,
          kind: 'checkpoint',
          payload: {
            schemaVersion: 1,
            generationId: id,
            turnCount,
            elapsedMs,
            lastAssistantText,
            createdAt: Date.now(),
          },
        });
      }
    }
    if (!window.codesign) {
      const msg = tr('errors.rendererDisconnected');
      set({ errorMessage: msg, lastError: msg });
      get().pushToast({
        variant: 'error',
        title: tr('notifications.cancellationFailed'),
        description: msg,
        localId: get().createReportableError({
          code: 'CANCEL_FAILED',
          scope: 'generate',
          message: msg,
          runId: id,
        }),
      });
      return;
    }

    void window.codesign
      .cancelGeneration(id, asCheckpoint ? { asCheckpoint: true } : undefined)
      .then(() => {
        finishIfCurrent(set, id, () => ({
          isGenerating: false,
          activeGenerationId: null,
          currentRunIsRefinement: false,
          generatingDesignId: null,
          streamingAssistantText: null,
          streamingThinking: null,
          streamingToolDraft: null,
          streamingToolResults: {},
          previewUpdatedAt: null,
          previewReloadTick: 0,
          generationStage: 'idle' as GenerationStage,
        }));
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : tr('errors.unknown');
        set({ errorMessage: msg, lastError: msg });
        get().pushToast({
          variant: 'error',
          title: tr('notifications.cancellationFailed'),
          description: msg,
          localId: get().createReportableError({
            code: 'CANCEL_FAILED',
            scope: 'generate',
            message: msg,
            ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
            runId: id,
          }),
        });
      });
  },

  async resumeFromCheckpoint() {
    // Backlog-3 §5 — fire a "continue" prompt with the existing
    // history. The agent picks up where it left off because the chat
    // transcript already contains every prior tool call + assistant
    // text. We tag the prompt so logs can correlate resume runs.
    if (get().isGenerating) return;
    const designId = get().currentDesignId;
    if (designId === null) return;
    await get().sendPrompt({
      prompt:
        '[resume] Continue from the last checkpoint. Pick up where you left off — review the prior tool transcript, identify any unfinished items, and proceed.',
    });
  },

  async requestWrapUp() {
    const id = get().activeGenerationId;
    if (!id) return;
    const api = window.codesign;
    if (!api?.requestWrapUp) return;
    try {
      const result = await api.requestWrapUp(id);
      if (result.queued) {
        get().pushToast({
          variant: 'info',
          title: 'Wrap-up queued',
          description: 'Agent will converge to done at the next turn boundary.',
        });
      } else {
        get().pushToast({
          variant: 'info',
          title: 'Nothing to wrap up',
          description: 'No active generation to steer.',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: 'Wrap-up failed',
        description: msg,
      });
    }
  },

  async requestNewSession(): Promise<number | null> {
    const state = get();
    const designId = state.currentDesignId;
    if (designId === null) return null;
    if (state.isGenerating) {
      get().pushToast({
        variant: 'info',
        title: tr('chat.newSession.blocked.title'),
        description: tr('chat.newSession.blocked.description'),
      });
      return null;
    }
    const api = window.codesign;
    const newSessionFn = api?.chat?.newSession;
    if (typeof newSessionFn !== 'function') {
      get().pushToast({
        variant: 'error',
        title: tr('chat.newSession.failed.title'),
        description: 'IPC bridge unavailable',
      });
      return null;
    }
    try {
      const result = await newSessionFn(designId);
      // Reset per-run liveness/usage so the chat status header (which
      // renders run-health, token cost, and turn count) starts at zero
      // for the fresh conversation. Chat rows themselves stay in
      // memory — the UI shows past sessions above a divider — but new
      // generations no longer pay token cost for them because the
      // history-builder filters by sessionId.
      set({
        agentLiveness: null,
        lastUsage: null,
        pendingToolCalls: [],
        streamingAssistantText: null,
        streamingThinking: null,
        streamingToolDraft: null,
        streamingToolResults: {},
        errorMessage: null,
        currentChatSessionId: result.sessionId,
      });
      get().pushToast({
        variant: 'info',
        title: tr('chat.newSession.success.title'),
        description: tr('chat.newSession.success.description'),
      });
      return result.sessionId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('chat.newSession.failed.title'),
        description: msg,
      });
      return null;
    }
  },

  async retryLastPrompt() {
    const lastPromptInput = get().lastPromptInput;
    if (!lastPromptInput) return;
    set({ errorMessage: null });
    await get().sendPrompt(lastPromptInput);
  },

  async applyInlineComment(comment) {
    const trimmed = comment.trim();
    if (!trimmed || get().isGenerating) return;
    if (!window.codesign) return;
    const cfg = get().config;
    const html = get().previewHtml;
    const selection = get().selectedElement;
    if (cfg === null || !cfg.hasKey || html === null || selection === null) return;

    const userMessageText = `Edit ${selection.tag}: ${trimmed}`;
    const referenceUrl = normalizeReferenceUrl(get().referenceUrl);
    const attachments = uniqueFiles(get().inputFiles);
    const designIdAtStart = get().currentDesignId;

    set(() => ({
      isGenerating: true,
      generatingDesignId: designIdAtStart,
      errorMessage: null,
      iframeErrors: [],
    }));

    if (designIdAtStart) {
      void get().appendChatMessage({
        designId: designIdAtStart,
        kind: 'user',
        payload: { text: userMessageText },
      });
    }

    // Subscribe to streaming text deltas from the apply-comment IPC. Each
    // delta is appended to streamingAssistantText so the chat sidebar shows
    // an ephemeral bubble that grows as the model emits HTML — same UX as
    // the agent path's text_delta handling. Unsubscribed in finally so we
    // don't leak listeners on error.
    let streamingBuffer = '';
    const offApplyCommentEvent = window.codesign.chat.onApplyCommentEvent((event) => {
      if (designIdAtStart === null) return;
      if (event.kind === 'text_delta' && typeof event.delta === 'string') {
        streamingBuffer += event.delta;
        get().setStreamingAssistantText({ designId: designIdAtStart, text: streamingBuffer });
      } else if (event.kind === 'done') {
        // Final assistant_text row will replace the ephemeral bubble below
        // when the await resolves. Clearing here is just defensive in case
        // appendChatMessage races the listener removal.
        get().setStreamingAssistantText(null);
      }
    });

    try {
      const result = await window.codesign.applyComment({
        html,
        comment: trimmed,
        selection,
        ...(referenceUrl ? { referenceUrl } : {}),
        attachments,
      });
      const firstArtifact = result.artifacts[0];
      const assistantText = result.message || tr('common.applied');
      const { usage, rejected: rejectedUsageFields } = coerceUsageSnapshot(result);
      set((s) => {
        const nextHtml = firstArtifact?.content ?? s.previewHtml;
        const pool =
          s.currentDesignId !== null && nextHtml !== null
            ? recordPreviewInPool(
                s.previewHtmlByDesign,
                s.recentDesignIds,
                s.currentDesignId,
                nextHtml,
              )
            : { cache: s.previewHtmlByDesign, recent: s.recentDesignIds };
        return {
          previewHtml: nextHtml,
          previewHtmlByDesign: pool.cache,
          recentDesignIds: pool.recent,
          isGenerating: false,
          currentRunIsRefinement: false,
          generatingDesignId: null,
          selectedElement: null,
          lastUsage: usage,
        };
      });
      if (designIdAtStart) {
        void get().appendChatMessage({
          designId: designIdAtStart,
          kind: 'assistant_text',
          payload: { text: assistantText },
        });
        const artifact = artifactFromResult(firstArtifact, userMessageText, assistantText);
        void persistDesignState(get, designIdAtStart, get().previewHtml, artifact);
      }
      if (rejectedUsageFields.length > 0) {
        const detail = rejectedUsageFields.join(', ');
        console.warn('[open-codesign] dropped non-finite usage values from provider:', detail);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      set(() => ({
        isGenerating: false,
        currentRunIsRefinement: false,
        generatingDesignId: null,
        errorMessage: msg,
        lastError: msg,
      }));
      if (designIdAtStart) {
        void get().appendChatMessage({
          designId: designIdAtStart,
          kind: 'error',
          payload: { message: msg },
        });
      }
      get().pushToast({
        variant: 'error',
        title: tr('notifications.inlineCommentFailed'),
        description: msg,
      });
    } finally {
      offApplyCommentEvent();
      get().setStreamingAssistantText(null);
    }
  },

  clearError() {
    set({ errorMessage: null });
  },

  async exportActive(format: ExportFormat) {
    recordAction({ type: 'design.export', data: { format } });
    const html = get().previewHtml;
    if (!html) {
      set({ toastMessage: tr('notifications.noDesignToExport') });
      return;
    }
    if (!window.codesign) {
      set({ errorMessage: tr('errors.rendererDisconnected') });
      return;
    }
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = format === 'markdown' ? 'md' : format;
      const designId = get().currentDesignId;
      const res = await window.codesign.export({
        format,
        htmlContent: html,
        defaultFilename: `codesign-${stamp}.${ext}`,
        // Forward designId so main can pull sibling files (vanilla
        // pattern's CSS/JS, assets/*) into the zip. Other formats
        // ignore this field.
        ...(designId ? { designId } : {}),
      });
      if (res.status === 'saved' && res.path) {
        set({ toastMessage: tr('notifications.exportedTo', { path: res.path }) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      set({ toastMessage: msg, errorMessage: msg, lastError: msg });
    }
  },

  selectCanvasElement(selection) {
    set({ selectedElement: selection });
  },

  clearCanvasElement() {
    set({ selectedElement: null });
  },

  setPreviewZoom(zoom) {
    set({ previewZoom: zoom });
  },

  setInteractionMode(mode) {
    if (mode === 'default') {
      set({
        interactionMode: mode,
        selectedElement: null,
        commentBubble: null,
        skillExtractDraft: null,
      });
    } else {
      set({ interactionMode: mode });
    }
  },

  beginSkillExtract() {
    const state = get();
    const designId = state.currentDesignId;
    const snapshotId = state.currentSnapshotId;
    if (designId === null || snapshotId === null) return false;
    set({
      view: 'workspace',
      interactionMode: 'skill-extract',
      skillExtractDraft: null,
    });
    return true;
  },

  setSkillExtractRect(rect) {
    const state = get();
    const designId = state.currentDesignId;
    const snapshotId = state.currentSnapshotId;
    if (designId === null || snapshotId === null) return;
    set({ skillExtractDraft: { rect, designId, snapshotId } });
  },

  setEditCursor({ toolLabel, startLine, endLine }) {
    const prev = get().editCursor;
    // Bumping `key` (rather than reusing the previous one) is what makes the
    // CSS appear-animation re-trigger when two consecutive edits land on the
    // same DOM element — without it the halo would just sit motionless.
    const nextKey = (prev?.key ?? 0) + 1;
    set({
      editCursor: {
        key: nextKey,
        toolLabel,
        startLine,
        endLine,
        // 1400 ms tracks the visual fade-out window; the overlay component
        // observes this clock and renders nothing once we're past it.
        expiresAt: performance.now() + 1400,
      },
    });
  },

  clearEditCursor() {
    if (get().editCursor !== null) set({ editCursor: null });
  },

  async submitSkillExtract(userPrompt) {
    const draft = get().skillExtractDraft;
    if (draft === null) {
      throw new Error('No skill-extract draft pending');
    }
    if (!window.codesign?.skills) {
      throw new Error('Skills IPC unavailable');
    }
    const skill = await window.codesign.skills.extractFromDesign({
      designId: draft.designId,
      snapshotId: draft.snapshotId,
      rect: draft.rect,
      userPrompt,
    });
    set({ interactionMode: 'default', skillExtractDraft: null });
    return skill;
  },

  cancelSkillExtract() {
    set({ interactionMode: 'default', skillExtractDraft: null });
  },

  setTheme(theme) {
    applyThemeClass(theme);
    persistTheme(theme);
    set({ theme });
  },

  toggleTheme() {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
    get().setTheme(next);
  },

  setView(view) {
    const prev = get().view;
    set({ view, previousView: prev === view ? get().previousView : prev });
  },

  openSettingsTab(tab) {
    const prev = get().view;
    set({
      view: 'settings',
      previousView: prev === 'settings' ? get().previousView : prev,
      settingsTab: tab,
    });
  },

  clearSettingsTab() {
    set({ settingsTab: null });
  },

  setHubTab(tab) {
    set({ hubTab: tab });
  },

  setGameAspect(aspect) {
    set({ gameAspect: aspect });
  },
  setPreviewViewport(viewport) {
    set({ previewViewport: viewport });
  },

  async loadDesigns() {
    if (!window.codesign) return;
    try {
      const designs = await window.codesign.snapshots.listDesigns();
      set({ designs, designsLoaded: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('projects.notifications.loadFailed'),
        description: msg,
      });
      set({ designsLoaded: true });
      throw err instanceof Error ? err : new Error(msg);
    }
  },

  async ensureCurrentDesign() {
    if (!window.codesign) return;
    await get().loadDesigns();
    const designs = get().designs;
    if (get().currentDesignId !== null) return;

    if (designs.length > 0) {
      const first = designs[0];
      if (first) await get().switchDesign(first.id);
      return;
    }
    // No designs exist yet — create the first one silently. The user can
    // rename it later or just send a prompt and we'll auto-name it.
    await get().createNewDesign();
  },

  async createNewDesign(workspacePath?: string | null) {
    if (!window.codesign) return null;
    if (get().isGenerating) {
      // Don't silently drop the request — callers like the Examples flow
      // assume "clicked = new design". A hidden no-op makes the prompt appear
      // to have vanished into the current design instead.
      get().pushToast({
        variant: 'info',
        title: tr('projects.notifications.createFailed'),
        description: tr('projects.notifications.busyGenerating'),
      });
      return null;
    }
    const existingNames = new Set(get().designs.map((d) => d.name));
    let n = 1;
    while (existingNames.has(`Untitled design ${n}`)) n += 1;
    const name = `Untitled design ${n}`;
    try {
      const design = await window.codesign.snapshots.createDesign(name);
      set({
        currentDesignId: design.id,
        previewHtml: null,
        errorMessage: null,
        iframeErrors: [],
        selectedElement: null,
        lastPromptInput: null,
        designsViewOpen: false,
        chatMessages: [],
        chatLoaded: false,
        currentChatSessionId: 0,
        pendingToolCalls: [],
        comments: [],
        commentsLoaded: false,
        commentBubble: null,
        currentSnapshotId: null,
        canvasTabs: [FILES_TAB],
        activeCanvasTab: 0,
      });
      await get().loadDesigns();
      void get().loadChatForCurrentDesign();
      void get().loadCommentsForCurrentDesign();
      if (workspacePath) {
        try {
          await window.codesign.snapshots.updateWorkspace(design.id, workspacePath, false);
          await get().loadDesigns();
        } catch (err) {
          const msg = err instanceof Error ? err.message : tr('errors.unknown');
          get().pushToast({
            variant: 'error',
            title: tr('canvas.workspace.updateFailed'),
            description: msg,
          });
        }
      }
      return design;
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('projects.notifications.createFailed'),
        description: msg,
      });
      return null;
    }
  },

  async switchDesign(id: string) {
    if (!window.codesign) return;
    const state = get();
    if (state.currentDesignId === id) {
      set({ designsViewOpen: false });
      return;
    }

    // Snapshot the OUTGOING design's preview into the pool so that switching
    // back is instant. The cache key is the design id; PreviewPane keeps a
    // hidden iframe per pool entry.
    const outgoingPool =
      state.currentDesignId !== null && state.previewHtml !== null
        ? recordPreviewInPool(
            state.previewHtmlByDesign,
            state.recentDesignIds,
            state.currentDesignId,
            state.previewHtml,
          )
        : { cache: state.previewHtmlByDesign, recent: state.recentDesignIds };

    // Cache hit on the incoming design — render instantly, refresh in the
    // background so any external edits eventually land.
    const cachedHtml = outgoingPool.cache[id];
    if (cachedHtml !== undefined) {
      const incomingPool = recordPreviewInPool(
        outgoingPool.cache,
        outgoingPool.recent,
        id,
        cachedHtml,
      );
      // Commit the visual switch instantly — iframe is already alive in the
      // pool so no reparse cost.
      set({
        currentDesignId: id,
        previewHtml: cachedHtml,
        previewHtmlByDesign: incomingPool.cache,
        recentDesignIds: incomingPool.recent,
        errorMessage: null,
        iframeErrors: [],
        selectedElement: null,
        lastPromptInput: null,
        designsViewOpen: false,
        chatMessages: [],
        chatLoaded: false,
        currentChatSessionId: 0,
        pendingToolCalls: [],
        comments: [],
        commentsLoaded: false,
        commentBubble: null,
        currentSnapshotId: null,
        // Engine state will be refreshed alongside the background snapshot
        // pull below — clear stale state from the previous design first.
        currentDesignEngine: null,
        canvasTabs: [FILES_TAB, { kind: 'file', path: 'index.html' }],
        activeCanvasTab: 1,
      });
      void get().loadChatForCurrentDesign();
      void get().loadCommentsForCurrentDesign();
      void (async () => {
        try {
          const snapshots = await window.codesign?.snapshots.list(id);
          if (!snapshots || get().currentDesignId !== id) return;
          const latest = snapshots[0] ?? null;
          const fresh = latest ? latest.artifactSource : null;
          if (fresh !== null && fresh !== get().previewHtml) {
            const refreshed = recordPreviewInPool(
              get().previewHtmlByDesign,
              get().recentDesignIds,
              id,
              fresh,
            );
            set({
              previewHtml: fresh,
              previewHtmlByDesign: refreshed.cache,
              recentDesignIds: refreshed.recent,
            });
          }
          // Surface the engine pin from the latest snapshot so the toolbar
          // can show the Godot-build button + the preview can switch its
          // src= to game-files://. Setting null on design-mode snapshots is
          // intentional: it hides game-mode chrome.
          set({ currentDesignEngine: latest?.engine ?? null });
        } catch {
          // Background refresh failure is harmless — cached preview remains.
        }
      })();
      return;
    }

    // Cold path — first visit (or evicted from pool). Pay the IPC + parse cost.
    try {
      const snapshots = await window.codesign.snapshots.list(id);
      const latest = snapshots[0] ?? null;
      const html = latest ? latest.artifactSource : null;
      const incomingPool = recordPreviewInPool(outgoingPool.cache, outgoingPool.recent, id, html);
      set({
        currentDesignId: id,
        previewHtml: html,
        previewHtmlByDesign: incomingPool.cache,
        recentDesignIds: incomingPool.recent,
        errorMessage: null,
        iframeErrors: [],
        selectedElement: null,
        lastPromptInput: null,
        designsViewOpen: false,
        chatMessages: [],
        chatLoaded: false,
        currentChatSessionId: 0,
        pendingToolCalls: [],
        comments: [],
        commentsLoaded: false,
        commentBubble: null,
        currentSnapshotId: null,
        currentDesignEngine: latest?.engine ?? null,
        canvasTabs: latest ? [FILES_TAB, { kind: 'file', path: 'index.html' }] : [FILES_TAB],
        activeCanvasTab: latest ? 1 : 0,
      });
      void get().loadChatForCurrentDesign();
      void get().loadCommentsForCurrentDesign();
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('projects.notifications.switchFailed'),
        description: msg,
      });
    }
  },

  async renameCurrentDesign(name: string) {
    const id = get().currentDesignId;
    if (!id) return;
    await get().renameDesign(id, name);
  },

  async renameDesign(id: string, name: string) {
    if (!window.codesign) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await window.codesign.snapshots.renameDesign(id, trimmed);
      await get().loadDesigns();
      set({ designToRename: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('projects.notifications.renameFailed'),
        description: msg,
      });
    }
  },

  async duplicateDesign(id: string) {
    if (!window.codesign) return null;
    const source = get().designs.find((d) => d.id === id);
    if (!source) return null;
    const name = tr('projects.duplicateNameTemplate', { name: source.name });
    try {
      const cloned = await window.codesign.snapshots.duplicateDesign(id, name);
      await get().loadDesigns();
      get().pushToast({
        variant: 'success',
        title: tr('projects.notifications.duplicated', { name: cloned.name }),
      });
      return cloned;
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('projects.notifications.duplicateFailed'),
        description: msg,
      });
      return null;
    }
  },

  async softDeleteDesign(id: string) {
    if (!window.codesign) return;
    if (get().isGenerating) {
      get().pushToast({
        variant: 'info',
        title: tr('projects.notifications.deleteBlockedGenerating'),
      });
      return;
    }
    try {
      await window.codesign.snapshots.softDeleteDesign(id);
      if (get().autoPolishFired.has(id)) {
        const nextFired = new Set(get().autoPolishFired);
        nextFired.delete(id);
        set({ autoPolishFired: nextFired });
      }
      const wasCurrent = get().currentDesignId === id;
      await get().loadDesigns();
      if (wasCurrent) {
        const remaining = get().designs;
        set({
          currentDesignId: null,
          previewHtml: null,
          canvasTabs: [FILES_TAB],
          activeCanvasTab: 0,
        });
        if (remaining.length > 0 && remaining[0]) {
          await get().switchDesign(remaining[0].id);
        } else {
          await get().createNewDesign();
        }
      }
      set({ designToDelete: null });
      get().pushToast({ variant: 'info', title: tr('projects.notifications.deleted') });
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('projects.notifications.deleteFailed'),
        description: msg,
      });
    }
  },

  openDesignsView() {
    void get().loadDesigns();
    set({ designsViewOpen: true });
  },
  closeDesignsView() {
    set({ designsViewOpen: false });
  },
  openNewDesignDialog() {
    set({ newDesignDialogOpen: true });
  },
  setPendingGameSelection(mode, engine) {
    set({
      pendingArtifactMode: mode,
      pendingGameEngine: mode === 'game' ? engine : null,
      lastPickedMode: mode,
    });
    // Persist last-picked mode so the dialog opens to the right tab
    // next launch. preferences.update is fire-and-forget; the in-memory
    // state above is what drives the next generate.
    void window.codesign?.preferences?.update?.({ lastPickedMode: mode })?.catch(() => undefined);
  },
  clearPendingGameSelection() {
    set({ pendingArtifactMode: null, pendingGameEngine: null });
  },
  async buildGodotWebPreview(designId) {
    if (!window.codesign?.godot) return;
    set((s) => ({
      godotBuildStatusByDesign: {
        ...s.godotBuildStatusByDesign,
        [designId]: { status: 'building', phase: 'starting' },
      },
    }));
    // Stream progress lines into the per-design status. Only the most
    // recent phase is kept — the toolbar surfaces it as a one-line label
    // so we don't need a transcript here.
    const off = window.codesign.godot.onBuildProgress((event) => {
      if (event.designId !== designId) return;
      set((s) => {
        const current = s.godotBuildStatusByDesign[designId];
        if (current?.status !== 'building') return s;
        const next = { ...current, phase: event.phase };
        if ('line' in event && typeof event.line === 'string') next.line = event.line;
        return {
          godotBuildStatusByDesign: { ...s.godotBuildStatusByDesign, [designId]: next },
        };
      });
    });
    try {
      const result = await window.codesign.godot.buildWebPreview(designId);
      if (result.ok) {
        set((s) => ({
          godotBuildStatusByDesign: {
            ...s.godotBuildStatusByDesign,
            [designId]: { status: 'ok' },
          },
          godotPreviewByDesign: { ...s.godotPreviewByDesign, [designId]: 'build' },
        }));
        get().pushToast({
          variant: 'success',
          title: tr('preview.godot.buildOk'),
        });
      } else {
        set((s) => ({
          godotBuildStatusByDesign: {
            ...s.godotBuildStatusByDesign,
            [designId]: {
              status: 'failed',
              reason: result.reason ?? 'unknown',
              detail: result.detail ?? '',
            },
          },
        }));
        get().pushToast({
          variant: 'error',
          title: tr('preview.godot.buildFailed'),
          description: result.detail ?? result.reason ?? '',
        });
      }
    } catch (err) {
      set((s) => ({
        godotBuildStatusByDesign: {
          ...s.godotBuildStatusByDesign,
          [designId]: {
            status: 'failed',
            reason: 'exception',
            detail: err instanceof Error ? err.message : String(err),
          },
        },
      }));
    } finally {
      off();
    }
  },
  closeNewDesignDialog() {
    set({ newDesignDialogOpen: false });
  },
  requestDeleteDesign(design) {
    set({ designToDelete: design });
  },
  requestRenameDesign(design) {
    set({ designToRename: design });
  },

  async resolvePromptAssist(picks) {
    const pending = get().promptAssistPending;
    if (pending === null) return;
    const { designId, input: pendingInput } = pending;
    const api = window.codesign?.snapshots?.setPromptAssist;
    if (api !== undefined) {
      try {
        const updated = await api(designId, picks);
        // Patch the in-store design list so the next sendPrompt sees the
        // metadata via the same skip-intercept path the IPC handler uses.
        set((s) => ({
          designs: s.designs.map((d) => (d.id === updated.id ? updated : d)),
        }));
      } catch (err) {
        get().reportableErrorToast({
          code: 'PROMPT_ASSIST_PERSIST_FAILED',
          scope: 'generate',
          title: tr('promptAssist.persistFailed'),
          description: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
        });
        // Don't resume the run — the design state is now inconsistent.
        set({ promptAssistPending: null });
        return;
      }
    }
    set({ promptAssistPending: null });
    await get().sendPrompt({ ...pendingInput, skipPromptAssist: true });
  },

  cancelPromptAssist() {
    set({ promptAssistPending: null });
  },

  requestWorkspaceRebind(design, newPath) {
    // Block workspace changes while the current design is generating
    const state = get();
    if (state.isGenerating && state.generatingDesignId === state.currentDesignId) {
      return;
    }
    set({ workspaceRebindPending: { design, newPath } });
  },

  cancelWorkspaceRebind() {
    set({ workspaceRebindPending: null });
  },

  async confirmWorkspaceRebind(migrateFiles) {
    if (!window.codesign) return;
    const pending = get().workspaceRebindPending;
    if (!pending) return;

    const { design, newPath } = pending;
    try {
      await window.codesign.snapshots.updateWorkspace(design.id, newPath, migrateFiles);
      const updated = await window.codesign.snapshots.listDesigns();
      set({ designs: updated, workspaceRebindPending: null });
      get().pushToast({
        variant: 'success',
        title: tr('canvas.workspace.updated'),
      });
    } catch (err) {
      set({ workspaceRebindPending: null });
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('canvas.workspace.updateFailed'),
        description: msg,
      });
      throw err;
    }
  },

  pushToast(toast) {
    const id = newId();
    // Every error toast without an explicit `localId` gets one here: the
    // Report button must always have a live ReportableError to open,
    // regardless of which error path produced the toast. Callers that want
    // richer context (stack, runId, structured context) should construct
    // the ReportableError explicitly via `createReportableError` first.
    let localId = toast.localId;
    if (toast.variant === 'error' && localId === undefined) {
      localId = get().createReportableError({
        code: 'RENDERER_ERROR',
        scope: 'renderer',
        message: toast.description ?? toast.title,
      });
    }
    const next: Toast = { id, ...toast, ...(localId ? { localId } : {}) };
    set((s) => {
      let toasts = s.toasts;
      // Error toasts are sticky (AUTO_DISMISS_MS.error is null) so they can
      // pile up and cover the preview during a retry storm. Keep them sticky
      // but cap visible errors at 3 by dropping the oldest on overflow.
      if (toast.variant === 'error') {
        const errors = toasts.filter((t) => t.variant === 'error');
        if (errors.length >= 3) {
          const oldestId = errors[0]?.id;
          if (oldestId !== undefined) {
            toasts = toasts.filter((t) => t.id !== oldestId);
          }
        }
      }
      return { toasts: [...toasts, next] };
    });
    return id;
  },

  dismissToast(id?: string) {
    if (id === undefined) {
      set({ toastMessage: null });
      return;
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  reportableErrorToast(spec) {
    if (spec.reportable === false) {
      return get().pushToast({
        variant: 'error',
        title: spec.title,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        ...(spec.action !== undefined ? { action: spec.action } : {}),
      });
    }
    const localId = get().createReportableError({
      code: spec.code,
      scope: spec.scope,
      message: spec.description ?? spec.title,
      ...(spec.stack !== undefined ? { stack: spec.stack } : {}),
      ...(spec.runId !== undefined ? { runId: spec.runId } : {}),
      ...(spec.context !== undefined ? { context: spec.context } : {}),
    });
    return get().pushToast({
      variant: 'error',
      title: spec.title,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.action !== undefined ? { action: spec.action } : {}),
      localId,
    });
  },

  async loadChatForCurrentDesign() {
    if (!window.codesign) return;
    const designId = get().currentDesignId;
    if (!designId) {
      set({ chatMessages: [], chatLoaded: true, currentChatSessionId: 0 });
      return;
    }
    try {
      // Seed existing designs' chat history from snapshots on first open.
      await window.codesign.chat.seedFromSnapshots(designId);
      const [rows, current] = await Promise.all([
        window.codesign.chat.list(designId),
        typeof window.codesign.chat.currentSession === 'function'
          ? window.codesign.chat.currentSession(designId).catch(() => ({ sessionId: 0 }))
          : Promise.resolve({ sessionId: 0 }),
      ]);
      // Guard against a design switch happening while the IPC was in flight —
      // we'd otherwise render the previous design's chat into the new one.
      if (get().currentDesignId !== designId) return;
      set({ chatMessages: rows, chatLoaded: true, currentChatSessionId: current.sessionId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      console.warn('[open-codesign] loadChatForCurrentDesign failed:', msg);
      set({ chatLoaded: true });
    }
  },

  async appendChatMessage(input: ChatAppendInput) {
    if (!window.codesign) return null;
    try {
      const row = await window.codesign.chat.append(input);
      // Only merge into state if the append belongs to the current design —
      // a background append to a previous design must not pollute the view.
      if (get().currentDesignId === input.designId) {
        set((s) => ({ chatMessages: [...s.chatMessages, row] }));
      }
      return row;
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      console.warn('[open-codesign] appendChatMessage failed:', msg);
      return null;
    }
  },

  clearChatLocal() {
    set({ chatMessages: [], chatLoaded: false, currentChatSessionId: 0 });
  },

  async switchChatSession(sessionId: number) {
    if (!window.codesign) return false;
    const designId = get().currentDesignId;
    if (!designId || get().isGenerating) return false;
    if (sessionId === get().currentChatSessionId) return true;
    const setSession = window.codesign.chat.setSession;
    if (typeof setSession !== 'function') return false;
    try {
      const result = await setSession(designId, sessionId);
      set({
        currentChatSessionId: result.sessionId,
        agentLiveness: null,
        lastUsage: null,
        pendingToolCalls: [],
        streamingAssistantText: null,
        streamingThinking: null,
        streamingToolDraft: null,
        streamingToolResults: {},
        errorMessage: null,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('chat.newSession.switchFailed.title'),
        description: msg,
      });
      return false;
    }
  },

  setStreamingAssistantText(value) {
    set({ streamingAssistantText: value });
  },

  setStreamingThinking(value) {
    set({ streamingThinking: value });
  },

  setStreamingToolDraft(value) {
    set({ streamingToolDraft: value });
  },

  patchStreamingToolResult(toolCallId, patch) {
    if (toolCallId.length === 0) return;
    set((s) => {
      // null patch = drain (close + remove the entry).
      if (patch === null) {
        if (!Object.hasOwn(s.streamingToolResults, toolCallId)) return {};
        const next = { ...s.streamingToolResults };
        delete next[toolCallId];
        return { streamingToolResults: next };
      }
      const prev = s.streamingToolResults[toolCallId] ?? {};
      return {
        streamingToolResults: {
          ...s.streamingToolResults,
          [toolCallId]: {
            ...prev,
            ...patch,
          },
        },
      };
    });
  },

  setPreviewUpdatedAt(value) {
    set({ previewUpdatedAt: value });
  },

  bumpPreviewReload() {
    set((s) => ({ previewReloadTick: s.previewReloadTick + 1 }));
  },

  pushPendingToolCall(designId, call) {
    if (get().currentDesignId !== designId) return;
    set((s) => ({ pendingToolCalls: [...s.pendingToolCalls, call] }));
  },

  resolvePendingToolCall(designId, toolName, result, durationMs) {
    const s = get();
    const idx = s.pendingToolCalls.findIndex(
      (c) => c.toolName === toolName && c.status === 'running',
    );
    const resolved = idx >= 0 ? s.pendingToolCalls[idx] : null;
    // Remove from pending
    if (idx >= 0) {
      const next = [...s.pendingToolCalls];
      next.splice(idx, 1);
      set({ pendingToolCalls: next });
    }
    // Persist the completed tool call to SQLite
    if (resolved) {
      void get().appendChatMessage({
        designId,
        kind: 'tool_call',
        payload: {
          ...resolved,
          status: 'done' as const,
          ...(result !== undefined ? { result } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      });
    }
  },

  async updateChatToolStatus({ designId, seq, status, result, durationMs, errorMessage }) {
    if (!window.codesign) return;
    try {
      await window.codesign.chat.updateToolStatus({
        designId,
        seq,
        status,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.warn('[open-codesign] updateChatToolStatus failed:', msg);
      return;
    }
    // Mirror the patch into local chatMessages so WorkingCard re-renders
    // immediately without waiting for a list reload.
    if (get().currentDesignId !== designId) return;
    set((s) => ({
      chatMessages: s.chatMessages.map((m) => {
        if (m.designId !== designId || m.seq !== seq || m.kind !== 'tool_call') return m;
        const prev = (m.payload as ChatToolCallPayload | null) ?? null;
        if (!prev) return m;
        const nextPayload: ChatToolCallPayload = {
          ...prev,
          status,
          ...(result !== undefined ? { result } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(errorMessage !== undefined ? { error: { message: errorMessage } } : {}),
        };
        return { ...m, payload: nextPayload };
      }),
    }));
  },

  setPreviewHtmlFromAgent({ designId, content }) {
    const state = get();
    // Only adopt the live html when the event's design matches what the user
    // is looking at OR what is actively generating. This prevents a background
    // run on design A from blowing away the preview while the user has switched
    // to design B.
    if (state.currentDesignId !== designId && state.generatingDesignId !== designId) {
      // The event's design isn't visible — still update its pool entry so
      // switching back later reflects the streamed-in HTML.
      const pool = recordPreviewInPool(
        state.previewHtmlByDesign,
        state.recentDesignIds,
        designId,
        content,
      );
      set({ previewHtmlByDesign: pool.cache, recentDesignIds: pool.recent });
      return;
    }
    const pool = recordPreviewInPool(
      state.previewHtmlByDesign,
      state.recentDesignIds,
      designId,
      content,
    );
    set({
      previewHtml: content,
      previewHtmlByDesign: pool.cache,
      recentDesignIds: pool.recent,
    });
  },

  setPreviewHtml(content: string) {
    const state = get();
    if (state.currentDesignId === null) {
      set({ previewHtml: content });
      return;
    }
    const pool = recordPreviewInPool(
      state.previewHtmlByDesign,
      state.recentDesignIds,
      state.currentDesignId,
      content,
    );
    set({
      previewHtml: content,
      previewHtmlByDesign: pool.cache,
      recentDesignIds: pool.recent,
    });
  },

  async persistAgentRunSnapshot({ designId, finalText }) {
    if (!window.codesign) return;
    const state = get();
    // Don't write a snapshot if the run produced nothing renderable, or if
    // the user has already navigated to a different design (we'd persist the
    // wrong html otherwise).
    if (state.currentDesignId !== designId) return;
    const html = state.previewHtml;
    if (!html || html.trim().length === 0) return;
    // Guard against persisting truncated artifacts. When an agent run is
    // interrupted mid-edit (context explosion, 400 response, cancel, crash),
    // the virtual-FS has a partial JSX file that would overwrite the last
    // good snapshot and render as a blank card in the hub. Require a
    // ReactDOM.createRoot mount call + roughly balanced braces; if missing,
    // keep the last good snapshot and warn the user.
    if (!looksRunnableArtifact(html)) {
      get().pushToast({
        variant: 'info',
        title: tr('projects.notifications.snapshotSkipped'),
        description: tr('projects.notifications.snapshotSkippedBody'),
      });
      return;
    }
    // The "prompt" associated with this snapshot is the most recent user
    // message in the chat — that is what the agent was answering.
    const lastUser = [...state.chatMessages].reverse().find((m) => m.kind === 'user');
    const prompt = (lastUser?.payload as { text?: string } | undefined)?.text ?? null;
    const artifact: PersistArtifact = {
      type: 'html',
      content: html,
      prompt,
      message: finalText && finalText.length > 0 ? finalText : null,
    };
    try {
      const newSnapshotId = await persistArtifactSnapshot(designId, artifact);
      // Refresh the design list so the hub thumbnail / updated_at land on
      // disk for the next ensureCurrentDesign() boot.
      await get().loadDesigns();
      if (newSnapshotId && get().currentDesignId === designId) {
        set({ currentSnapshotId: newSnapshotId });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('projects.notifications.saveFailed'),
        description: msg,
      });
    }
  },

  setSidebarCollapsed(collapsed: boolean) {
    set({ sidebarCollapsed: collapsed });
  },

  async loadCommentsForCurrentDesign() {
    if (!window.codesign) return;
    const designId = get().currentDesignId;
    if (!designId) {
      set({ comments: [], commentsLoaded: true, currentSnapshotId: null });
      return;
    }
    try {
      const [rows, snaps] = await Promise.all([
        window.codesign.comments.list(designId),
        window.codesign.snapshots.list(designId),
      ]);
      if (get().currentDesignId !== designId) return;
      set({
        comments: rows,
        commentsLoaded: true,
        currentSnapshotId: snaps[0]?.id ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      console.warn('[open-codesign] loadCommentsForCurrentDesign failed:', msg);
      set({ commentsLoaded: true });
    }
  },

  openCommentBubble(anchor) {
    set({ commentBubble: anchor });
  },

  closeCommentBubble() {
    set({ commentBubble: null });
  },

  applyLiveRects(entries) {
    if (entries.length === 0) return;
    set((s) => {
      const next = { ...s.liveRects };
      for (const { selector, rect } of entries) {
        next[selector] = rect;
      }
      return { liveRects: next };
    });
  },

  clearLiveRects() {
    set({ liveRects: {} });
  },

  async addComment(input) {
    if (!window.codesign) return null;
    const designId = get().currentDesignId;
    if (!designId) return null;
    // Pin comments to the current snapshot so pin overlays only surface for
    // the snapshot the user was viewing when the click happened.
    let snapshotId: string | null = get().currentSnapshotId;
    if (!snapshotId) {
      try {
        const snaps = await window.codesign.snapshots.list(designId);
        snapshotId = snaps[0]?.id ?? null;
        if (snapshotId) set({ currentSnapshotId: snapshotId });
      } catch (err) {
        console.warn('[open-codesign] addComment: failed to look up latest snapshot', err);
      }
    }
    if (!snapshotId) {
      get().pushToast({
        variant: 'error',
        title: tr('notifications.commentNeedsSnapshot'),
      });
      return null;
    }
    try {
      const row = await window.codesign.comments.add({
        designId,
        snapshotId,
        kind: input.kind,
        selector: input.selector,
        tag: input.tag,
        outerHTML: input.outerHTML,
        rect: input.rect,
        text: input.text,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.parentOuterHTML ? { parentOuterHTML: input.parentOuterHTML } : {}),
      });
      if (get().currentDesignId === designId) {
        set((s) => ({ comments: [...s.comments, row] }));
      }
      return row;
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('notifications.commentCreateFailed'),
        description: msg,
      });
      return null;
    }
  },

  async updateComment(id, patch) {
    if (!window.codesign) return null;
    try {
      const updated = await window.codesign.comments.update(id, patch);
      if (!updated) return null;
      set((s) => ({
        comments: s.comments.map((c) => (c.id === id ? updated : c)),
      }));
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('notifications.commentUpdateFailed'),
        description: msg,
      });
      return null;
    }
  },

  async submitComment(input) {
    // Route by presence of existingCommentId. The anchor on a reopened chip
    // carries the id, so editing text hits updateComment (no duplicate row);
    // a fresh click in comment mode falls through to addComment. Both return
    // the row on success so the bubble can decide whether to close.
    if (input.existingCommentId) {
      return get().updateComment(input.existingCommentId, { text: input.text });
    }
    const payload: Parameters<CodesignState['addComment']>[0] = {
      kind: input.kind,
      selector: input.selector,
      tag: input.tag,
      outerHTML: input.outerHTML,
      rect: input.rect,
      text: input.text,
    };
    if (input.scope) payload.scope = input.scope;
    if (input.parentOuterHTML) payload.parentOuterHTML = input.parentOuterHTML;
    return get().addComment(payload);
  },

  async removeComment(id) {
    if (!window.codesign) return;
    try {
      await window.codesign.comments.remove(id);
      set((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : tr('errors.unknown');
      get().pushToast({
        variant: 'error',
        title: tr('notifications.commentDeleteFailed'),
        description: msg,
      });
    }
  },

  openCanvasFileTab(path: string) {
    set((s) => {
      const result = openFileTab(s.canvasTabs, path);
      return { canvasTabs: result.tabs, activeCanvasTab: result.index };
    });
  },

  closeCanvasTab(index: number) {
    set((s) => {
      const result = closeTabAt(s.canvasTabs, s.activeCanvasTab, index);
      return { canvasTabs: result.tabs, activeCanvasTab: result.activeIndex };
    });
  },

  setActiveCanvasTab(index: number) {
    set((s) => {
      if (index < 0 || index >= s.canvasTabs.length) return {};
      return { activeCanvasTab: index };
    });
  },

  resetCanvasTabs() {
    set({ canvasTabs: [FILES_TAB], activeCanvasTab: 0 });
  },

  async refreshDiagnosticEvents() {
    const api = window.codesign?.diagnostics;
    if (!api?.listEvents) return;
    // Hydrate the persisted lastReadTs once per session so the unread badge
    // survives a restart instead of counting every historical error as new.
    // gameplan §A6 — also hydrates lastPickedMode so the New-design dialog
    // opens to the user's last-picked tab.
    if (!get().diagnosticsPrefsHydrated) {
      try {
        const prefs = await window.codesign?.preferences?.get?.();
        const persisted = prefs?.diagnosticsLastReadTs;
        if (typeof persisted === 'number' && persisted > 0) {
          set({ lastReadTs: persisted });
        }
        if (prefs?.lastPickedMode === 'design' || prefs?.lastPickedMode === 'game') {
          set({ lastPickedMode: prefs.lastPickedMode });
        }
      } catch {
        // Non-fatal: fall back to default 0.
      }
      set({ diagnosticsPrefsHydrated: true });
    }
    const result = await api.listEvents({
      schemaVersion: 1,
      limit: 100,
      includeTransient: false,
    });
    const events = result.events;
    const { lastReadTs } = get();
    const unreadErrorCount = events.filter((e) => e.level === 'error' && e.ts > lastReadTs).length;
    set({ recentEvents: events, unreadErrorCount });
  },

  markDiagnosticsRead() {
    const now = Date.now();
    set({ unreadErrorCount: 0, lastReadTs: now });
    void window.codesign?.preferences?.update?.({ diagnosticsLastReadTs: now })?.catch(() => {
      // Non-fatal: if persistence fails the in-memory value still works for
      // this session.
    });
  },

  async reportDiagnosticEvent(input) {
    const api = window.codesign?.diagnostics;
    if (!api?.reportEvent) {
      throw new Error('diagnostics.reportEvent unavailable');
    }
    return api.reportEvent({
      schemaVersion: 1,
      error: input.error,
      includePromptText: input.includePromptText,
      includePaths: input.includePaths,
      includeUrls: input.includeUrls,
      includeTimeline: input.includeTimeline,
      notes: input.notes,
      timeline: snapshotTimeline(),
    });
  },

  createReportableError(partial) {
    const localId = newId();
    const ts = Date.now();
    const fingerprint = computeFingerprint({
      errorCode: partial.code,
      stack: partial.stack,
      message: partial.message,
    });
    const record: ReportableError = {
      localId,
      code: partial.code,
      scope: partial.scope,
      message: partial.message,
      fingerprint,
      ts,
    };
    if (partial.stack !== undefined) record.stack = partial.stack;
    if (partial.runId !== undefined) record.runId = partial.runId;
    if (partial.context !== undefined) record.context = partial.context;

    set((s) => {
      const next = [...s.reportableErrors, record];
      if (next.length > MAX_REPORTABLE) next.splice(0, next.length - MAX_REPORTABLE);
      return { reportableErrors: next };
    });

    // Fire-and-forget DB persistence. Report UX does not depend on this.
    const api =
      typeof window !== 'undefined' ? window.codesign?.diagnostics?.recordRendererError : undefined;
    if (api) {
      const payload: {
        schemaVersion: 1;
        code: string;
        scope: string;
        message: string;
        stack?: string;
        runId?: string;
        context?: Record<string, unknown>;
      } = {
        schemaVersion: 1,
        code: partial.code,
        scope: partial.scope,
        message: partial.message,
      };
      if (partial.stack !== undefined) payload.stack = partial.stack;
      if (partial.runId !== undefined) payload.runId = partial.runId;
      if (partial.context !== undefined) payload.context = partial.context;
      void api(payload)
        .then((res) => {
          if (res.eventId === null) return;
          const eventId = res.eventId;
          // Batch A echoes `fingerprint` alongside eventId so the renderer
          // stops trusting its own FNV estimate once the DB row has been
          // written. Guarded on type for the transition window while Batch A's
          // type extension is landing.
          const echoed = (res as { fingerprint?: unknown }).fingerprint;
          const persistedFingerprint = typeof echoed === 'string' ? echoed : undefined;
          set((s) => ({
            reportableErrors: s.reportableErrors.map((existing) =>
              existing.localId === localId
                ? {
                    ...existing,
                    persistedEventId: eventId,
                    ...(persistedFingerprint !== undefined ? { persistedFingerprint } : {}),
                  }
                : existing,
            ),
          }));
        })
        .catch(() => {
          // DB persistence is nice-to-have; Report still works without it.
        });
    }
    return localId;
  },

  getReportableError(localId) {
    return get().reportableErrors.find((r) => r.localId === localId);
  },

  openReportDialog(localId) {
    set({ activeReportLocalId: localId });
  },
  closeReportDialog() {
    set({ activeReportLocalId: null });
  },
}));
