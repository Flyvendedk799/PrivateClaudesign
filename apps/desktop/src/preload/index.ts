import type {
  CacheRetention,
  CancelGenerationPayloadV1,
  ChatAppendInput,
  ChatMessage,
  ChatMessageRow,
  ClaudeCodeUserType,
  CommentCreateInput,
  CommentRow,
  CommentStatus,
  Design,
  DesignSnapshot,
  ExternalConfigsDetection,
  GeneratePayloadV1,
  ListEventsInput,
  ListEventsResult,
  LocalInputFile,
  ModelRef,
  OnboardingState,
  PromptAssistMetadata,
  ProviderEntry,
  ReasoningLevel,
  ReportEventInput,
  ReportEventResult,
  SelectedElement,
  SnapshotCreateInput,
  SupportedOnboardingProvider,
  UserSkill,
  WireApi,
} from '@open-codesign/shared';
import { contextBridge, ipcRenderer } from 'electron';
import type { CodexOAuthStatus } from '../main/codex-oauth-ipc';
import type {
  ConnectionTestError,
  ConnectionTestResult,
  ModelsListResponse,
  TestEndpointResponse,
} from '../main/connection-ipc';
import type { ImageGenerationSettingsView } from '../main/image-generation-settings';

export type { ConnectionTestError, ConnectionTestResult, ModelsListResponse, TestEndpointResponse };
export type { ClaudeCodeUserType, ExternalConfigsDetection };
export type { CodexOAuthStatus };
export type { ImageGenerationSettingsView };

export interface ValidateKeyResult {
  ok: true;
  modelCount: number;
}
export interface ValidateKeyError {
  ok: false;
  code: '401' | '402' | '429' | 'network';
  message: string;
}

export type ExportFormat = 'html' | 'pdf' | 'pptx' | 'zip' | 'markdown';
export interface ExportInvokeResponse {
  status: 'saved' | 'cancelled';
  path?: string;
  bytes?: number;
}

export interface ProviderRow {
  provider: string;
  maskedKey: string;
  baseUrl: string | null;
  isActive: boolean;
  label: string;
  /** Stored entry name — differs from `label` for codex-imported rows
   *  where `label` is the localized alias "Codex (imported)". */
  name: string;
  builtin: boolean;
  wire: WireApi;
  defaultModel: string;
  hasKey: boolean;
  reasoningLevel?: ReasoningLevel;
  cacheRetention?: CacheRetention;
  /** Per-chunk wall-clock budget for the agent runtime, in milliseconds.
   *  Mirrors `ProviderEntry.wallClockBudgetMs` in @open-codesign/shared. */
  wallClockBudgetMs?: number;
  error?: 'decryption_failed' | string;
}

// `ClaudeCodeUserType` and `ExternalConfigsDetection` now live in
// `packages/shared/src/detection.ts` so main and preload stay in lockstep —
// see that file for the drift-risk background. The inline definitions that
// used to live here are gone; re-exports above keep downstream imports
// from breaking.

export interface AppPaths {
  config: string;
  configFolder: string;
  logs: string;
  logsFolder: string;
  data: string;
}

export type StorageKind = 'config' | 'logs' | 'data';

export type UpdateChannel = 'stable' | 'beta';

export interface GenerateArtifact {
  id: string;
  type: string;
  title: string;
  content: string;
  designParams: unknown[];
  createdAt: string;
}

export interface GenerateResponse {
  message: string;
  artifacts: GenerateArtifact[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Preferences {
  updateChannel: UpdateChannel;
  generationTimeoutSec: number;
  checkForUpdatesOnStartup: boolean;
  dismissedUpdateVersion: string;
  diagnosticsLastReadTs: number;
  /** gameplan §A6 / Q2 — last-picked mode in the New-design dialog. */
  lastPickedMode: 'design' | 'game';
  /** Improver1 §6 — opt-out of mid-run auto-verify. Default false (ON). */
  incrementalVerifyDisabled: boolean;
}

/**
 * Streaming events emitted by the (future) Agent runtime. Phase 1 emits
 * turn_start / text_delta / turn_end. Phase 2 adds tool_call_*. Kept
 * deliberately loose so Workstream B can evolve the shape without a
 * lockstep change here — useAgentStream in the renderer tolerates unknown
 * event types by ignoring them.
 */
/** Wire shape for the `apply-comment:event:v1` channel. Smaller than
 *  AgentStreamEvent because applyComment is a one-shot revise (no tool
 *  loop) — only text deltas + a terminal `done` event. */
export interface ApplyCommentStreamEvent {
  /** Per-call run identifier (matches the `runId` from withRun()). */
  runId: string;
  kind: 'text_delta' | 'done';
  /** Present on text_delta events. */
  delta?: string;
}

export interface AgentStreamEvent {
  type:
    | 'turn_start'
    | 'text_delta'
    | 'thinking_delta'
    | 'thinking_end'
    | 'tool_draft_start'
    | 'tool_draft_delta'
    | 'turn_end'
    | 'tool_call_start'
    | 'tool_call_result'
    // Backlog-3 §4 — partial result delta. Emitted by tools that opt
    // into streaming (today: image-asset synthetic progress; future:
    // chunked view results). Renderer accumulates per toolCallId; the
    // final `tool_call_result` event closes the streaming entry.
    | 'tool_result_delta'
    | 'fs_updated'
    | 'chunk_start'
    | 'chunk_end'
    | 'agent_end'
    | 'heartbeat'
    | 'error';
  designId: string;
  /** Trace ID linking this event to the main-process generation log entry.
   *  Matches the generationId from the codesign:v1:generate payload — always
   *  present because the main process supplies it from baseCtx. */
  generationId: string;
  // turn_start
  turnId?: string;
  // text_delta and thinking_delta share the `delta` field. Distinguish via
  // the `type` discriminator. `thinking_end` carries no delta — it just
  // signals the renderer to clear the live thoughts panel.
  delta?: string;
  // turn_end
  finalText?: string;
  // tool_call_start
  toolName?: string;
  command?: string;
  args?: Record<string, unknown>;
  verbGroup?: string;
  toolCallId?: string;
  // tool_call_result
  result?: unknown;
  durationMs?: number;
  // tool_result_delta (Backlog-3 §4)
  /** Partial result preview text — typically a small, truncated head of
   *  the in-flight result. Cumulative byte count is reported via
   *  `byteCount` so the UI can show progress without buffering the
   *  full body. */
  resultPreview?: string;
  byteCount?: number;
  /** Synthetic progress percent for tools that don't ship bytes
   *  incrementally (e.g. image generation). Range 0-100. */
  progressPct?: number;
  // tool_call_result enrichments — present only when the tool was the agent's
  // text_editor (str_replace / insert) and the FS callback returned a populated
  // EditResult. Powers the follow-the-edit cursor in the preview.
  editPath?: string;
  editStartLine?: number;
  editEndLine?: number;
  // tool_call_result enrichment — true when pi-agent-core flagged the call
  // with `isError`. Renderer counts these to surface a "run is thrashing"
  // signal in the chat status header without waiting for the run summary.
  isFailure?: boolean;
  // fs_updated — emitted whenever the agent's text_editor mutates a file in the
  // virtual fs. Renderer uses this to re-render the iframe live during
  // generation so the user can watch the design take shape.
  path?: string;
  content?: string;
  // chunk_start / chunk_end — emitted by the IPC handler around each
  // auto-continue chunk. Lets the renderer show "Chunk N of M · X:YY
  // remaining" without inferring from log lines.
  chunkIndex?: number;
  chunkCap?: number;
  chunkBudgetMs?: number;
  chunkInterrupted?: boolean;
  // heartbeat — emitted when no other event has fired for ≥5s during a run.
  // Renderer keeps the thinking panel visible and shows an elapsed counter
  // so the user can tell the run is alive during long extended-thinking gaps
  // (the analysed traces had a 14-min silent stretch in run 1 turn 3).
  // sinceMs = ms since the previous event of any kind.
  sinceMs?: number;
  // error
  message?: string;
  code?: string;
}

const api = {
  detectProvider: (key: string) =>
    ipcRenderer.invoke('codesign:detect-provider', key) as Promise<string | null>,
  doneVerify: (artifact: string) =>
    ipcRenderer.invoke('done:verify:v1', { artifact }) as Promise<{
      errors: Array<{ message: string; source?: string; lineno?: number }>;
    }>,
  generate: (payload: {
    prompt: string;
    history: ChatMessage[];
    model: ModelRef;
    baseUrl?: string;
    referenceUrl?: string;
    attachments: LocalInputFile[];
    generationId: string;
    designId?: string;
    previousHtml?: string;
    /** Slash-command-driven artifact pattern override. Omit for default
     *  ('jsx'). 'vanilla' selects the multi-source-file guidance + the
     *  vanilla preview inliner. */
    pattern?: 'jsx' | 'vanilla';
    /** gameplan §A6 — game-mode discriminator from the New-design dialog. */
    artifactMode?: 'design' | 'game';
    /** gameplan §A6 — engine pin (when artifactMode='game'). */
    gameEngine?: 'three' | 'phaser' | 'pygame' | 'godot';
  }) =>
    ipcRenderer.invoke('codesign:v1:generate', {
      schemaVersion: 1,
      ...payload,
    } satisfies GeneratePayloadV1) as Promise<GenerateResponse>,
  cancelGeneration: (generationId: string, opts?: { asCheckpoint?: boolean }) =>
    ipcRenderer.invoke('codesign:v1:cancel-generation', {
      schemaVersion: 1,
      generationId,
      ...(opts?.asCheckpoint === true ? { asCheckpoint: true } : {}),
    } satisfies CancelGenerationPayloadV1),
  /** Push a "wrap up now" override into the agent's pending-steers queue.
   *  The agent picks it up at the next turn_end and converges to `done`
   *  ASAP. No-op + warn if the generationId isn't currently in flight. */
  requestWrapUp: (generationId: string) =>
    ipcRenderer.invoke('codesign:v1:request-wrap-up', { generationId }) as Promise<{
      queued: boolean;
    }>,
  generateTitle: (prompt: string) =>
    ipcRenderer.invoke('codesign:v1:generate-title', { prompt }) as Promise<string>,
  /** plan0305 P3.2 — aggregate token + cost totals for one design, summed
   *  across all run_usage rows. Returns zeros when no telemetry has been
   *  recorded yet. */
  getDesignUsage: (designId: string) =>
    ipcRenderer.invoke('codesign:v1:design-usage', { designId }) as Promise<{
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheCreationInputTokens: number;
      costUsd: number;
      runs: number;
    }>,
  /** Backlog-3 §10 — read a budget record. id='global' or designId. */
  getBudget: (id: string) =>
    ipcRenderer.invoke('codesign:v1:get-budget', { id }) as Promise<{
      id: string;
      dailyLimitUsd: number | null;
      perDesignLimitUsd: number | null;
      alertAtPct: number;
    } | null>,
  /** Backlog-3 §10 — upsert a budget record. */
  setBudget: (input: {
    id: string;
    dailyLimitUsd: number | null;
    perDesignLimitUsd: number | null;
    alertAtPct: number;
  }) => ipcRenderer.invoke('codesign:v1:set-budget', input) as Promise<void>,
  /** Backlog-3 §10 — last N days of daily_usage rolled up for the
   *  cost dashboard sparkline. */
  getDailyUsage: (daysBack = 7) =>
    ipcRenderer.invoke('codesign:v1:daily-usage', { daysBack }) as Promise<
      Array<{
        date: string;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        runCount: number;
      }>
    >,
  applyComment: (payload: {
    html: string;
    comment: string;
    selection: SelectedElement;
    model?: ModelRef;
    referenceUrl?: string;
    attachments?: LocalInputFile[];
  }) => ipcRenderer.invoke('codesign:apply-comment', payload) as Promise<GenerateResponse>,
  pickInputFiles: () =>
    ipcRenderer.invoke('codesign:pick-input-files') as Promise<LocalInputFile[]>,
  pickDesignSystemDirectory: () =>
    ipcRenderer.invoke('codesign:pick-design-system-directory') as Promise<OnboardingState>,
  clearDesignSystem: () =>
    ipcRenderer.invoke('codesign:clear-design-system') as Promise<OnboardingState>,
  export: (payload: {
    format: ExportFormat;
    htmlContent: string;
    defaultFilename?: string;
    /** When supplied AND format='zip', main loads the design's full
     *  virtual FS from SQLite and bundles every sibling file (CSS, JS,
     *  assets) alongside index.html. Required for vanilla-pattern zips
     *  to mirror Claude Design's multi-file layout. */
    designId?: string;
  }) => ipcRenderer.invoke('codesign:export', payload) as Promise<ExportInvokeResponse>,
  locale: {
    getSystem: () => ipcRenderer.invoke('locale:get-system') as Promise<string>,
    getCurrent: () => ipcRenderer.invoke('locale:get-current') as Promise<string>,
    set: (locale: string) => ipcRenderer.invoke('locale:set', locale) as Promise<string>,
  },
  checkForUpdates: () => ipcRenderer.invoke('codesign:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('codesign:download-update'),
  installUpdate: () => ipcRenderer.invoke('codesign:install-update'),
  onUpdateAvailable: (cb: (info: unknown) => void) => {
    const listener = (_e: unknown, info: unknown) => cb(info);
    ipcRenderer.on('codesign:update-available', listener);
    return () => ipcRenderer.removeListener('codesign:update-available', listener);
  },
  onboarding: {
    getState: () => ipcRenderer.invoke('onboarding:get-state') as Promise<OnboardingState>,
    validateKey: (input: {
      provider: SupportedOnboardingProvider;
      apiKey: string;
      baseUrl?: string;
    }) =>
      ipcRenderer.invoke('onboarding:validate-key', input) as Promise<
        ValidateKeyResult | ValidateKeyError
      >,
    saveKey: (input: {
      provider: SupportedOnboardingProvider;
      apiKey: string;
      modelPrimary: string;
      baseUrl?: string;
    }) => ipcRenderer.invoke('onboarding:save-key', input) as Promise<OnboardingState>,
    skip: () => ipcRenderer.invoke('onboarding:skip') as Promise<OnboardingState>,
  },
  settings: {
    listProviders: () => ipcRenderer.invoke('settings:v1:list-providers') as Promise<ProviderRow[]>,
    addProvider: (input: {
      provider: SupportedOnboardingProvider;
      apiKey: string;
      modelPrimary: string;
      baseUrl?: string;
    }) => ipcRenderer.invoke('settings:v1:add-provider', input) as Promise<ProviderRow[]>,
    deleteProvider: (provider: string) =>
      ipcRenderer.invoke('settings:v1:delete-provider', provider) as Promise<ProviderRow[]>,
    setActiveProvider: (input: { provider: string; modelPrimary: string }) =>
      ipcRenderer.invoke('settings:v1:set-active-provider', input) as Promise<OnboardingState>,
    getPaths: () => ipcRenderer.invoke('settings:v1:get-paths') as Promise<AppPaths>,
    chooseStorageFolder: (kind: StorageKind) =>
      ipcRenderer.invoke('settings:v1:choose-storage-folder', kind) as Promise<AppPaths>,
    openFolder: (path: string) =>
      ipcRenderer.invoke('settings:v1:open-folder', path) as Promise<void>,
    resetOnboarding: () => ipcRenderer.invoke('settings:v1:reset-onboarding') as Promise<void>,
    toggleDevtools: () => ipcRenderer.invoke('settings:v1:toggle-devtools') as Promise<void>,
    validateKey: (input: {
      provider: SupportedOnboardingProvider;
      apiKey: string;
      baseUrl?: string;
    }) =>
      ipcRenderer.invoke('onboarding:validate-key', input) as Promise<
        ValidateKeyResult | ValidateKeyError
      >,
  },
  config: {
    setProviderAndModels: (input: {
      provider: SupportedOnboardingProvider;
      apiKey: string;
      modelPrimary: string;
      baseUrl?: string;
      setAsActive: boolean;
    }) =>
      ipcRenderer.invoke('config:v1:set-provider-and-models', {
        schemaVersion: 1,
        ...input,
      }) as Promise<OnboardingState>,
    addProvider: (input: {
      id: string;
      name: string;
      wire: WireApi;
      baseUrl: string;
      apiKey: string;
      defaultModel: string;
      httpHeaders?: Record<string, string>;
      queryParams?: Record<string, string>;
      envKey?: string;
      setAsActive: boolean;
    }) => ipcRenderer.invoke('config:v1:add-provider', input) as Promise<OnboardingState>,
    updateProvider: (input: {
      id: string;
      name?: string;
      baseUrl?: string;
      defaultModel?: string;
      wire?: WireApi;
      httpHeaders?: Record<string, string>;
      queryParams?: Record<string, string>;
      /** `null` explicitly clears the override and falls back to the model
       *  default; a level string sets it; omit to leave untouched. */
      reasoningLevel?: ReasoningLevel | null;
      /** Same tri-state as reasoningLevel: `null` clears, value sets, omit
       *  leaves alone. Effective on the legacy `complete()` path; the agent
       *  path inherits via the PI_CACHE_RETENTION env var. */
      cacheRetention?: CacheRetention | null;
      /** Per-chunk wall-clock budget (ms) for the agent runtime. Same
       *  tri-state: `null` clears (use core default), positive number sets,
       *  omit leaves alone. Range enforced server-side: 60000-600000. */
      wallClockBudgetMs?: number | null;
      /** Non-empty string rotates the stored secret; empty string clears it
       *  (keyless providers); omit to leave the existing secret untouched. */
      apiKey?: string;
    }) => ipcRenderer.invoke('config:v1:update-provider', input) as Promise<OnboardingState>,
    removeProvider: (id: string) =>
      ipcRenderer.invoke('config:v1:remove-provider', id) as Promise<OnboardingState>,
    setActiveProviderAndModel: (input: { provider: string; modelPrimary: string }) =>
      ipcRenderer.invoke(
        'config:v1:set-active-provider-and-model',
        input,
      ) as Promise<OnboardingState>,
    testEndpoint: (input: {
      wire: WireApi;
      baseUrl: string;
      apiKey: string;
      httpHeaders?: Record<string, string>;
    }) => ipcRenderer.invoke('config:v1:test-endpoint', input) as Promise<TestEndpointResponse>,
    listEndpointModels: (input: { wire: WireApi; baseUrl: string; apiKey: string }) =>
      ipcRenderer.invoke('config:v1:list-endpoint-models', input) as Promise<
        { ok: true; models: string[] } | { ok: false; error: string }
      >,
    detectExternalConfigs: () =>
      ipcRenderer.invoke('config:v1:detect-external-configs') as Promise<ExternalConfigsDetection>,
    importCodexConfig: () =>
      ipcRenderer.invoke('config:v1:import-codex-config') as Promise<OnboardingState>,
    importClaudeCodeConfig: () =>
      ipcRenderer.invoke('config:v1:import-claude-code-config') as Promise<OnboardingState>,
    importGeminiConfig: () =>
      ipcRenderer.invoke('config:v1:import-gemini-config') as Promise<OnboardingState>,
    importOpencodeConfig: () =>
      ipcRenderer.invoke('config:v1:import-opencode-config') as Promise<OnboardingState>,
  },
  preferences: {
    get: () => ipcRenderer.invoke('preferences:v1:get') as Promise<Preferences>,
    update: (patch: Partial<Preferences>) =>
      ipcRenderer.invoke('preferences:v1:update', patch) as Promise<Preferences>,
  },
  imageGeneration: {
    get: () =>
      ipcRenderer.invoke('image-generation:v1:get') as Promise<ImageGenerationSettingsView>,
    update: (patch: Partial<ImageGenerationSettingsView> & { apiKey?: string }) =>
      ipcRenderer.invoke(
        'image-generation:v1:update',
        patch,
      ) as Promise<ImageGenerationSettingsView>,
  },
  codexOAuth: {
    status: () => ipcRenderer.invoke('codex-oauth:v1:status') as Promise<CodexOAuthStatus>,
    login: () => ipcRenderer.invoke('codex-oauth:v1:login') as Promise<CodexOAuthStatus>,
    cancelLogin: () => ipcRenderer.invoke('codex-oauth:v1:cancel-login') as Promise<boolean>,
    logout: () => ipcRenderer.invoke('codex-oauth:v1:logout') as Promise<CodexOAuthStatus>,
  },
  connection: {
    test: (input: {
      provider: SupportedOnboardingProvider;
      apiKey: string;
      baseUrl: string;
    }) =>
      ipcRenderer.invoke('connection:v1:test', input) as Promise<
        ConnectionTestResult | ConnectionTestError
      >,
    testActive: () =>
      ipcRenderer.invoke('connection:v1:test-active') as Promise<
        ConnectionTestResult | ConnectionTestError
      >,
    testProvider: (providerId: string) =>
      ipcRenderer.invoke('connection:v1:test-provider', providerId) as Promise<
        ConnectionTestResult | ConnectionTestError
      >,
  },
  models: {
    list: (input: {
      provider: SupportedOnboardingProvider;
      apiKey: string;
      baseUrl: string;
    }) => ipcRenderer.invoke('models:v1:list', input) as Promise<ModelsListResponse>,
    listForProvider: (providerId: string) =>
      ipcRenderer.invoke('models:v1:list-for-provider', providerId) as Promise<ModelsListResponse>,
  },
  ollama: {
    probe: (baseUrl?: string) =>
      ipcRenderer.invoke('ollama:v1:probe', baseUrl) as Promise<
        { ok: true; models: string[] } | { ok: false; code: string; message: string }
      >,
  },
  snapshots: {
    listDesigns: () =>
      ipcRenderer.invoke('snapshots:v1:list-designs', { schemaVersion: 1 }) as Promise<Design[]>,
    createDesign: (name: string) =>
      ipcRenderer.invoke('snapshots:v1:create-design', {
        schemaVersion: 1,
        name,
      }) as Promise<Design>,
    getDesign: (id: string) =>
      ipcRenderer.invoke('snapshots:v1:get-design', {
        schemaVersion: 1,
        id,
      }) as Promise<Design | null>,
    renameDesign: (id: string, name: string) =>
      ipcRenderer.invoke('snapshots:v1:rename-design', {
        schemaVersion: 1,
        id,
        name,
      }) as Promise<Design>,
    setThumbnail: (id: string, thumbnailText: string | null) =>
      ipcRenderer.invoke('snapshots:v1:set-thumbnail', {
        schemaVersion: 1,
        id,
        thumbnailText,
      }) as Promise<Design>,
    setPromptAssist: (id: string, metadata: PromptAssistMetadata | null) =>
      ipcRenderer.invoke('snapshots:v1:set-prompt-assist', {
        schemaVersion: 1,
        id,
        metadata,
      }) as Promise<Design>,
    softDeleteDesign: (id: string) =>
      ipcRenderer.invoke('snapshots:v1:soft-delete-design', {
        schemaVersion: 1,
        id,
      }) as Promise<Design>,
    duplicateDesign: (id: string, name: string) =>
      ipcRenderer.invoke('snapshots:v1:duplicate-design', {
        schemaVersion: 1,
        id,
        name,
      }) as Promise<Design>,
    list: (designId: string) =>
      ipcRenderer.invoke('snapshots:v1:list', { schemaVersion: 1, designId }) as Promise<
        DesignSnapshot[]
      >,
    get: (id: string) =>
      ipcRenderer.invoke('snapshots:v1:get', {
        schemaVersion: 1,
        id,
      }) as Promise<DesignSnapshot | null>,
    create: (input: SnapshotCreateInput) =>
      ipcRenderer.invoke('snapshots:v1:create', {
        schemaVersion: 1,
        ...input,
      }) as Promise<DesignSnapshot>,
    delete: (id: string) =>
      ipcRenderer.invoke('snapshots:v1:delete', { schemaVersion: 1, id }) as Promise<void>,
    pickWorkspaceFolder: () =>
      ipcRenderer.invoke('snapshots:v1:workspace:pick', {
        schemaVersion: 1,
      }) as Promise<string | null>,
    updateWorkspace: (designId: string, workspacePath: string | null, migrateFiles: boolean) =>
      ipcRenderer.invoke('snapshots:v1:workspace:update', {
        schemaVersion: 1,
        designId,
        workspacePath,
        migrateFiles,
      }) as Promise<Design>,
    openWorkspaceFolder: (designId: string) =>
      ipcRenderer.invoke('snapshots:v1:workspace:open', {
        schemaVersion: 1,
        designId,
      }) as Promise<void>,
    checkWorkspaceFolder: (designId: string) =>
      ipcRenderer.invoke('snapshots:v1:workspace:check', {
        schemaVersion: 1,
        designId,
      }) as Promise<{ exists: boolean }>,
    /**
     * Multi-file artifacts — list every `design_files` row for this
     * design as `{ path, sizeBytes, updatedAt }`. Body content is NOT
     * shipped (use `view` via the agent's text_editor or render the
     * file via the `design-files://` protocol if you need bytes).
     */
    listFiles: (designId: string) =>
      ipcRenderer.invoke('snapshots:v1:list-files', {
        schemaVersion: 1,
        designId,
      }) as Promise<Array<{ path: string; sizeBytes: number; updatedAt: string }>>,
  },
  chat: {
    list: (designId: string) =>
      ipcRenderer.invoke('chat:v1:list', { schemaVersion: 1, designId }) as Promise<
        ChatMessageRow[]
      >,
    append: (input: ChatAppendInput) =>
      ipcRenderer.invoke('chat:v1:append', {
        schemaVersion: 1,
        ...input,
      }) as Promise<ChatMessageRow>,
    seedFromSnapshots: (designId: string) =>
      ipcRenderer.invoke('chat:v1:seed-from-snapshots', {
        schemaVersion: 1,
        designId,
      }) as Promise<{ inserted: number }>,
    newSession: (designId: string) =>
      ipcRenderer.invoke('chat:v1:new-session', {
        schemaVersion: 1,
        designId,
      }) as Promise<{ sessionId: number }>,
    currentSession: (designId: string) =>
      ipcRenderer.invoke('chat:v1:current-session', {
        schemaVersion: 1,
        designId,
      }) as Promise<{ sessionId: number }>,
    updateToolStatus: (input: {
      designId: string;
      seq: number;
      status: 'done' | 'error';
      errorMessage?: string;
    }) =>
      ipcRenderer.invoke('chat:update-tool-status:v1', {
        schemaVersion: 1,
        ...input,
      }) as Promise<{ ok: true }>,
    onAgentEvent: (cb: (event: AgentStreamEvent) => void) => {
      const listener = (_e: unknown, event: AgentStreamEvent) => cb(event);
      ipcRenderer.on('agent:event:v1', listener);
      return () => ipcRenderer.removeListener('agent:event:v1', listener);
    },
    /** Subscribe to streaming text deltas from `applyComment`. The callback
     *  fires once per text chunk while the model is producing the revised
     *  HTML, then once with kind='done' when the call resolves. Returns an
     *  unsubscribe function. */
    onApplyCommentEvent: (cb: (event: ApplyCommentStreamEvent) => void) => {
      const listener = (_e: unknown, event: ApplyCommentStreamEvent) => cb(event);
      ipcRenderer.on('apply-comment:event:v1', listener);
      return () => ipcRenderer.removeListener('apply-comment:event:v1', listener);
    },
  },
  comments: {
    add: (input: CommentCreateInput) =>
      ipcRenderer.invoke('comments:v1:add', {
        schemaVersion: 1,
        ...input,
      }) as Promise<CommentRow>,
    list: (designId: string, snapshotId?: string) =>
      ipcRenderer.invoke('comments:v1:list', {
        schemaVersion: 1,
        designId,
        ...(snapshotId !== undefined ? { snapshotId } : {}),
      }) as Promise<CommentRow[]>,
    listPendingEdits: (designId: string) =>
      ipcRenderer.invoke('comments:v1:list-pending-edits', {
        schemaVersion: 1,
        designId,
      }) as Promise<CommentRow[]>,
    update: (id: string, patch: { text?: string; status?: CommentStatus }) =>
      ipcRenderer.invoke('comments:v1:update', {
        schemaVersion: 1,
        id,
        ...patch,
      }) as Promise<CommentRow | null>,
    remove: (id: string) =>
      ipcRenderer.invoke('comments:v1:remove', {
        schemaVersion: 1,
        id,
      }) as Promise<{ removed: boolean }>,
    markApplied: (ids: string[], snapshotId: string) =>
      ipcRenderer.invoke('comments:v1:mark-applied', {
        schemaVersion: 1,
        ids,
        snapshotId,
      }) as Promise<CommentRow[]>,
  },
  // backlog-2 #7 — user-authored skills (Skills hub tab)
  skills: {
    list: () => ipcRenderer.invoke('skills:v1:list') as Promise<UserSkill[]>,
    get: (id: string) =>
      ipcRenderer.invoke('skills:v1:get', { schemaVersion: 1, id }) as Promise<UserSkill | null>,
    create: (input: {
      name: string;
      whenToUse: string;
      source: string;
      sourceDesignId?: string | null;
      sourceSnapshotId?: string | null;
      sourceRect?: { top: number; left: number; width: number; height: number } | null;
    }) =>
      ipcRenderer.invoke('skills:v1:create', { schemaVersion: 1, ...input }) as Promise<UserSkill>,
    update: (id: string, patch: { name?: string; whenToUse?: string; source?: string }) =>
      ipcRenderer.invoke('skills:v1:update', {
        schemaVersion: 1,
        id,
        patch,
      }) as Promise<UserSkill>,
    delete: (id: string) =>
      ipcRenderer.invoke('skills:v1:delete', { schemaVersion: 1, id }) as Promise<void>,
    extractFromDesign: (input: {
      designId: string;
      snapshotId: string;
      rect: { top: number; left: number; width: number; height: number };
      userPrompt: string;
    }) =>
      ipcRenderer.invoke('skills:v1:extract-from-design', {
        schemaVersion: 1,
        ...input,
      }) as Promise<UserSkill>,
  },
  diagnostics: {
    log: (entry: {
      schemaVersion: 1;
      level: 'info' | 'warn' | 'error';
      scope: string;
      message: string;
      data?: Record<string, unknown>;
      stack?: string;
    }) => ipcRenderer.invoke('diagnostics:v1:log', entry) as Promise<void>,
    recordRendererError: (input: {
      schemaVersion: 1;
      code: string;
      scope: string;
      message: string;
      stack?: string;
      runId?: string;
      context?: Record<string, unknown>;
    }) =>
      ipcRenderer.invoke('diagnostics:v1:recordRendererError', input) as Promise<{
        schemaVersion: 1;
        eventId: number | null;
      }>,
    openLogFolder: () => ipcRenderer.invoke('diagnostics:v1:openLogFolder') as Promise<void>,
    exportDiagnostics: () =>
      ipcRenderer.invoke('diagnostics:v1:exportDiagnostics') as Promise<string>,
    showItemInFolder: (path: string) =>
      ipcRenderer.invoke('diagnostics:v1:showItemInFolder', path) as Promise<void>,
    listEvents: (input: ListEventsInput) =>
      ipcRenderer.invoke('diagnostics:v1:listEvents', input) as Promise<ListEventsResult>,
    reportEvent: (input: ReportEventInput) =>
      ipcRenderer.invoke('diagnostics:v1:reportEvent', input) as Promise<ReportEventResult>,
    isFingerprintRecentlyReported: (fingerprint: string) =>
      ipcRenderer.invoke('diagnostics:v1:isFingerprintRecentlyReported', {
        schemaVersion: 1,
        fingerprint,
      }) as Promise<{
        schemaVersion: 1;
        reported: boolean;
        ts?: number;
        issueUrl?: string;
      }>,
  },
  openExternal: (url: string) =>
    ipcRenderer.invoke('codesign:v1:open-external', url) as Promise<void>,
  godot: {
    /** gameplan §D — surface the cached Godot CLI detection result. The
     *  Settings panel renders three states: ok / wrong-version / missing. */
    getStatus: () => ipcRenderer.invoke('codesign:v1:godot-cli-status') as Promise<GodotCliStatus>,
    /** Force a re-probe — used by the Settings "Re-detect" button after
     *  the user installs Godot mid-session. */
    refreshStatus: () =>
      ipcRenderer.invoke('codesign:v1:godot-cli-status:refresh') as Promise<GodotCliStatus>,
    /** gameplan §D — kick off `godot --headless --export-release Web` for
     *  the given design. Resolves once the build completes (or fails).
     *  Subscribe to `onBuildProgress` first to follow stdout/stderr lines. */
    buildWebPreview: (designId: string) =>
      ipcRenderer.invoke('codesign:v1:godot-web-build', { designId }) as Promise<{
        ok: boolean;
        buildDir?: string;
        files?: string[];
        reason?: string;
        detail?: string;
      }>,
    onBuildProgress: (
      cb: (
        event:
          | { designId: string; phase: 'materialize'; pct: number }
          | { designId: string; phase: 'preset' }
          | { designId: string; phase: 'build:start' }
          | { designId: string; phase: 'build:stdout'; line: string }
          | { designId: string; phase: 'build:stderr'; line: string }
          | { designId: string; phase: 'collect' },
      ) => void,
    ) => {
      const listener = (_evt: unknown, e: Parameters<typeof cb>[0]) => cb(e);
      ipcRenderer.on('codesign:v1:godot-web-build:progress', listener);
      return () => ipcRenderer.removeListener('codesign:v1:godot-web-build:progress', listener);
    },
  },
};

/** Mirrors `GodotCliStatus` from the main process — duplicated here so
 *  the preload bundle doesn't pull in `node:child_process` types. */
export type GodotCliStatus =
  | {
      ok: true;
      path: string;
      version: string;
      major: number;
      minor: number;
      patch: number;
    }
  | { ok: false; reason: 'missing' }
  | {
      ok: false;
      reason: 'wrong-version';
      path: string;
      version: string;
      major: number;
    };

contextBridge.exposeInMainWorld('codesign', api);

export type CodesignApi = typeof api;
