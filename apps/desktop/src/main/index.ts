import { mkdirSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path_module from 'node:path';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentEvent,
  CONTINUATION_THRESHOLDS,
  type CoreLogger,
  type GenerateImageAssetRequest,
  type GenerateImageAssetResult,
  applyComment,
  buildContinuationPrompt,
  classifyArtifactType,
  generate,
  generateTitle,
  generateViaAgent,
  shouldPauseForContinuation,
} from '@open-codesign/core';
// Backlog-3 §8 — DESIGN_SKILLS (~204KB) and FRAME_TEMPLATES (~48KB) seed
// the per-generation virtual fs but are never read until the first run
// starts. Lazy-load on first-call cache-once to keep cold-start RAM lean.
type LazyTemplates = ReadonlyArray<readonly [string, string]>;
let _FRAME_TEMPLATES: LazyTemplates | null = null;
let _DESIGN_SKILLS: LazyTemplates | null = null;
async function loadFrameTemplates(): Promise<LazyTemplates> {
  if (_FRAME_TEMPLATES === null) {
    // Backlog-3 §8 telemetry — log first-call timing so we can see
    // exactly when the ~48KB of frame templates land in the main
    // process bundle (should be lazy: never on cold boot, only after
    // the first generation).
    const t0 = Date.now();
    const mod = await import('@open-codesign/core');
    _FRAME_TEMPLATES = mod.FRAME_TEMPLATES;
    getLogger('lazy-load').info('frame_templates.first_load', {
      ms: Date.now() - t0,
      entries: _FRAME_TEMPLATES.length,
    });
  }
  return _FRAME_TEMPLATES;
}
async function loadDesignSkills(): Promise<LazyTemplates> {
  if (_DESIGN_SKILLS === null) {
    const t0 = Date.now();
    const mod = await import('@open-codesign/core');
    _DESIGN_SKILLS = mod.DESIGN_SKILLS;
    getLogger('lazy-load').info('design_skills.first_load', {
      ms: Date.now() - t0,
      entries: _DESIGN_SKILLS.length,
    });
  }
  return _DESIGN_SKILLS;
}
import type { GenerateViaAgentDeps } from '@open-codesign/core';
import {
  detectProviderFromKey,
  generateImage,
  looksLikeClaudeOAuthToken,
} from '@open-codesign/providers';
import {
  ApplyCommentPayload,
  BRAND,
  CancelGenerationPayloadV1,
  CodesignError,
  ERROR_CODES,
  type GameEngine,
  GeneratePayload,
  GeneratePayloadV1,
  computeImpliedCost,
  estimateContextUsedPct,
} from '@open-codesign/shared';
import { computeFingerprint } from '@open-codesign/shared/fingerprint';
import type BetterSqlite3 from 'better-sqlite3';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AgentStreamEvent } from '../preload/index';
import { buildAbortContinuationRecap } from './abort-continuation';
import { registerAppMenu } from './app-menu';
import { showBootDialog, writeBootErrorSync } from './boot-fallback';
import { registerChatMessagesIpc, registerChatMessagesUnavailableIpc } from './chat-messages-ipc';
import { queueClaudeCodeRefresh, setRefreshQueueWindow } from './claude-code-refresh-queue';
import {
  CHATGPT_CODEX_PROVIDER_ID,
  getCodexTokenStore,
  migrateStaleCodexEntryIfNeeded,
  registerCodexOAuthIpc,
} from './codex-oauth-ipc';
import { registerCommentsIpc, registerCommentsUnavailableIpc } from './comments-ipc';
import { configDir } from './config';
import { registerConnectionIpc } from './connection-ipc';
import { scanDesignSystem } from './design-system';
import { registerDiagnosticsIpc } from './diagnostics-ipc';
import { makeRuntimeVerifier } from './done-verify';
import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  shell,
} from './electron-runtime';
import { registerExporterIpc } from './exporter-ipc';
import { indexGameArtifactsFromFiles } from './game-artifacts-import';
import { registerGameArtifactsIpc } from './game-artifacts-ipc';
import { buildArtifactRegistryDeps } from './game-artifacts-registry-deps';
import {
  DESIGN_FILES_PRIVILEGED_SCHEME,
  DESIGN_FILES_SCHEME,
  GAME_FILES_PRIVILEGED_SCHEME,
  GAME_FILES_SCHEME,
  gameFilesResponseHeaders,
  parseGameFilesUrl,
  resolveDesignFilesRequest,
  resolveGameFilesBuildRequest,
  resolveGameFilesRequest,
} from './game-files-protocol';
import { makeGameFilesSynthesizer } from './game-files-synthesize';
import { findInFlightDuplicate, generateDedupKey, hashContentKey } from './generate-dedup';
import {
  armGenerationTimeout,
  cancelGenerationRequest,
  classifyAbortError,
  extractGenerationTimeoutError,
  requestCheckpointAbort,
} from './generation-ipc';
import { readGodotBuildFile } from './godot-web-build';
import { registerGodotWebBuildIpc } from './godot-web-build-ipc';
import { getGodotWebBuildDir } from './godot-web-build-registry';
import { type ImageCache, makeImageCache } from './image-cache';
import {
  registerImageGenerationSettingsIpc,
  resolveImageGenerationConfig,
  toGenerateImageOptions,
} from './image-generation-settings';
import { maybeAbortIfRunningFromDmg } from './install-check';
import { registerLocaleIpc } from './locale-ipc';
import { getLogPath, getLogger, initLogger } from './logger';
import { setMotionDesignDirResolver, setMotionMainWindowGetter } from './motion-bundler';
import { listMotionCompositions } from './motion-compositions-db';
import {
  MOTION_FILES_PRIVILEGED_SCHEME,
  MOTION_FILES_SCHEME,
  motionFilesResponseHeaders,
  resolveMotionFilesRequest,
} from './motion-files-protocol';
import {
  buildMotionModeRuntime,
  notifyMotionFileWrite,
  setMotionCompositionEventSink,
} from './motion-mode-runtime';
import {
  getApiKeyForProvider,
  getCachedConfig,
  getOnboardingState,
  loadConfigOnBoot,
  registerOnboardingIpc,
  setDesignSystem,
} from './onboarding-ipc';
import { isAllowedExternalUrl } from './open-external';
import { persistContinuationRowOnce } from './persist-continuation';
import { makePlaytester } from './playtest-game';
import { readPersisted as readPreferences, registerPreferencesIpc } from './preferences-ipc';
import { preparePromptContext } from './prompt-context';
import { createProviderContextStore } from './provider-context';
import { resolveActiveModel } from './provider-settings';
import { makeRenderPreviewer } from './render-preview';
import { cleanupStaleTmps } from './reported-fingerprints';
import { resolveActiveApiKey, resolveApiKeyWithKeylessFallback } from './resolve-api-key';
import { withRun } from './runContext';
import { resolveUseAgentRuntime } from './runtime-flag';
import { registerSkillsIpc, registerSkillsUnavailableIpc } from './skills-ipc';
import {
  appendChatMessage,
  getBudget,
  getDesign,
  getDesignUsageTotals,
  listChatMessages,
  listDailyUsage,
  listDesignFiles,
  listUserSkills,
  normalizeDesignFilePath,
  pruneDiagnosticEvents,
  recordDiagnosticEvent,
  recordRunUsage,
  recordToolDuration,
  safeInitSnapshotsDb,
  upsertBudget,
  upsertDesignFile,
} from './snapshots-db';
import {
  registerSnapshotsIpc,
  registerSnapshotsUnavailableIpc,
  registerWorkspaceIpc,
} from './snapshots-ipc';
import { initStorageSettings } from './storage-settings';

// ESM shim: package.json "type": "module" means the built bundle is ESM and
// __dirname/__filename don't exist. Derive them from import.meta.url so the
// existing join(__dirname, '../preload/...') calls keep working.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: ElectronBrowserWindow | null = null;
// Cached update-available payload so a window opened after the event still
// shows the banner. Cleared only on app quit (matching the one-shot nature
// of autoUpdater — a new check will re-emit if still applicable).
let pendingUpdateAvailable: unknown = null;

// pi-agent-core does NOT forward `cacheRetention` from AgentOptions through to
// streamSimple, but pi-ai's anthropic adapter reads PI_CACHE_RETENTION from the
// environment. Pinning this here ensures the agent path gets the same prompt-
// cache treatment as the legacy `complete()` path (which sets cacheRetention
// explicitly). 'short' matches pi-ai's own default — this is belt-and-braces.
process.env['PI_CACHE_RETENTION'] ??= 'short';

const defaultUserDataDir = app.getPath('userData');
const storageLocations = initStorageSettings(defaultUserDataDir);
if (storageLocations.dataDir !== undefined) {
  mkdirSync(storageLocations.dataDir, { recursive: true });
  app.setPath('userData', storageLocations.dataDir);
}

// Phase 1 — content-addressed image asset cache. Lazy: dir created on first
// put. Lives at userData so it survives app updates but follows storage
// relocation if the user picked a custom dataDir.
let _imageCache: ImageCache | null = null;
function imageCache(): ImageCache {
  if (_imageCache === null) _imageCache = makeImageCache(app.getPath('userData'));
  return _imageCache;
}

/**
 * motion-graphics-plan §4 / §0.5 — resolve the on-disk dir the motion
 * bundler reads source files out of and writes `.bundle/index.{html,js}`
 * into. Mirrors the `workspacePath` convention game/design designs use:
 * if the design has a workspacePath set, the bundler operates in there
 * (so `npx remotion studio` could open the same folder); otherwise we
 * fall back to a per-design dir under userData.
 */
function motionDesignDirFor(designId: string): string | null {
  if (_snapshotsDb === null) return null;
  try {
    const row = _snapshotsDb
      .prepare('SELECT workspace_path FROM designs WHERE id = ?')
      .get(designId) as { workspace_path?: string | null } | undefined;
    const workspacePath =
      row?.workspace_path !== undefined && row?.workspace_path !== null
        ? String(row.workspace_path)
        : null;
    if (workspacePath !== null) return workspacePath;
    return path_module.join(app.getPath('userData'), 'motion-designs', designId);
  } catch {
    return null;
  }
}

/** Set in `app.whenReady()` once safeInitSnapshotsDb succeeds; consumed by
 *  motionDesignDirFor() (which can be called from the protocol handler
 *  before mainWindow is even open). */
let _snapshotsDb: Database | null = null;

/**
 * Workstream B Phase 1 feature flag. When truthy, `codesign:*:generate` routes
 * through `generateViaAgent()` (pi-agent-core + tool runtime — text_editor,
 * set_todos, list_files, read_design_system, read_url, image-asset gen,
 * declare-tweak-schema, done).
 *
 * **Default ON**: streaming + tool-using edits are now the primary path. The
 * legacy single-turn `generate()` is kept as an opt-out escape hatch for at
 * least one minor version after the flip:
 *   - `USE_AGENT_RUNTIME=0` or `USE_AGENT_RUNTIME=false` → legacy path
 *   - any other value (including unset) → agent path
 *
 * `applyComment` and `generateTitle` continue to use the legacy path
 * regardless of this flag — they are small one-shot calls where the agent
 * loop overhead would slow them down, not speed them up.
 *
 * Read once at module init: changing the env var mid-session requires an app
 * restart, which matches every other flag we expose today.
 */
const USE_AGENT_RUNTIME = resolveUseAgentRuntime(process.env['USE_AGENT_RUNTIME']);

const IS_VITEST = process.env['VITEST'] === 'true';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: BRAND.backgroundColor,
    icon: join(__dirname, '../../resources/icon.png'),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  // Integration C — wire the BrowserWindow into the auth-refresh queue
  // so its lifecycle hooks (started / succeeded / failed) can emit IPC
  // events the renderer turns into a "Refreshing Claude Code credential…"
  // toast. Re-pointed on 'closed' so a stale window ref never gets used.
  setRefreshQueueWindow(mainWindow);
  // Null the reference on close so stale IPC sends from async emitters
  // (autoUpdater, long-running generate runs) become clean no-ops rather
  // than throwing "Object has been destroyed" on a discarded webContents.
  mainWindow.on('closed', () => {
    mainWindow = null;
    setRefreshQueueWindow(null);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    // Gate `window.open(...)` through the same allowlist as
    // `codesign:v1:open-external`, otherwise any renderer path that triggers
    // a new-window event could coerce the main process into opening an
    // attacker-controlled URL.
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Replay any update event that fired before this window was ready
  // (macOS: user closed window, triggered a manual Check for Updates from
  // the app menu, then reopened — the event would otherwise be lost).
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingUpdateAvailable !== null) {
      mainWindow?.webContents.send('codesign:update-available', pendingUpdateAvailable);
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

type Database = BetterSqlite3.Database;

/**
 * Pull an HTTP status code out of a caught provider error. Mirrors
 * `packages/providers/src/retry.ts::extractStatus` intentionally — we don't
 * import from retry.ts to avoid coupling main to a retry-internal helper
 * that might get reshaped. Used by the generate catch block to tag the
 * thrown err with `upstream_status` so the renderer's diagnose pipeline
 * can pick up a hypothesis.
 */
function extractUpstreamHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidates: unknown[] = [
    (err as { status?: unknown }).status,
    (err as { statusCode?: unknown }).statusCode,
    (err as { upstream_status?: unknown }).upstream_status,
    (err as { response?: { status?: unknown } }).response?.status,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 100 && c < 600) return c;
  }
  if (err instanceof Error) {
    const m = /\b(\d{3})\b/.exec(err.message);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (n >= 400 && n < 600) return n;
    }
  }
  return undefined;
}

/**
 * Token-shape detector for the OAuth-aware diagnose path. Returns true for:
 *   - Anthropic Claude Code OAuth (`sk-ant-oat-*`) — rotated by `claude login`.
 *   - JWT-shaped tokens (3 dot-separated base64url segments) — Codex
 *     ChatGPT sessions issued by `codex login`.
 * Both rotate via CLI rather than the app's Settings panel, so the
 * 401/403 error message + suggested fix should differ from the static
 * "open Settings to update key" copy.
 */
function isOAuthShapedToken(apiKey: string): boolean {
  if (looksLikeClaudeOAuthToken(apiKey)) return true;
  // JWT shape: header.payload.signature, all base64url. We don't verify
  // the signature — just recognise the format. The Codex login flow is
  // the only path producing these inside this app.
  const segments = apiKey.split('.');
  if (segments.length !== 3) return false;
  return segments.every((seg) => seg.length > 0 && /^[A-Za-z0-9_-]+$/.test(seg));
}

function resolveActiveApiKeyFromState(providerId: string): Promise<string> {
  return resolveActiveApiKey(providerId, {
    getCodexAccessToken: () => getCodexTokenStore().getValidAccessToken(),
    getApiKeyForProvider,
  });
}

function resolveApiKeyForActive(providerId: string, allowKeyless: boolean): Promise<string> {
  return resolveApiKeyWithKeylessFallback(providerId, allowKeyless, {
    getCodexAccessToken: () => getCodexTokenStore().getValidAccessToken(),
    getApiKeyForProvider,
  });
}

/**
 * Server-side history compactor for the auto-continue chunk loop.
 *
 * Two strategies, picked by `mode`:
 *
 *   `'slim'` (default for reasoning=off): emit a tiny 2-3-message
 *   digest — original user prompt + last assistant_text + a synthesized
 *   set_todos progress block. Drops input tokens 5-10x and shortens
 *   first-token latency at chunk transitions. Works because reasoning-off
 *   models can re-orient cheaply from a small context.
 *
 *   `'full'` (forced when reasoning is on): replay every user + assistant
 *   row up to a cap. Reasoning-on models lose chain-of-thought across
 *   chunk boundaries (Anthropic doesn't expose internal thinking blocks
 *   to subsequent API calls), so they MUST see prior assistant prose to
 *   pick up where they left off. Production trace 2026-04-27 showed
 *   reasoning=medium runs with the slim strategy re-planning every
 *   chunk and landing 0-1 tool calls per chunk.
 */
const HISTORY_FULL_CAP = 12;
/** Phase 2 — compact mode keeps the last N tool round-trips inline so a
 *  continuation can pick up the active edit chain without paying full-mode
 *  byte costs. Two pairs covers the typical "last edit + verify result"
 *  cadence; with Phase 1's cache hit on the system prefix the per-turn
 *  delta is negligible. */
const HISTORY_COMPACT_TOOL_PAIRS = 2;

function loadHistoryForAutoContinue(
  db: BetterSqlite3.Database | null,
  designId: string | null,
  mode: 'slim' | 'compact' | 'full' = 'compact',
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!db || !designId) return [];
  try {
    const rows = listChatMessages(db, designId);
    if (mode === 'full') {
      const all: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const row of rows) {
        if (row.kind === 'user') {
          const text = (row.payload as { text?: string } | null)?.text;
          if (typeof text === 'string' && text.length > 0) {
            all.push({ role: 'user', content: text });
          }
        } else if (row.kind === 'assistant_text') {
          const text = (row.payload as { text?: string } | null)?.text;
          if (typeof text === 'string' && text.length > 0) {
            all.push({ role: 'assistant', content: text });
          }
        }
      }
      return all.length > HISTORY_FULL_CAP ? all.slice(-HISTORY_FULL_CAP) : all;
    }
    if (mode === 'compact') {
      // Compact: first user prompt + last N tool_call→result pairs (rendered
      // as a tagged assistant block) + last assistant_text + todo digest.
      // This is the new default — cheap because Phase 1 caches the system
      // prefix, smarter than slim because the agent sees what just happened.
      let firstUserCompact: string | null = null;
      let lastAssistantCompact: string | null = null;
      let assistantTurnCountCompact = 0;
      let latestTodosCompact: Array<{ text: string; checked: boolean }> | null = null;
      const recentToolPayloads: Array<{
        toolName: string;
        args: unknown;
        status: string;
        result: unknown;
      }> = [];
      for (const row of rows) {
        if (row.kind === 'user' && firstUserCompact === null) {
          const text = (row.payload as { text?: string } | null)?.text;
          if (typeof text === 'string' && text.length > 0) firstUserCompact = text;
        } else if (row.kind === 'assistant_text') {
          const text = (row.payload as { text?: string } | null)?.text;
          if (typeof text === 'string' && text.length > 0) {
            lastAssistantCompact = text;
            assistantTurnCountCompact += 1;
          }
        } else if (row.kind === 'tool_call') {
          const payload = row.payload as {
            toolName?: string;
            args?: { items?: Array<{ text: unknown; checked: unknown }> };
            status?: string;
            result?: unknown;
          } | null;
          if (payload?.toolName === 'set_todos' && Array.isArray(payload.args?.items)) {
            const items: Array<{ text: string; checked: boolean }> = [];
            for (const it of payload.args.items) {
              if (typeof it?.text === 'string') {
                items.push({ text: it.text, checked: it.checked === true });
              }
            }
            if (items.length > 0) latestTodosCompact = items;
          }
          if (payload?.toolName !== undefined) {
            recentToolPayloads.push({
              toolName: payload.toolName,
              args: payload.args ?? {},
              status: payload.status ?? 'done',
              result: payload.result,
            });
          }
        }
      }
      const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (firstUserCompact) out.push({ role: 'user', content: firstUserCompact });
      const tail = recentToolPayloads.slice(-HISTORY_COMPACT_TOOL_PAIRS);
      if (tail.length > 0) {
        const lines = tail.map((p) => {
          const status = p.status === 'error' ? ' (error)' : '';
          let argsPreview = '';
          try {
            argsPreview = JSON.stringify(p.args ?? {}).slice(0, 240);
          } catch {
            argsPreview = '<unserializable args>';
          }
          let resultPreview = '';
          if (typeof p.result === 'string') resultPreview = p.result.slice(0, 240);
          else if (p.result !== undefined && p.result !== null) {
            try {
              resultPreview = JSON.stringify(p.result).slice(0, 240);
            } catch {
              resultPreview = '<unserializable result>';
            }
          }
          return `- ${p.toolName}${status} args=${argsPreview}${resultPreview.length > 0 ? `\n    → ${resultPreview}` : ''}`;
        });
        out.push({
          role: 'assistant',
          content: `[recent tool transcript — last ${tail.length} call${tail.length === 1 ? '' : 's'}]\n${lines.join('\n')}`,
        });
      }
      if (lastAssistantCompact) out.push({ role: 'assistant', content: lastAssistantCompact });
      if (latestTodosCompact) {
        const done = latestTodosCompact.filter((it) => it.checked).map((it) => `  ✓ ${it.text}`);
        const pending = latestTodosCompact
          .filter((it) => !it.checked)
          .map((it) => `  ○ ${it.text}`);
        const summary = [
          `[progress digest after ${assistantTurnCountCompact} prior agent turn(s)]`,
          ...(done.length > 0 ? ['', 'Completed sections:', ...done] : []),
          ...(pending.length > 0 ? ['', 'Remaining sections:', ...pending] : []),
        ].join('\n');
        out.push({ role: 'assistant', content: summary });
      }
      return out;
    }
    let firstUserPrompt: string | null = null;
    let lastAssistantText: string | null = null;
    let latestTodos: Array<{ text: string; checked: boolean }> | null = null;
    let assistantTurnCount = 0;
    for (const row of rows) {
      if (row.kind === 'user' && firstUserPrompt === null) {
        const text = (row.payload as { text?: string } | null)?.text;
        if (typeof text === 'string' && text.length > 0) firstUserPrompt = text;
      } else if (row.kind === 'assistant_text') {
        const text = (row.payload as { text?: string } | null)?.text;
        if (typeof text === 'string' && text.length > 0) {
          lastAssistantText = text;
          assistantTurnCount += 1;
        }
      } else if (row.kind === 'tool_call') {
        const payload = row.payload as {
          toolName?: string;
          args?: { items?: Array<{ text: unknown; checked: unknown }> };
        } | null;
        if (payload?.toolName === 'set_todos' && Array.isArray(payload.args?.items)) {
          const items: Array<{ text: string; checked: boolean }> = [];
          for (const it of payload.args.items) {
            if (typeof it?.text === 'string') {
              items.push({ text: it.text, checked: it.checked === true });
            }
          }
          if (items.length > 0) latestTodos = items;
        }
      }
    }
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (firstUserPrompt) out.push({ role: 'user', content: firstUserPrompt });
    if (lastAssistantText) out.push({ role: 'assistant', content: lastAssistantText });
    if (latestTodos) {
      const done = latestTodos.filter((it) => it.checked).map((it) => `  ✓ ${it.text}`);
      const pending = latestTodos.filter((it) => !it.checked).map((it) => `  ○ ${it.text}`);
      const summary = [
        `[progress digest after ${assistantTurnCount} prior agent turn(s)]`,
        ...(done.length > 0 ? ['', 'Completed sections:', ...done] : []),
        ...(pending.length > 0 ? ['', 'Remaining sections:', ...pending] : []),
      ].join('\n');
      out.push({ role: 'assistant', content: summary });
    }
    return out;
  } catch {
    return [];
  }
}

// Implementations live in `./sidecar-inliner.ts` (no Electron deps) so
// unit tests can exercise them in isolation. Re-exported here so existing
// imports of these names from `./index.ts` continue to work unchanged.
import { inlineLocalSidecars, resolveLocalAssetRefs } from './sidecar-inliner';
export { inlineLocalSidecars, resolveLocalAssetRefs };

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function sanitizeAssetStem(input: string | undefined, fallback: string): string {
  const raw = input?.trim() || fallback;
  const stem = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return stem.length > 0 ? stem : 'image-asset';
}

/**
 * Detect whether `oldStr` looks like it was copy-pasted from a `view`
 * output that prepends `   123  ` line-number prefixes. Two modes:
 *   - "uniform": EVERY non-empty line begins with optional whitespace +
 *      1+ digits + two spaces. Cleanest signal — copy-paste of a contiguous
 *      view block. Always strip-and-retry.
 *   - "mixed": ≥50% of non-empty lines have the prefix. Happens when the
 *      model partially edited the view output (e.g. removed prefixes from
 *      lines it changed but kept them on context lines). The recovery is
 *      still safe: stripping a non-prefixed line is a no-op (regex misses).
 *      The 50% threshold avoids false positives where a content line just
 *      happens to start with a number followed by two spaces (rare but
 *      possible in JSX text content, e.g. `42  reasons we love it`).
 */
function hasLineNumberPrefix(oldStr: string): boolean {
  const lines = oldStr.split('\n');
  let nonEmpty = 0;
  let prefixed = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    nonEmpty += 1;
    if (/^\s*\d+ {2}/.test(line)) prefixed += 1;
  }
  if (nonEmpty === 0) return false;
  // Single-line snippets need an unambiguous match — only return true when
  // there's no ambiguity (the entire line IS the prefix pattern).
  if (nonEmpty === 1) return prefixed === 1;
  // Multi-line: uniform OR ≥50% prefixed both indicate copy-paste contamination.
  return prefixed >= Math.ceil(nonEmpty * 0.5);
}

/** Strip the `view` line-number prefix from each line of `oldStr` —
 *  matching the format emitted in text-editor.ts case 'view':
 *  `${String(start + i).padStart(4, ' ')}  ${ln}`. Per-line; lines without
 *  the prefix pass through unchanged (the regex just misses them). */
function stripLineNumberPrefix(oldStr: string): string {
  return oldStr
    .split('\n')
    .map((line) => line.replace(/^\s*\d+ {2}/, ''))
    .join('\n');
}

/** Count `\n` characters in a string. Used to convert byte offsets in the
 *  pre/post-edit file content into 1-indexed line numbers for the str_replace
 *  / insert success messages. Avoids `split('\n').length` which allocates an
 *  array we'd immediately throw away. */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

function allocateAssetPath(
  files: Map<string, string>,
  request: GenerateImageAssetRequest,
  mimeType: string,
): string {
  const stem = sanitizeAssetStem(request.filenameHint, request.purpose);
  const ext = extensionFromMimeType(mimeType);
  let path = `assets/${stem}.${ext}`;
  for (let i = 2; files.has(path); i++) {
    path = `assets/${stem}-${i}.${ext}`;
  }
  return path;
}

interface CreateRuntimeTextEditorFsOptions {
  db: BetterSqlite3.Database | null;
  generationId: string;
  designId: string | null;
  previousHtml: string | null;
  sendEvent: (event: AgentStreamEvent) => void;
  logger: Pick<CoreLogger, 'error'> & Partial<Pick<CoreLogger, 'warn'>>;
  /** motion-graphics-plan §4 — when 'motion', text_editor writes also
   *  mirror into the on-disk motion design dir so the bundler can read
   *  them, and trigger a debounced bundle. */
  artifactType?: 'design' | 'game' | 'motion' | undefined;
}

export function createRuntimeTextEditorFs({
  db,
  generationId,
  designId,
  previousHtml,
  sendEvent,
  logger,
  artifactType,
}: CreateRuntimeTextEditorFsOptions) {
  const baseCtx = { designId: designId ?? '', generationId } as const;
  const fsMap = new Map<string, string>();
  if (previousHtml && previousHtml.trim().length > 0) {
    fsMap.set('index.html', previousHtml);
  }
  // Seed every existing design_files row into the runtime fs so the
  // agent can read non-index.html artefacts the user (or a prior run)
  // placed inside the design — reference docs, sidecar JS/CSS,
  // restoration notes, etc. Without this seed, only `index.html`
  // (via previousHtml) was reachable; any docs/<x>.md or src/<y>.js the
  // user added directly to design_files surfaced as "Path not found"
  // when the agent tried to view them. Skip 'index.html' to avoid
  // overwriting the previousHtml the IPC layer just resolved (which
  // may include in-flight inlining).
  if (db !== null && designId !== null) {
    try {
      for (const file of listDesignFiles(db, designId)) {
        if (file.path === 'index.html') continue;
        // Defensive: better-sqlite3 returns BLOB-stored values as
        // Buffer; downstream consumers (text_editor view → content.split)
        // assume string. Coerce here so a BLOB row doesn't crash the
        // run with "content.split is not a function". Production rows
        // written via upsertDesignFile are already TEXT; this catches
        // out-of-band inserts and binary uploads.
        const raw = file.content as unknown;
        const content =
          typeof raw === 'string'
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString('utf8')
              : String(raw ?? '');
        fsMap.set(file.path, content);
      }
    } catch (err) {
      logger.error('runtime.fs.seed_design_files.fail', {
        designId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Backlog-3 §8 — frame + skill templates (~250KB combined) are loaded
  // lazily and seeded into the fs map. Synchronous fast path: if they
  // were already loaded by a prior generation, copy from the cached
  // module exports immediately. Otherwise schedule a microtask to seed
  // before the first agent tool runs (the agent's first action is
  // always set_todos, never view of frames/* or skills/*).
  if (_FRAME_TEMPLATES !== null) {
    for (const [name, content] of _FRAME_TEMPLATES) fsMap.set(`frames/${name}`, content);
  }
  if (_DESIGN_SKILLS !== null) {
    for (const [name, content] of _DESIGN_SKILLS) fsMap.set(`skills/${name}`, content);
  }
  if (_FRAME_TEMPLATES === null || _DESIGN_SKILLS === null) {
    // Fire and forget — seeded before any tool that would view frames/*
    // or skills/*. The agent's standard cadence is set_todos → view
    // index.html → str_replace, so frames/skills hits land at turn 3+
    // at the earliest, leaving 2-3 LLM round-trips for these to land.
    void Promise.all([loadFrameTemplates(), loadDesignSkills()]).then(([frames, skills]) => {
      for (const [name, content] of frames) {
        if (!fsMap.has(`frames/${name}`)) fsMap.set(`frames/${name}`, content);
      }
      for (const [name, content] of skills) {
        if (!fsMap.has(`skills/${name}`)) fsMap.set(`skills/${name}`, content);
      }
    });
  }

  function emitFsUpdated(filePath: string, content: string): void {
    if (designId === null) return;
    // For index.html: inline sidecar CSS/JS (vanilla pattern), then
    // resolve assets/* data: URLs. JSX-pattern HTML has no <link> or
    // <script src> to local files so the inliner is a no-op for it.
    // Order matters: inlining first so inlined <style>/<script> blocks
    // ALSO get assets/ refs resolved (rare but possible — e.g. CSS
    // url('assets/bg.png')).
    const resolved =
      filePath === 'index.html'
        ? resolveLocalAssetRefs(inlineLocalSidecars(content, fsMap), fsMap)
        : content;
    sendEvent({ ...baseCtx, type: 'fs_updated', path: filePath, content: resolved });
  }

  function emitIndexIfAssetChanged(filePath: string): void {
    if (!filePath.startsWith('assets/')) return;
    const index = fsMap.get('index.html');
    if (index !== undefined) emitFsUpdated('index.html', index);
  }

  async function persistMutation(filePath: string, content: string): Promise<void> {
    if (designId === null || db === null) return;
    const normalizedPath = normalizeDesignFilePath(filePath);
    const design = getDesign(db, designId);
    if (design?.workspacePath !== null && design !== null) {
      const destinationPath = path_module.join(design.workspacePath, normalizedPath);
      try {
        await mkdir(path_module.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, content, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('runtime.fs.writeThrough.fail', {
          designId,
          filePath,
          workspacePath: design.workspacePath,
          message,
        });
        throw new Error(`Workspace write-through failed for ${filePath}: ${message}`);
      }
    }

    upsertDesignFile(db, designId, normalizedPath, content);

    // motion-graphics-plan §4 — for motion runs the bundler reads source
    // files off disk. When no workspacePath is set, mirror the write into
    // the motion design dir (`userData/motion-designs/<id>/`). Then
    // schedule a debounced bundle so the iframe picks it up.
    if (artifactType === 'motion') {
      const motionDir = motionDesignDirFor(designId);
      if (motionDir !== null && motionDir !== design?.workspacePath) {
        const destinationPath = path_module.join(motionDir, normalizedPath);
        try {
          await mkdir(path_module.dirname(destinationPath), { recursive: true });
          await writeFile(destinationPath, content, 'utf8');
        } catch (err) {
          logger.warn?.('motion.fs.writeThrough.fail', {
            designId,
            filePath: normalizedPath,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      notifyMotionFileWrite(designId, normalizedPath);
    }
  }

  const fs = {
    view(path: string) {
      const content = fsMap.get(path);
      if (content === undefined) return null;
      return { content, numLines: content.split('\n').length };
    },
    async create(path: string, content: string) {
      await persistMutation(path, content);
      fsMap.set(path, content);
      emitFsUpdated(path, content);
      emitIndexIfAssetChanged(path);
      return { path };
    },
    async strReplace(path: string, oldStr: string, newStr: string) {
      const current = fsMap.get(path);
      if (current === undefined) throw new Error(`File not found: ${path}`);
      // Match #1: exact substring. Always tried first so well-formed
      // old_str strings stay on the fast path and ambiguity detection works.
      let idx = current.indexOf(oldStr);
      let matchedOldStr = oldStr;
      // Match #2 (recovery): strip the leading line-number prefix that
      // `view` prepends to each line of its output (`   123  <body>` →
      // `<body>`). Production traces from 2026-04-28 showed the agent
      // copy-pasting view output verbatim into old_str and getting
      // "old_str not found" errors it described as "JSX encoding
      // issues". Easy to detect: every line of old_str starts with
      // optional whitespace + 1+ digits + two spaces. If yes, strip and
      // retry. Idempotent: when old_str is already clean this regex
      // doesn't match (no digits in source), and the path is skipped.
      if (idx === -1 && hasLineNumberPrefix(oldStr)) {
        const stripped = stripLineNumberPrefix(oldStr);
        if (stripped !== oldStr) {
          const recoveryIdx = current.indexOf(stripped);
          if (recoveryIdx !== -1) {
            idx = recoveryIdx;
            matchedOldStr = stripped;
          }
        }
      }
      if (idx === -1) throw new Error(`old_str not found in ${path}`);
      if (current.indexOf(matchedOldStr, idx + matchedOldStr.length) !== -1) {
        throw new Error(`old_str is ambiguous in ${path}; provide more context`);
      }
      const next = current.slice(0, idx) + newStr + current.slice(idx + matchedOldStr.length);
      await persistMutation(path, next);
      fsMap.set(path, next);
      emitFsUpdated(path, next);
      emitIndexIfAssetChanged(path);
      // Post-edit position: 1-indexed start line is "newlines before idx + 1".
      // For a deletion (newStr === ''), endLine = startLine - 1 by convention
      // so the tool can format "Removed content at line N" cleanly.
      const startLine = countNewlines(current.slice(0, idx)) + 1;
      const endLine = newStr.length === 0 ? startLine - 1 : startLine + countNewlines(newStr);
      const totalLines = countNewlines(next) + 1;
      return { path, startLine, endLine, totalLines };
    },
    async insert(path: string, line: number, text: string) {
      const current = fsMap.get(path) ?? '';
      const lines = current.split('\n');
      const clamped = Math.max(0, Math.min(line, lines.length));
      lines.splice(clamped, 0, text);
      const next = lines.join('\n');
      await persistMutation(path, next);
      fsMap.set(path, next);
      emitFsUpdated(path, next);
      emitIndexIfAssetChanged(path);
      // `clamped` is 0 = "before line 1", 1 = "before line 2", etc., so the
      // first new line is always at 1-indexed `clamped + 1`. `text` may itself
      // contain newlines; one inserted line + N internal newlines = N+1
      // resulting lines.
      const startLine = clamped + 1;
      const endLine = startLine + countNewlines(text);
      const totalLines = next.split('\n').length;
      return { path, startLine, endLine, totalLines };
    },
    async patch(
      path: string,
      hunks: Array<{
        startLine: number;
        endLine: number;
        replacement: string;
        expectedOriginal?: string | undefined;
      }>,
    ) {
      // Backlog-3 §2 — apply hunks in descending startLine order so
      // earlier (lower line) hunks don't invalidate later ones'
      // numbers. Validate every hunk's bounds + optional
      // expectedOriginal BEFORE mutating, so a single bad hunk doesn't
      // leave the file half-edited.
      const current = fsMap.get(path);
      if (current === undefined) throw new Error(`File not found: ${path}`);
      const lines = current.split('\n');
      const totalLinesBefore = lines.length;
      const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
      // Validate all bounds first.
      for (const h of sorted) {
        if (
          !Number.isInteger(h.startLine) ||
          !Number.isInteger(h.endLine) ||
          h.startLine < 1 ||
          h.endLine < h.startLine - 1 ||
          h.endLine > totalLinesBefore
        ) {
          throw new Error(
            `patch hunk has invalid line range [${h.startLine}, ${h.endLine}] (file has ${totalLinesBefore} lines, 1-indexed inclusive endLine).`,
          );
        }
        if (h.expectedOriginal !== undefined) {
          const sliceLines = lines.slice(h.startLine - 1, h.endLine);
          const actual = sliceLines.join('\n');
          if (actual !== h.expectedOriginal) {
            // Improver1 §2 — embed the actual current bytes inline so
            // the agent doesn't need a follow-up view turn. Today's
            // run-1 had 2 patch retries with the same stale
            // expectedOriginal because the prior generic message
            // didn't surface the current content.
            const before = Math.max(1, h.startLine - 5);
            const after = Math.min(lines.length, h.endLine + 5);
            const window: string[] = [];
            for (let i = before; i <= after; i += 1) {
              window.push(`${String(i).padStart(4, ' ')}  ${lines[i - 1] ?? ''}`);
            }
            throw new Error(
              `patch hunk at lines ${h.startLine}-${h.endLine}: expectedOriginal does not match current content. The file has shifted since you last viewed.\n\nCURRENT CONTENT (lines ${before}-${after} of ${path}):\n${window.join('\n')}\n\nNext step: rebuild your hunk's expectedOriginal from the bytes above, OR drop expectedOriginal entirely if you trust the line range. Do NOT retry with the same expectedOriginal.`,
            );
          }
        }
      }
      // Apply.
      let firstStartLine = Number.MAX_SAFE_INTEGER;
      let lastEndLineAfter = 0;
      for (const h of sorted) {
        const replacementLines = h.replacement.length === 0 ? [] : h.replacement.split('\n');
        lines.splice(h.startLine - 1, h.endLine - h.startLine + 1, ...replacementLines);
        if (h.startLine < firstStartLine) firstStartLine = h.startLine;
        // Recompute the endLine post-splice for THIS hunk (only meaningful
        // for the lowest-startLine one because higher startLines apply
        // first and don't shift earlier line numbers).
        lastEndLineAfter = Math.max(
          lastEndLineAfter,
          h.startLine + Math.max(0, replacementLines.length - 1),
        );
      }
      const next = lines.join('\n');
      await persistMutation(path, next);
      fsMap.set(path, next);
      emitFsUpdated(path, next);
      emitIndexIfAssetChanged(path);
      const totalLines = lines.length;
      return {
        path,
        startLine: firstStartLine === Number.MAX_SAFE_INTEGER ? 1 : firstStartLine,
        endLine: lastEndLineAfter,
        totalLines,
      };
    },
    listDir(dir: string) {
      const prefix = dir.length === 0 || dir === '.' ? '' : `${dir.replace(/\/+$/, '')}/`;
      const entries = new Set<string>();
      for (const p of fsMap.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const firstSegment = rest.split('/')[0];
        if (firstSegment) entries.add(firstSegment);
      }
      return [...entries].sort();
    },
  };

  return { fs, fsMap };
}

function registerIpcHandlers(db: Database | null): void {
  const logIpc = getLogger('main:ipc');

  // Cache of the last NormalizedProviderError seen per run, so recordFinalError
  // can attach it to the final (non-transient) row. Without this, the row the
  // user actually reports lacks upstream_request_id / status — those fields
  // lived only on the hidden transient sibling row emitted by retry.ts.
  // Implementation + LRU eviction lives in ./provider-context.ts.
  const providerContext = createProviderContextStore(50);

  const recordFinalError = (scope: string, runId: string, err: unknown): void => {
    if (db === null) return;
    const code = err instanceof CodesignError ? (err.code as string) : 'PROVIDER_UPSTREAM_ERROR';
    const stack = err instanceof Error ? err.stack : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const context = providerContext.consume(runId);
    recordDiagnosticEvent(db, {
      level: 'error',
      code,
      scope,
      runId,
      fingerprint: computeFingerprint({ errorCode: code, stack, message }),
      message,
      stack,
      transient: false,
      ...(context !== undefined ? { context } : {}),
    });
  };

  if (USE_AGENT_RUNTIME) {
    logIpc.info('generate.runtime.agent_enabled', {
      env: 'USE_AGENT_RUNTIME',
      phase: 1,
    });
  }

  /** Adapter so `core` can log step events through the same scoped electron-log
   * sink the IPC handler uses. Keeps a single timeline per generation in the
   * log file without forcing `core` to depend on electron-log.
   *
   * Only `provider.error` (retry in flight, transient=true) is persisted from
   * this adapter; the `provider.error.final` event is NOT recorded because the
   * outer handler's catch block calls `recordFinalError` — recording both
   * would double-count the same failure with two distinct fingerprints. */
  const coreLoggerFor = (id: string): CoreLogger => ({
    info: (event, data) => logIpc.info(event, { generationId: id, ...(data ?? {}) }),
    warn: (event, data) => {
      logIpc.warn(event, { generationId: id, ...(data ?? {}) });
      if (event === 'provider.error' && db !== null) {
        const code = 'PROVIDER_UPSTREAM_ERROR';
        const upstream =
          data !== undefined && typeof data['upstream_message'] === 'string'
            ? (data['upstream_message'] as string)
            : event;
        // Fingerprint basis: errorCode + synthetic frame containing the two
        // fields that truly differentiate provider errors — upstream_status
        // and upstream_code. JSON-stringifying `data` and passing it as
        // `stack` would produce an identical 8-hex for every provider error
        // because `extractTopFrames` requires lines starting with "at ".
        const status =
          typeof data?.['upstream_status'] === 'number' ? data['upstream_status'] : '?';
        const upstreamCode =
          typeof data?.['upstream_code'] === 'string' ? data['upstream_code'] : 'unknown';
        const syntheticFrame = `    at provider (${status}:${upstreamCode})`;
        // Stash the normalized context so recordFinalError can attach it to
        // the final non-transient row — otherwise the reported row loses
        // upstream_request_id / upstream_status, which lived only on this
        // hidden transient sibling.
        if (data !== undefined) providerContext.remember(id, data);
        recordDiagnosticEvent(db, {
          level: 'warn',
          code,
          scope: 'provider',
          runId: id,
          fingerprint: computeFingerprint({
            errorCode: code,
            stack: syntheticFrame,
            message: upstream,
          }),
          message: upstream,
          stack: undefined,
          transient: true,
          ...(data !== undefined ? { context: data } : {}),
        });
      }
    },
    error: (event, data) => logIpc.error(event, { generationId: id, ...(data ?? {}) }),
  });

  /**
   * Phase 1 flag dispatcher. When `USE_AGENT_RUNTIME` is off, passes through
   * to `generate()` unchanged. When on, routes through `generateViaAgent()`
   * and forwards normalized `AgentEvent`s to the renderer via
   * `agent:event:v1` so the sidebar chat can render incremental output
   * instead of waiting for the full final message.
   */
  const runGenerate = (
    input: Parameters<typeof generate>[0],
    id: string,
    designId: string | null,
    previousHtml: string | null,
  ): ReturnType<typeof generate> => {
    if (!USE_AGENT_RUNTIME) return generate(input);

    // plan0305 P2.4 — main-process heartbeat to bridge the silent gap
    // between thinking_end / a long pi-ai turn and the next visible event.
    // Track wall-clock time of the last outbound event of any kind; when the
    // gap exceeds HEARTBEAT_IDLE_MS the timer ticks a `heartbeat` event so
    // the renderer can keep the thinking panel alive with an elapsed
    // counter instead of clearing to a frozen-looking empty state.
    let lastEventAt = Date.now();
    const HEARTBEAT_IDLE_MS = 5_000;
    const HEARTBEAT_POLL_MS = 2_000;
    const sendEventInner = (event: AgentStreamEvent) => {
      mainWindow?.webContents.send('agent:event:v1', event);
    };
    const sendEvent = (event: AgentStreamEvent) => {
      lastEventAt = Date.now();
      sendEventInner(event);
    };
    const baseCtx = { designId: designId ?? '', generationId: id } as const;
    const heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const sinceMs = now - lastEventAt;
      if (sinceMs < HEARTBEAT_IDLE_MS) return;
      // Bypass the wrapping sendEvent — we don't want heartbeats to reset
      // their own idle counter (otherwise the user would see a steady
      // stream of "still thinking" pings even when the model produces
      // nothing). The next real event will reset lastEventAt.
      sendEventInner({ ...baseCtx, type: 'heartbeat', sinceMs });
    }, HEARTBEAT_POLL_MS);
    const stopHeartbeat = () => clearInterval(heartbeatTimer);
    const toolStartedAt = new Map<string, number>();
    const runtimeVerify = makeRuntimeVerifier();
    const renderPreview = makeRenderPreviewer();
    const playtester = makePlaytester();
    const { fs, fsMap } = createRuntimeTextEditorFs({
      db,
      designId,
      generationId: id,
      logger: logIpc,
      previousHtml,
      sendEvent,
      artifactType: input.artifactType,
    });
    const cfg = getCachedConfig();
    const imageConfig = cfg ? resolveImageGenerationConfig(cfg) : null;
    const imageLog = getLogger('image-generation');
    const generateImageAsset = imageConfig
      ? async (
          request: GenerateImageAssetRequest,
          signal?: AbortSignal,
        ): Promise<GenerateImageAssetResult> => {
          const started = Date.now();
          const options = toGenerateImageOptions(
            imageConfig,
            request.prompt,
            signal,
            request.aspectRatio,
          );
          imageLog.info('provider.request', {
            generationId: id,
            provider: options.provider,
            model: options.model,
            size: options.size,
            aspectRatio: request.aspectRatio ?? 'default',
            purpose: request.purpose,
            quality: options.quality,
            outputFormat: options.outputFormat,
            promptChars: options.prompt.length,
          });
          // Backlog-3 §4 — synthetic progress for image-asset gen.
          // The provider call is opaque (no bytes-arrived callback) so
          // we tick 25/50/75% on a timer until either the response
          // lands or 90% (the response is "imminent" but unknown).
          // Renderer accumulates per toolCallId and closes on the
          // corresponding `tool_call_result` event.
          const toolCallIdForDelta = `image-asset-${id}-${Date.now()}`;
          let progressPct = 0;
          const progressTimer = setInterval(() => {
            if (progressPct >= 90) return;
            progressPct = Math.min(90, progressPct + 25);
            sendEvent({
              ...baseCtx,
              type: 'tool_result_delta',
              toolCallId: toolCallIdForDelta,
              progressPct,
              resultPreview: `Generating image (~${progressPct}%)…`,
            });
          }, 5000);
          // Phase 1 — content-addressed cache hit short-circuits the
          // 20–60s provider round-trip when the agent reissues the same
          // (provider, model, prompt, size, ...) tuple.
          const cacheKey = {
            provider: options.provider,
            model: options.model,
            prompt: options.prompt,
            size: options.size,
            quality: options.quality,
            outputFormat: options.outputFormat,
            aspectRatio: request.aspectRatio,
          };
          const cached = imageCache().get(cacheKey);
          if (cached !== null) {
            clearInterval(progressTimer);
            const path = allocateAssetPath(fsMap, request, cached.mimeType);
            imageLog.info('provider.cache_hit', {
              generationId: id,
              provider: cached.provider,
              model: cached.model,
              path,
              ms: Date.now() - started,
            });
            return {
              path,
              dataUrl: cached.dataUrl,
              mimeType: cached.mimeType,
              model: cached.model,
              provider: cached.provider,
              ...(cached.revisedPrompt !== undefined
                ? { revisedPrompt: cached.revisedPrompt }
                : {}),
            };
          }
          try {
            const image = await generateImage(options);
            clearInterval(progressTimer);
            const path = allocateAssetPath(fsMap, request, image.mimeType);
            imageLog.info('provider.ok', {
              generationId: id,
              provider: image.provider,
              model: image.model,
              path,
              ms: Date.now() - started,
              revised: image.revisedPrompt !== undefined,
            });
            imageCache().put(cacheKey, {
              dataUrl: image.dataUrl,
              mimeType: image.mimeType,
              model: image.model,
              provider: image.provider,
              ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
            });
            return {
              path,
              dataUrl: image.dataUrl,
              mimeType: image.mimeType,
              model: image.model,
              provider: image.provider,
              ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
            };
          } catch (err) {
            clearInterval(progressTimer);
            imageLog.warn('provider.fail', {
              generationId: id,
              provider: options.provider,
              model: options.model,
              ms: Date.now() - started,
              message: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        }
      : undefined;

    // Per-turn counters so we can emit a single summary line at turn_end
    // instead of a log per token delta.
    let deltaCount = 0;
    let toolCount = 0;
    // Phase 4 of pause-prune-fix-2026-05-08 — disambiguate empty-token
    // turn_end events (run mox8xixd-j8cr2o turn 12 had deltas=0,
    // tools=0, inputTokens=0 with no way to tell whether the model
    // returned empty or the abort cancelled the request mid-flight).
    // Captured at turn_start, compared against the live signal at
    // turn_end to attribute the zero-token outcome to one of three
    // distinct causes.
    let turnStartSignalAborted = false;

    // Per-RUN aggregators (Group A2: agent.run_summary). Counts every tool
    // execution by name, separates failures by name, tracks the longest
    // single tool call, and bookends with start time so totalMs is exact
    // even when the upstream wall-clock timer races a deferred abort.
    const runStartedAt = Date.now();
    const toolByName = new Map<string, number>();
    const toolFailByName = new Map<string, number>();
    const failedToolErrors: Array<{ tool: string; snippet: string }> = [];
    let slowestToolMs = 0;
    let slowestToolName = '';
    let totalTurns = 0;

    // backlog-2 #7 — user-authored skills, loaded once per run from the
    // local DB. Empty array on DB-unavailable or zero saved skills.
    const userSkills: ReadonlyArray<readonly [string, string]> = db
      ? listUserSkills(db).map((s) => [s.name, `// when_to_use: ${s.whenToUse}\n${s.source}`])
      : [];

    /**
     * Extract the first ~240 chars of the error message a tool returned.
     * The agent runtime treats `result.content` as the model-facing text
     * payload; for thrown errors that's where pi-agent-core puts the
     * message. We don't try to JSON-parse — just slice text so the dev log
     * stays human-readable.
     */
    const extractToolErrorSnippet = (result: unknown): string => {
      if (typeof result === 'string') return result.slice(0, 240);
      if (typeof result !== 'object' || result === null) return '';
      const content = (result as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        const direct = result as { errorMessage?: unknown; message?: unknown };
        const msg =
          typeof direct.errorMessage === 'string'
            ? direct.errorMessage
            : typeof direct.message === 'string'
              ? direct.message
              : '';
        return msg.slice(0, 240);
      }
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          return ((block as { text: string }).text || '').slice(0, 240);
        }
      }
      return '';
    };

    // gameplan §A5 + §A6 — wire game-mode tools when the IPC payload
    // requested it. The engine is captured into a per-run mutable that
    // choose_engine writes to; validate_game_scene reads from the same
    // mutable to dispatch into the runtime adapter registry. The runtime
    // import is lazy so design-mode runs pay nothing.
    type GameModeDeps = NonNullable<GenerateViaAgentDeps['gameMode']>;
    const gameMode: GameModeDeps | undefined = ((): GameModeDeps | undefined => {
      const isGameRun = input.artifactType === 'game';
      if (!isGameRun) return undefined;
      let currentEngine: GameEngine | null =
        input.engine !== undefined ? (input.engine as GameEngine) : null;
      const artifactRegistry: GameModeDeps['artifactRegistry'] | undefined =
        designId !== null && db !== null ? buildArtifactRegistryDeps(db, designId) : undefined;
      return {
        setEngine(engine) {
          currentEngine = engine as GameEngine;
        },
        getCurrentEngine: () => currentEngine,
        validate: async (engine, files) => {
          const { getEngineAdapter } = await import('@open-codesign/runtime');
          const adapter = getEngineAdapter(engine as GameEngine);
          if (adapter === null) {
            return {
              ok: false,
              engine,
              issues: [
                {
                  path: '',
                  message: `Engine "${engine}" has no adapter registered yet (Phase A ships three + phaser; Phase B/C add godot + pygame).`,
                  severity: 'error' as const,
                },
              ],
            };
          }
          const result = adapter.validate(files);
          return result.ok
            ? { ok: true, engine, issues: [] }
            : { ok: false, engine, issues: result.issues };
        },
        playtester,
        ...(artifactRegistry !== undefined ? { artifactRegistry } : {}),
      };
    })();
    // motion-graphics-plan §3 — wire motion-mode tools when the IPC
    // payload requested it. Style is captured into a per-run mutable
    // that `choose_remotion_style` writes to. The validator + still
    // renderer lazy-import @remotion/bundler / @remotion/renderer so
    // design + game runs pay nothing.
    type MotionModeDeps = NonNullable<GenerateViaAgentDeps['motionMode']>;
    const motionMode: MotionModeDeps | undefined = ((): MotionModeDeps | undefined => {
      const isMotionRun = input.artifactType === 'motion';
      if (!isMotionRun) return undefined;
      let currentStyle: '2d' | '3d' | 'kinetic-text' | 'data-viz' | 'mixed' | null =
        input.motionStyle ?? null;
      const validatorAndRenderer = buildMotionModeRuntime(designId, db);
      return {
        setStyle(style) {
          currentStyle = style;
        },
        getCurrentStyle: () => currentStyle,
        validate: validatorAndRenderer.validate,
        ...(validatorAndRenderer.renderStill !== undefined
          ? { renderStill: validatorAndRenderer.renderStill }
          : {}),
        ...(validatorAndRenderer.compositionRegistry !== undefined
          ? { compositionRegistry: validatorAndRenderer.compositionRegistry }
          : {}),
      };
    })();
    return generateViaAgent(input, {
      fs,
      runtimeVerify,
      renderPreview,
      userSkills,
      ...(gameMode !== undefined ? { gameMode } : {}),
      ...(motionMode !== undefined ? { motionMode } : {}),
      ...(generateImageAsset !== undefined ? { generateImageAsset } : {}),
      onEvent: (event: AgentEvent) => {
        // High-signal only. Skip per-token deltas and inner message_*
        // markers. Emit a concise summary at turn_end.
        if (event.type === 'turn_start') {
          deltaCount = 0;
          toolCount = 0;
          totalTurns += 1;
          turnStartSignalAborted = input.signal?.aborted === true;
          logIpc.info('agent.turn_start', { generationId: id });
        } else if (event.type === 'message_update') {
          const ame = event.assistantMessageEvent;
          if (ame.type === 'text_delta') deltaCount += 1;
        } else if (event.type === 'tool_execution_start') {
          toolCount += 1;
          const tn = event.toolName ?? 'unknown';
          toolByName.set(tn, (toolByName.get(tn) ?? 0) + 1);
          // Backlog-3 §2 telemetry — count text_editor sub-commands
          // separately so we can measure patch-protocol adoption.
          // The `command` arg lives on the tool's args object.
          if (tn === 'str_replace_based_edit_tool') {
            const cmd = (event as unknown as { args?: { command?: unknown } }).args?.command;
            if (typeof cmd === 'string' && cmd.length > 0) {
              const key = `text_editor.${cmd}`;
              toolByName.set(key, (toolByName.get(key) ?? 0) + 1);
            }
          }
          logIpc.info('agent.tool_start', { generationId: id, tool: tn });
        } else if (event.type === 'tool_execution_end') {
          // A1: log the actual error snippet on failure so post-hoc
          // analysis can categorize the failure mode without needing a
          // sqlite query against chat_messages tool-result rows.
          const tn = event.toolName ?? 'unknown';
          const errSnippet = event.isError ? extractToolErrorSnippet(event.result) : '';
          if (event.isError) {
            toolFailByName.set(tn, (toolFailByName.get(tn) ?? 0) + 1);
            failedToolErrors.push({ tool: tn, snippet: errSnippet });
          }
          logIpc.info('agent.tool_end', {
            generationId: id,
            tool: tn,
            isError: event.isError,
            ...(event.isError && errSnippet.length > 0 ? { errorSnippet: errSnippet } : {}),
          });
        } else if (event.type === 'turn_end') {
          // Backlog-3 logging — per-turn cache + cost breakdown so a
          // long run's hit ratio can be inspected turn-by-turn rather
          // than only at agent.run_summary. Reads the just-completed
          // assistant message's usage envelope; falls back gracefully
          // when the field shape is missing.
          const turnUsage = (
            event as unknown as {
              message?: {
                usage?: {
                  input?: number;
                  output?: number;
                  cacheRead?: number;
                  cacheWrite?: number;
                  cost?: { total?: number };
                };
              };
            }
          ).message?.usage;
          const turnLog: Record<string, unknown> = {
            generationId: id,
            deltas: deltaCount,
            tools: toolCount,
          };
          if (turnUsage) {
            const uncached = turnUsage.input ?? 0;
            const cacheRead = turnUsage.cacheRead ?? 0;
            const cacheWrite = turnUsage.cacheWrite ?? 0;
            const inputTotal = uncached + cacheRead + cacheWrite;
            turnLog['inputTokens'] = inputTotal;
            turnLog['outputTokens'] = turnUsage.output ?? 0;
            turnLog['cacheReadTokens'] = cacheRead;
            turnLog['cacheWriteTokens'] = cacheWrite;
            turnLog['cacheHitPct'] =
              inputTotal > 0 ? Math.round((cacheRead / inputTotal) * 100) : 0;
            turnLog['costUsd'] = Number((turnUsage.cost?.total ?? 0).toFixed(6));
          }
          // Phase 4 of pause-prune-fix-2026-05-08 — attribution flags
          // for zero-output turns. Exactly one of these is true when
          // deltas+tools=0; all three are false when the turn produced
          // tokens normally.
          if (deltaCount === 0 && toolCount === 0) {
            const signalAbortedNow = input.signal?.aborted === true;
            if (turnStartSignalAborted) {
              turnLog['abortedAtStart'] = true;
            } else if (signalAbortedNow) {
              turnLog['abortedDuringStream'] = true;
            } else {
              turnLog['emptyResponse'] = true;
            }
          }
          logIpc.info('agent.turn_end', turnLog);
        } else if (event.type === 'agent_end') {
          // A2: emit a single structured summary at run end. Captures
          // tool counts by name, failure counts, slowest tool, total
          // turns, and total wall-clock — enough for `grep agent.run_summary`
          // to give a per-run health snapshot without needing the full
          // log line count or sqlite queries.
          const totalRunMs = Date.now() - runStartedAt;
          const summary: Record<string, unknown> = {
            generationId: id,
            totalMs: totalRunMs,
            turns: totalTurns,
            toolsByName: Object.fromEntries(toolByName),
          };
          if (toolFailByName.size > 0) {
            summary['toolFailsByName'] = Object.fromEntries(toolFailByName);
            summary['failureCount'] = Array.from(toolFailByName.values()).reduce(
              (a, b) => a + b,
              0,
            );
            summary['failureSamples'] = failedToolErrors.slice(0, 3);
          }
          if (slowestToolName.length > 0) {
            summary['slowestTool'] = { name: slowestToolName, ms: slowestToolMs };
          }
          logIpc.info('agent.run_summary', summary);
          logIpc.info('agent.end', { generationId: id });
        }
        if (designId === null) return; // no routing target
        if (event.type === 'turn_start') {
          sendEvent({ ...baseCtx, type: 'turn_start' });
          return;
        }
        if (event.type === 'message_update') {
          const ame = event.assistantMessageEvent;
          if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
            // Integration E — accumulate output bytes for the
            // continuation-pause threshold check at turn_end. Bytes
            // ≈ 4 chars per token is the standard ballpark; we
            // refine when run_usage lands the real count.
            cumulativeOutputBytes.set(id, (cumulativeOutputBytes.get(id) ?? 0) + ame.delta.length);
            sendEvent({ ...baseCtx, type: 'text_delta', delta: ame.delta });
          } else if (ame.type === 'toolcall_start') {
            // The model has started forming a tool call. Extract the tool
            // name from the partial assistant message and open a "drafting"
            // indicator in the UI. Bridges the 1-3s gap between thinking
            // ending and the real tool_call_start firing — without it the
            // user sees a brief silent window after the thoughts panel
            // clears, which reads as the run stalling.
            const partial = (
              ame as unknown as { partial?: { content?: Array<Record<string, unknown>> } }
            ).partial;
            const block =
              typeof ame.contentIndex === 'number'
                ? partial?.content?.[ame.contentIndex]
                : undefined;
            const toolName = typeof block?.['name'] === 'string' ? (block['name'] as string) : '';
            const toolCallId = typeof block?.['id'] === 'string' ? (block['id'] as string) : '';
            sendEvent({
              ...baseCtx,
              type: 'tool_draft_start',
              toolName,
              toolCallId,
            });
          } else if (ame.type === 'toolcall_delta' && typeof ame.delta === 'string') {
            // Args delta — JSON characters as the model emits them. We
            // don't try to parse these (incomplete JSON); the renderer
            // just uses presence of deltas to keep the "drafting" pulse
            // alive and shows the partial-text length to suggest progress.
            const partial = (
              ame as unknown as { partial?: { content?: Array<Record<string, unknown>> } }
            ).partial;
            const block =
              typeof ame.contentIndex === 'number'
                ? partial?.content?.[ame.contentIndex]
                : undefined;
            const toolCallId = typeof block?.['id'] === 'string' ? (block['id'] as string) : '';
            sendEvent({
              ...baseCtx,
              type: 'tool_draft_delta',
              delta: ame.delta,
              toolCallId,
            });
          } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
            // Stream Claude's summarized reasoning to the UI live. Without
            // this, turn 2+ (with adaptive thinking enabled) shows a static
            // "thinking..." dot for 30–60 s while the model reasons. Forward
            // the deltas so the renderer can display them in a thoughts
            // panel that updates in real time. The renderer is responsible
            // for clearing on turn_start / thinking_end and for hiding the
            // panel once a tool call lands so it doesn't clutter the chat.
            sendEvent({ ...baseCtx, type: 'thinking_delta', delta: ame.delta });
          } else if (ame.type === 'thinking_end') {
            sendEvent({ ...baseCtx, type: 'thinking_end' });
          }
          return;
        }
        if (event.type === 'tool_execution_start') {
          toolStartedAt.set(event.toolCallId, Date.now());
          const argsObj =
            typeof event.args === 'object' && event.args !== null
              ? (event.args as Record<string, unknown>)
              : {};
          const command =
            typeof argsObj['command'] === 'string' ? (argsObj['command'] as string) : undefined;
          sendEvent({
            ...baseCtx,
            type: 'tool_call_start',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: argsObj,
            ...(command ? { command } : {}),
          });
          return;
        }
        if (event.type === 'tool_execution_end') {
          const startedAt = toolStartedAt.get(event.toolCallId) ?? Date.now();
          toolStartedAt.delete(event.toolCallId);
          const durationMs = Date.now() - startedAt;
          // Integration G — accumulate the result bytes so the
          // contextUsedPct estimator can include them. Each tool
          // result lands in pi-agent-core's conversation history and
          // becomes next-turn input on re-replay. JSON.stringify is a
          // good ballpark for the wire size; a thrown serializer
          // (circular ref, BigInt) just falls through silently.
          try {
            const resultStr = JSON.stringify(event.result ?? null);
            const resultBytes = typeof resultStr === 'string' ? resultStr.length : 0;
            cumulativeToolResultBytes.set(
              id,
              (cumulativeToolResultBytes.get(id) ?? 0) + resultBytes,
            );
          } catch {
            /* non-serializable result — skip the byte estimate, run
             * continues unaffected. The continuation threshold's
             * other inputs (output bytes, wall-clock) still fire. */
          }
          // Per-tool latency telemetry — emits one log line per tool call so
          // post-hoc analysis (`grep agent.tool_duration`) can spot slow
          // tools without requiring SQLite queries against chat_messages.
          logIpc.info('agent.tool_duration', {
            generationId: id,
            tool: event.toolName,
            ms: durationMs,
          });
          // Phase 3 — promote tool-duration telemetry to durable storage so
          // post-hoc analysis survives an app restart. Telemetry must never
          // break a run, hence the swallow.
          if (db !== null) {
            try {
              recordToolDuration(db, {
                generationId: id,
                designId,
                toolName: event.toolName ?? 'unknown',
                ...(typeof event.toolCallId === 'string' ? { toolCallId: event.toolCallId } : {}),
                durationMs,
                status: event.isError === true ? 'error' : 'done',
              });
            } catch (toolDurErr) {
              logIpc.warn('run_tool_duration.persist.fail', {
                generationId: id,
                tool: event.toolName,
                message: toolDurErr instanceof Error ? toolDurErr.message : String(toolDurErr),
              });
            }
          }
          // Track the slowest single tool of the run so the run_summary
          // surfaces it. Only `done` (BrowserWindow load) and
          // `render_preview` (also BrowserWindow) routinely cross 500 ms;
          // anything else above that is a regression.
          if (durationMs > slowestToolMs) {
            slowestToolMs = durationMs;
            slowestToolName = event.toolName ?? 'unknown';
          }
          // F3: emit a separate `tool.slow_call` warn when a tool's
          // execution time exceeds 5 s. Done is ~2 s normally and won't
          // trip; render_preview is ~600 ms; everything else is <30 ms.
          // A spike above 5 s is a real regression worth investigating.
          if (durationMs > 5_000) {
            logIpc.warn('tool.slow_call', {
              generationId: id,
              tool: event.toolName,
              ms: durationMs,
            });
          }
          // Edit metadata enrichment — only fires for str_replace / insert
          // success paths, where the FS callback returned an EditResult with
          // post-edit position info. Powers the follow-the-edit cursor in
          // the preview iframe. Validated structurally to keep the IPC payload
          // narrow even if event.result evolves.
          let editPath: string | undefined;
          let editStartLine: number | undefined;
          let editEndLine: number | undefined;
          if (event.toolName === 'str_replace_based_edit_tool') {
            const details = (event.result as { details?: unknown })?.details;
            if (details && typeof details === 'object') {
              const command = (details as { command?: unknown }).command;
              const inner = (details as { result?: unknown }).result;
              if (
                (command === 'str_replace' || command === 'insert') &&
                inner &&
                typeof inner === 'object'
              ) {
                const r = inner as {
                  path?: unknown;
                  startLine?: unknown;
                  endLine?: unknown;
                };
                if (
                  typeof r.path === 'string' &&
                  typeof r.startLine === 'number' &&
                  typeof r.endLine === 'number'
                ) {
                  editPath = r.path;
                  editStartLine = r.startLine;
                  editEndLine = r.endLine;
                }
              }
            }
          }
          sendEvent({
            ...baseCtx,
            type: 'tool_call_result',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            result: event.result,
            durationMs,
            // pi-agent-core sets `isError: true` on the tool_execution_end
            // event when the tool threw or returned an error result. The
            // renderer increments a per-run failure tally so the chat status
            // header can surface "N retries this run" past a threshold.
            ...(event.isError === true ? { isFailure: true } : {}),
            ...(editPath !== undefined ? { editPath } : {}),
            ...(editStartLine !== undefined ? { editStartLine } : {}),
            ...(editEndLine !== undefined ? { editEndLine } : {}),
          });
          return;
        }
        if (event.type === 'turn_end') {
          const msg = event.message as { content?: Array<{ type: string; text?: string }> };
          const rawText = (msg.content ?? [])
            .filter(
              (c): c is { type: 'text'; text: string } =>
                c.type === 'text' && typeof c.text === 'string',
            )
            .map((c) => c.text)
            .join('');
          // Strip <artifact ...>...</artifact> blocks — artifact content is
          // delivered via fs_updated / artifact_delivered, not the chat text.
          const finalText = rawText.replace(/<artifact[\s\S]*?<\/artifact>/g, '').trim();
          sendEvent({ ...baseCtx, type: 'turn_end', finalText });
          // Integration E — evaluate the continuation thresholds at
          // each safe boundary. When one trips, set the hint that the
          // agent's turn_end subscriber polls via getContinuationHint.
          // The actual abort happens inside the agent via that poll;
          // this just publishes the decision.
          if (!continuationHints.has(id)) {
            const startedAt = generationStartedAt.get(id) ?? Date.now();
            const outputBytes = cumulativeOutputBytes.get(id) ?? 0;
            const toolResultBytes = cumulativeToolResultBytes.get(id) ?? 0;
            const initialBytes = initialPromptBytes.get(id) ?? 0;
            // 4 chars per token is the standard ballpark. We never
            // *cap* the model — this is purely a "should pause" signal.
            const outputTokens = Math.ceil(outputBytes / 4);
            const wallClockMs = Date.now() - startedAt;
            // Integration G — context-used estimate now drives the
            // `context_threshold` rule. Sums the initial prompt + the
            // rolling output and tool-result counters (everything that
            // becomes next-turn input via pi-agent-core's re-replay).
            const contextUsedPct = estimateContextUsedPct(
              {
                initialPromptBytes: initialBytes,
                outputBytes,
                toolResultBytes,
              },
              input.model.modelId,
            );
            const decision = shouldPauseForContinuation({
              contextUsedPct,
              outputTokens,
              wallClockMs,
              modelEmittedPause: false,
            });
            if (decision.pause && decision.reason !== undefined) {
              continuationHints.set(id, decision.reason);
              logIpc.info('continuation.pause_signaled', {
                generationId: id,
                reason: decision.reason,
                outputTokens,
                wallClockMs,
                contextUsedPct: Number(contextUsedPct.toFixed(3)),
                threshold:
                  decision.reason === 'context_threshold'
                    ? CONTINUATION_THRESHOLDS.contextUsedPct
                    : decision.reason === 'output_budget'
                      ? CONTINUATION_THRESHOLDS.outputTokens
                      : decision.reason === 'wall_clock'
                        ? CONTINUATION_THRESHOLDS.wallClockMs
                        : null,
              });
            }
          }
          return;
        }
        if (event.type === 'agent_end') {
          // Final boundary of an agent run — renderer uses this to persist a
          // SQLite snapshot from the in-memory previewHtml so the design
          // survives an app restart. Without this the next switchDesign() at
          // boot finds no snapshot and falls back to the empty welcome state.
          sendEvent({ ...baseCtx, type: 'agent_end' });
          return;
        }
      },
    })
      .then((result) => ({
        ...result,
        artifacts: result.artifacts.map((artifact) => ({
          ...artifact,
          // Final-result artifact path: same inline-then-resolve order as
          // emitFsUpdated. JSX-pattern artifacts pass through unchanged
          // because they have no local <link>/<script src>.
          content: resolveLocalAssetRefs(inlineLocalSidecars(artifact.content, fsMap), fsMap),
        })),
      }))
      .finally(stopHeartbeat);
  };

  /** In-flight requests: generationId → AbortController */
  const inFlight = new Map<string, AbortController>();

  /** Backlog-3 §5 — checkpoint hints per generationId. Set by the
   *  cancel-with-checkpoint IPC; read by the agent loop's turn_end
   *  subscriber so cancellation lands at a safe boundary instead of
   *  mid-stream. */
  const checkpointHints = new Map<string, boolean>();

  /** Integration E — continuation hints per generationId. Polled by the
   *  agent's turn_end subscriber via `getContinuationHint`; set by the
   *  per-turn cumulative-state inspection below when
   *  `shouldPauseForContinuation` trips. Carries the reason so the
   *  post-run handler writes a `continuation_pending` row with the
   *  right cause. */
  const continuationHints = new Map<string, import('@open-codesign/core').ContinuationReason>();
  /** Phase 1 of pause-prune-fix-2026-05-08 — per-generation flag that a
   *  `continuation_pending` chat row has already been appended for this
   *  run. Read by `persistContinuationRow` to make the writer
   *  idempotent: planned-pause and unplanned-abort code paths can both
   *  call into it without risk of double-writing or, worse, both paths
   *  skipping each other (the bug fixed here — see plan
   *  `.claude/workspace/2026-05-08-pause-prune-continuation-fix.md`). */
  const continuationRowsWritten = new Set<string>();
  /** Per-generation cumulative output tokens. Approximated from
   *  text_delta lengths; refined when run_usage lands the final count.
   *  Drives the `output_budget` continuation threshold. */
  const cumulativeOutputBytes = new Map<string, number>();
  /** Integration G — per-generation cumulative tool_result bytes (the
   *  JSON the model receives back from each tool execution). Each
   *  result lands in the conversation history and becomes next-turn
   *  input on pi-agent-core's full re-replay. Feeds the
   *  estimateContextUsedPct alongside output bytes. */
  const cumulativeToolResultBytes = new Map<string, number>();
  /** Integration G — per-generation snapshot of the initial prompt +
   *  replayed history bytes at chunk_start. Together with the rolling
   *  output and tool-result counters this approximates the on-wire
   *  context size at any turn boundary, which feeds the
   *  `context_threshold` continuation rule. */
  const initialPromptBytes = new Map<string, number>();
  /** Per-generation start timestamp for the wall-clock threshold. */
  const generationStartedAt = new Map<string, number>();

  /** Phase 1 of pause-prune-fix-2026-05-08 — single, idempotent
   *  `continuation_pending` writer. Replaces the two opposite-gated
   *  writers that left the row unpersisted when a planned pause was
   *  followed by an unplanned abort (the bug observed in run
   *  mox8xixd-j8cr2o). One call site per outcome:
   *    - planned pause, run finished cleanly → success branch calls
   *      with `source: 'planned'`, `reason: <continuation reason>`.
   *    - planned pause then thrown error → catch branch calls with
   *      `source: 'planned'`, `reason: <continuation reason>`. Idempotent
   *      against the success branch via `continuationRowsWritten`.
   *    - unplanned mid-work abort (no hint set) → catch branch calls
   *      with `source: 'unplanned'`, `reason: 'unplanned_abort'`.
   *
   *  Logs `continuation.row_persisted` on success and
   *  `continuation.row_skipped { reason: 'already_written' }` on the
   *  no-op second call. Dedupe + write are atomic w.r.t. this set, so
   *  concurrent error/success races cannot double-write. */
  const persistContinuationRow = (params: {
    id: string;
    designId: string;
    db: BetterSqlite3.Database;
    t0: number;
    modelId: string;
    source: 'planned' | 'unplanned';
    reason: import('@open-codesign/core').ContinuationReason | 'unplanned_abort';
    outputTokensOverride?: number;
    decisionRecapOverride?: string;
  }): void => {
    const wallClockMs = Date.now() - (generationStartedAt.get(params.id) ?? params.t0);
    const contextUsedPctFinal = estimateContextUsedPct(
      {
        initialPromptBytes: initialPromptBytes.get(params.id) ?? 0,
        outputBytes: cumulativeOutputBytes.get(params.id) ?? 0,
        toolResultBytes: cumulativeToolResultBytes.get(params.id) ?? 0,
      },
      params.modelId,
    );
    const recap = buildAbortContinuationRecap(params.db, params.designId);
    const outputTokens = params.outputTokensOverride ?? 0;
    persistContinuationRowOnce(
      continuationRowsWritten,
      logIpc,
      {
        generationId: params.id,
        source: params.source,
        reason: params.reason,
        outputTokens,
        wallClockMs,
        hasTodos: recap.todoSnapshotSeq !== undefined,
        hasBrief: recap.lastUserBrief !== undefined,
      },
      () => {
        appendChatMessage(params.db, {
          designId: params.designId,
          kind: 'continuation_pending',
          payload: {
            reason: params.reason,
            decisionRecap: params.decisionRecapOverride ?? recap.decisionRecap,
            outputTokens,
            contextUsedPct: contextUsedPctFinal,
            wallClockMs,
            ...(recap.todoSnapshotSeq !== undefined
              ? { todoSnapshotSeq: recap.todoSnapshotSeq }
              : {}),
            ...(recap.lastUserBrief !== undefined ? { lastUserBrief: recap.lastUserBrief } : {}),
          },
        });
      },
    );
  };

  /** Promise-level dedup so an accidental double-IPC of the same generation
   *  collapses to one provider call. See generate-dedup.ts for the strategy. */
  const inFlightGenerations = new Map<string, Promise<unknown>>();
  const inFlightContentToId = new Map<string, string>();

  /** User-injected steering messages keyed by generationId. Drained by
   *  the agent's turn_end subscriber via the `getPendingSteers` callback
   *  passed into runGenerate. Lets the renderer push "Wrap up now" /
   *  "Focus on X" overrides into the agent's next turn without an abort. */
  const pendingUserSteers = new Map<string, string[]>();
  const enqueueUserSteer = (generationId: string, message: string): void => {
    const cur = pendingUserSteers.get(generationId) ?? [];
    cur.push(message);
    pendingUserSteers.set(generationId, cur);
  };
  const drainUserSteers = (generationId: string): string[] => {
    const cur = pendingUserSteers.get(generationId);
    if (!cur || cur.length === 0) return [];
    pendingUserSteers.delete(generationId);
    return cur;
  };

  const armTimeout = (id: string, controller: AbortController) =>
    armGenerationTimeout(
      id,
      controller,
      async () => (await readPreferences()).generationTimeoutSec,
      logIpc,
    );

  ipcMain.handle('codesign:detect-provider', (_e, key: unknown) => {
    if (typeof key !== 'string') {
      throw new CodesignError('detect-provider expects a string key', 'IPC_BAD_INPUT');
    }
    return detectProviderFromKey(key);
  });

  // Standalone runtime-verify IPC. Renderer / debug callers can invoke this
  // directly to dry-run an artifact without going through the agent loop.
  // The agent itself uses the same verifier as an injected callback (see
  // runGenerate above), so this handler is NOT in the hot path. Hidden
  // BrowserWindow + Babel makes vitest unworkable here — manual verification
  // path documented in done-verify.ts.
  const sharedRuntimeVerifier = makeRuntimeVerifier();
  ipcMain.handle('done:verify:v1', async (_e, raw: unknown) => {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as { artifact?: unknown }).artifact !== 'string'
    ) {
      throw new CodesignError('done:verify:v1 expects { artifact: string }', 'IPC_BAD_INPUT');
    }
    const errors = await sharedRuntimeVerifier((raw as { artifact: string }).artifact);
    return { errors };
  });

  ipcMain.handle('codesign:pick-input-files', async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile', 'multiSelections'],
        })
      : await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
        });
    if (result.canceled || result.filePaths.length === 0) return [];
    return Promise.all(
      result.filePaths.map(async (path) => {
        try {
          const info = await stat(path);
          return { path, name: basename(path), size: info.size };
        } catch {
          return { path, name: basename(path), size: 0 };
        }
      }),
    );
  });

  ipcMain.handle('codesign:pick-design-system-directory', async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory'],
        });
    if (result.canceled || result.filePaths.length === 0) return getOnboardingState();
    const rootPath = result.filePaths[0];
    if (!rootPath) return getOnboardingState();
    logIpc.info('designSystem.scan.start', { rootPath });
    const snapshot = await scanDesignSystem(rootPath);
    const nextState = await setDesignSystem(snapshot);
    logIpc.info('designSystem.scan.ok', {
      rootPath,
      sourceFiles: snapshot.sourceFiles.length,
      colors: snapshot.colors.length,
      fonts: snapshot.fonts.length,
    });
    return nextState;
  });

  ipcMain.handle('codesign:clear-design-system', async () => {
    const nextState = await setDesignSystem(null);
    logIpc.info('designSystem.clear');
    return nextState;
  });

  ipcMain.handle('codesign:v1:generate', async (_e, raw: unknown) => {
    const payload = GeneratePayloadV1.parse(raw);
    const id = payload.generationId;
    const contentKey = generateDedupKey(payload);
    // Dedup: collapse identical concurrent requests so a double-click can't
    // burn two provider calls or interleave two snapshot writes.
    const existing = findInFlightDuplicate({
      generationId: id,
      contentKey,
      inFlightById: inFlightGenerations,
      inFlightContentToId,
    });
    if (existing !== undefined) {
      logIpc.info('generate.dedup', {
        generationId: id,
        contentKeyHash: hashContentKey(contentKey),
      });
      return existing;
    }
    // `withRun` binds `id` as the AsyncLocalStorage runId so every log line
    // emitted through `getLogger()` inside this handler (and every awaited
    // call it transitively makes, including `armTimeout`'s setTimeout) carries
    // the same runId. See `runContext.ts`. The manual `generationId: id`
    // fields kept below are the pre-ALS convention and are retained
    // non-destructively; future PRs may drop them once tooling reads runId.
    const promise = withRun(id, async () => {
      const controller = new AbortController();
      inFlight.set(id, controller);
      const coreLogger = coreLoggerFor(id);

      coreLogger.info('[generate] step=load_config');
      const loadStart = Date.now();
      const cfg = getCachedConfig();
      if (cfg === null) {
        inFlight.delete(id);
        throw new CodesignError(
          'No configuration found. Complete onboarding first.',
          'CONFIG_MISSING',
        );
      }
      // Snap to the canonical active provider in cachedConfig — the SAME source
      // the Settings UI uses for the Active badge — so the actual call cannot
      // diverge from what the user sees.
      const active = resolveActiveModel(cfg, payload.model);
      const allowKeyless = active.allowKeyless;
      let apiKey: string;
      try {
        // OAuth refresh for `claude-code-imported`: runs before the key
        // resolver so the now-fresh token gets read out of the cached
        // config. No-op for every other provider.
        await queueClaudeCodeRefresh(active.model.provider);
        apiKey = await resolveApiKeyForActive(active.model.provider, allowKeyless);
      } catch (err) {
        inFlight.delete(id);
        throw err;
      }
      // Once we've snapped to the canonical active provider, the renderer-supplied
      // baseUrl can no longer be trusted — it may belong to a different (stale)
      // provider and would route the active provider's API key to the wrong host.
      // Always use the per-provider baseUrl from cached config, and mutate the
      // payload itself so any downstream reader cannot accidentally pick up the
      // stale renderer value.
      const baseUrl = active.baseUrl ?? undefined;
      if (active.overridden) {
        payload.baseUrl = baseUrl;
      }
      coreLogger.info('[generate] step=load_config.ok', {
        ms: Date.now() - loadStart,
        hasApiKey: apiKey.length > 0,
        baseUrl: baseUrl ?? '<default>',
      });

      if (active.overridden) {
        coreLogger.info('[generate] step=resolve_active.override', {
          requested: payload.model.provider,
          requestedModelId: payload.model.modelId,
          active: active.model.provider,
          activeModelId: active.model.modelId,
        });
      }

      const stepCtx = {
        generationId: id,
        provider: active.model.provider,
        modelId: active.model.modelId,
      };
      coreLogger.info('[generate] step=validate_provider', stepCtx);
      if (apiKey.length === 0 && !allowKeyless) {
        coreLogger.error('[generate] step=validate_provider.fail', {
          provider: active.model.provider,
          reason: 'missing_api_key',
        });
        inFlight.delete(id);
        throw new CodesignError(
          `No API key configured for provider "${active.model.provider}". Open Settings to add one.`,
          'PROVIDER_AUTH_MISSING',
        );
      }
      coreLogger.info('[generate] step=validate_provider.ok', { provider: active.model.provider });

      // Phase 3 — parallel preflight. preparePromptContext fetches the
      // referenceUrl + materialises attachment buffers; readPreferences
      // hits disk for prefs. Independent, both are awaited downstream
      // before the first LLM call. Running them in parallel shaves the
      // longer of the two off TTFT.
      const [promptContext, prefsPreloaded] = await Promise.all([
        preparePromptContext({
          attachments: payload.attachments,
          referenceUrl: payload.referenceUrl,
          designSystem: cfg.designSystem ?? null,
        }),
        readPreferences(),
      ]);

      logIpc.info('generate', {
        generationId: id,
        provider: active.model.provider,
        modelId: active.model.modelId,
        ...(active.overridden
          ? { requestedProvider: payload.model.provider, requestedModelId: payload.model.modelId }
          : {}),
        promptLen: payload.prompt.length,
        historyLen: payload.history.length,
        attachmentCount: payload.attachments.length,
        hasReferenceUrl: payload.referenceUrl !== undefined,
        hasDesignSystem: promptContext.designSystem !== null,
        baseUrl: baseUrl ?? '<default>',
      });

      // Integration B — pre-flight artifact-type classifier. Runs the
      // user's prompt through a keyword-scored guess; logs the result
      // and emits a low-priority diagnostic_event when confidence is
      // very low so post-hoc analysis can correlate "wrong artifact
      // shape" failures with weak briefs. Skipped for game-mode runs
      // (the game pipeline has its own genre-spec gate). Synchronous
      // pure call, never throws, never blocks generation.
      if (payload.artifactMode !== 'game' && payload.history.length === 0) {
        try {
          const classify = classifyArtifactType(payload.prompt);
          logIpc.info('preflight.artifact_type', {
            generationId: id,
            type: classify.type,
            confidence: Number(classify.confidence.toFixed(2)),
            top3: classify.candidates
              .slice(0, 3)
              .map((c) => `${c.type}=${c.score}`)
              .join(','),
          });
          if (classify.confidence < 0.3 && db !== null) {
            try {
              recordDiagnosticEvent(db, {
                level: 'info',
                code: 'PREFLIGHT_LOW_CONFIDENCE',
                scope: 'generate',
                runId: id,
                fingerprint: `preflight-low-confidence-${classify.type}`,
                message: `Artifact-type classifier confidence ${classify.confidence.toFixed(2)} (top: ${classify.type}). Brief may be ambiguous.`,
                stack: undefined,
                transient: false,
                context: {
                  classifierGuess: classify.type,
                  confidence: classify.confidence,
                  top3: classify.candidates.slice(0, 3),
                  generationId: id,
                },
              });
            } catch (diagErr) {
              logIpc.warn('preflight.diag.persist.fail', {
                generationId: id,
                message: diagErr instanceof Error ? diagErr.message : String(diagErr),
              });
            }
          }
        } catch (preflightErr) {
          // Pre-flight is advisory — never break a run.
          logIpc.warn('preflight.classifier.fail', {
            generationId: id,
            message: preflightErr instanceof Error ? preflightErr.message : String(preflightErr),
          });
        }
      }

      const t0 = Date.now();
      generationStartedAt.set(id, t0);
      cumulativeOutputBytes.set(id, 0);
      cumulativeToolResultBytes.set(id, 0);
      // Integration G — snapshot the initial on-wire context size as
      // an approximation: prompt bytes + sum of every prior message's
      // text length + a small system-prompt allowance. The system
      // prompt itself is composed by core later; we estimate
      // conservatively at 8 KB so the threshold check doesn't
      // under-count headroom. Not exact — pi-agent-core composes the
      // final prompt — but close enough to drive the 0.8-pause rule.
      const SYSTEM_PROMPT_ESTIMATE_BYTES = 8 * 1024;
      let initialBytes = SYSTEM_PROMPT_ESTIMATE_BYTES + payload.prompt.length;
      for (const msg of payload.history) {
        if (typeof msg.content === 'string') initialBytes += msg.content.length;
      }
      initialPromptBytes.set(id, initialBytes);
      let clearTimeoutGuard: () => void = () => {};
      // Phase 3 — chunk counter, set up as a variable so Phase 4's
      // continuation work can increment it on each pause/resume cycle
      // without requiring further telemetry plumbing. Starts at 1 (one
      // chunk per run is the current default; the variable is captured
      // by `recordRunUsage` below). Re-marked as `let` for Integration E
      // (the continuation pause needs to bump it).
      const chunkCount = 1;
      // Single-session default. Production trace 2026-04-27 demonstrated
      // that chunked execution + history-reload-between-chunks is the
      // wrong abstraction for design generation: it forces re-planning,
      // loses chain-of-thought (especially with reasoning on), and
      // exits prematurely when the model goes quiet. Claude Code /
      // Cursor / Aider all run a single agent session bounded by an
      // outer timeout. We default to that shape now.
      //
      // Backlog-3 §9 — chunk-loop scaffolding deleted. The framework runs
      // the entire generation inside one outer timeout (matching Claude
      // Code / Cursor / Aider). chunk_start / chunk_end events still
      // fire once each with chunkIndex=1, chunkCap=1 for renderer
      // compatibility (ChatStatusHeader gates on chunkCap > 1; older
      // subscribers continue to work). If chunked execution ever
      // returns it lives behind an explicit feature flag, not as
      // permanent scaffolding.
      const generationTimeoutSec = prefsPreloaded.generationTimeoutSec;
      const SINGLE_SESSION_WALL_CLOCK_MS = Math.max(60_000, generationTimeoutSec * 1000 - 30_000);
      const isCodex = active.model.provider === CHATGPT_CODEX_PROVIDER_ID;
      const activeController = controller;
      try {
        clearTimeoutGuard = await armTimeout(id, activeController);
        const chunkBudgetMs = active.wallClockBudgetMs ?? SINGLE_SESSION_WALL_CLOCK_MS;
        mainWindow?.webContents.send('agent:event:v1', {
          type: 'chunk_start',
          designId: payload.designId ?? '',
          generationId: id,
          chunkIndex: 1,
          chunkCap: 1,
          chunkBudgetMs,
        });

        // game-artifacts §5 — append a compact artifact-context block to
        // the user prompt when the renderer shipped a selection payload
        // and we have an active design id. The context lets the agent
        // resolve "this sprite" / "the selected animation" without
        // calling list/inspect tools first.
        let promptForRun = payload.prompt;
        if (
          payload.gameArtifactContext !== undefined &&
          payload.designId !== undefined &&
          db !== null
        ) {
          try {
            const { buildGameArtifactContextBlock } = await import(
              './game-artifact-prompt-context'
            );
            const ctx = buildGameArtifactContextBlock(
              db,
              payload.designId,
              payload.gameArtifactContext,
            );
            if (ctx.block.length > 0) {
              promptForRun = `${payload.prompt}\n\n${ctx.block}`;
            }
            if (ctx.unresolvedAliases.length > 0) {
              logIpc.warn('generate.unresolved_aliases', {
                generationId: id,
                aliases: ctx.unresolvedAliases,
              });
            }
          } catch (err) {
            logIpc.warn('generate.artifact_context.fail', {
              generationId: id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const runResult = await runGenerate(
          {
            prompt: promptForRun,
            history: payload.history,
            model: active.model,
            apiKey,
            ...(isCodex
              ? { getApiKey: () => resolveActiveApiKeyFromState(active.model.provider) }
              : {}),
            attachments: promptContext.attachments,
            ...(promptContext.referenceUrl !== undefined
              ? { referenceUrl: promptContext.referenceUrl }
              : {}),
            designSystem: promptContext.designSystem ?? null,
            ...(baseUrl !== undefined ? { baseUrl } : {}),
            wire: active.wire,
            ...(active.httpHeaders !== undefined ? { httpHeaders: active.httpHeaders } : {}),
            ...(allowKeyless ? { allowKeyless: true } : {}),
            ...(active.reasoningLevel !== undefined
              ? { reasoningLevel: active.reasoningLevel }
              : {}),
            ...(active.cacheRetention !== undefined
              ? { cacheRetention: active.cacheRetention }
              : {}),
            signal: activeController.signal,
            logger: coreLogger,
            agentBudget: {
              chunkIndex: 1,
              maxWallClockMs: active.wallClockBudgetMs ?? SINGLE_SESSION_WALL_CLOCK_MS,
            },
            getPendingSteers: () => drainUserSteers(id),
            // Backlog-3 §5 — checkpoint-cancel poll wired to the
            // per-generationId hint Map.
            getCheckpointHint: () => checkpointHints.get(id) === true,
            // Integration E — continuation-pause poll wired to the
            // per-generationId hint Map. Returns a reason when the
            // turn_end threshold check has tripped, null otherwise.
            getContinuationHint: () => continuationHints.get(id) ?? null,
            // Improver1 §6 — wire auto-verify on by default. The
            // Backlog-3 §7 logic gates internally on
            // VERIFY_MIN_TURN=8 and caps at 3 fires per run, so
            // short runs silently no-op. The IPC handler had been
            // forgetting to set this flag in production, leaving the
            // feature dead. Today's c44763af-21e9-4fb5-9c39-cc2865a37c30
            // run had 49-95 turn runs that never saw a single
            // auto_verify_fired log line.
            incrementalVerify: prefsPreloaded.incrementalVerifyDisabled !== true,
            ...(payload.pattern !== undefined ? { pattern: payload.pattern } : {}),
            ...(payload.artifactMode !== undefined ? { artifactType: payload.artifactMode } : {}),
            ...(payload.gameEngine !== undefined ? { engine: payload.gameEngine } : {}),
            ...(payload.designId !== undefined && db !== null
              ? (() => {
                  const design = getDesign(db, payload.designId);
                  return design?.promptAssistMetadata
                    ? { promptAssist: design.promptAssistMetadata }
                    : {};
                })()
              : {}),
          },
          id,
          payload.designId ?? null,
          payload.previousHtml ?? null,
        );

        mainWindow?.webContents.send('agent:event:v1', {
          type: 'chunk_end',
          designId: payload.designId ?? '',
          generationId: id,
          chunkIndex: 1,
          chunkCap: 1,
          chunkInterrupted: runResult.interrupted,
        });

        const finalResult = runResult.interrupted
          ? {
              ...runResult,
              message: `${runResult.message}${runResult.message.length > 0 ? '\n\n' : ''}— Run paused after ${Math.round((active.wallClockBudgetMs ?? SINGLE_SESSION_WALL_CLOCK_MS) / 1000)}s. The artifact above is what landed; type **keep going** (or any follow-up) to do more. —`,
            }
          : runResult;

        logIpc.info('generate.ok', {
          generationId: id,
          ms: Date.now() - t0,
          artifacts: finalResult.artifacts.length,
          cost: finalResult.costUsd,
          inputTokens: finalResult.inputTokens,
          outputTokens: finalResult.outputTokens,
          cachedInputTokens: finalResult.cachedInputTokens,
          cacheCreationInputTokens: finalResult.cacheCreationInputTokens,
        });
        logIpc.info('generate.summary', {
          generationId: id,
          totalMs: Date.now() - t0,
          totalChunks: 1,
          chunksInterrupted: finalResult.interrupted ? 1 : 0,
          capReached: finalResult.interrupted,
          totalInputTokens: finalResult.inputTokens,
          totalOutputTokens: finalResult.outputTokens,
          totalCachedInputTokens: finalResult.cachedInputTokens,
          totalCostUsd: finalResult.costUsd,
        });
        if (db !== null) {
          try {
            // Phase 3 — implied cost computed from the same token shape
            // we already capture. Lets the budget UI surface a meaningful
            // number for subscription-provider runs (where `costUsd` is 0).
            const impliedCostUsd = computeImpliedCost(
              {
                inputTokens: finalResult.inputTokens,
                outputTokens: finalResult.outputTokens,
                cachedInputTokens: finalResult.cachedInputTokens,
                cacheCreationInputTokens: finalResult.cacheCreationInputTokens,
              },
              active.model.modelId,
            );
            recordRunUsage(db, {
              generationId: id,
              designId: payload.designId ?? null,
              inputTokens: finalResult.inputTokens,
              outputTokens: finalResult.outputTokens,
              cachedInputTokens: finalResult.cachedInputTokens,
              cacheCreationInputTokens: finalResult.cacheCreationInputTokens,
              costUsd: finalResult.costUsd,
              impliedCostUsd,
              totalChunks: chunkCount,
              totalMs: Date.now() - t0,
              provider: active.model.provider,
              modelId: active.model.modelId,
              // may9 Phase 0 — measurement context. artifactType + engine
              // come from the IPC payload (already validated upstream).
              // abortKind, narrationDropped, promptVersion, firstToolCallMs
              // wire in their respective phases (1 / 3 / 9 / 9). Until then
              // they default to NULL/0 in the writer.
              artifactType: payload.artifactMode ?? undefined,
              engine: payload.gameEngine ?? undefined,
              abortKind: finalResult.interrupted ? 'interrupted' : undefined,
            });
          } catch (err) {
            logIpc.warn('run_usage.persist.fail', {
              generationId: id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Integration E — when the continuation hint tripped during
        // this run, persist a `continuation_pending` chat row so the
        // renderer can show the Run-paused panel and offer a Continue
        // button. Phase 1 of pause-prune-fix-2026-05-08 — call into
        // the idempotent helper instead of inlining the write, so the
        // catch path can also write without risk of double-writing.
        const continuationReason = continuationHints.get(id);
        if (continuationReason !== undefined && payload.designId !== undefined && db !== null) {
          persistContinuationRow({
            id,
            designId: payload.designId,
            db,
            t0,
            modelId: active.model.modelId,
            source: 'planned',
            reason: continuationReason,
            outputTokensOverride: finalResult.outputTokens,
            ...(finalResult.message !== undefined
              ? { decisionRecapOverride: finalResult.message }
              : {}),
          });
        }
        // Drain the hint maps regardless of whether we wrote a row.
        continuationHints.delete(id);
        continuationRowsWritten.delete(id);
        cumulativeOutputBytes.delete(id);
        cumulativeToolResultBytes.delete(id);
        initialPromptBytes.delete(id);
        generationStartedAt.delete(id);
        return finalResult;
      } catch (err) {
        // Attach upstream metadata to the thrown err so the renderer's
        // diagnostic pipeline (store.ts::applyGenerateError →
        // diagnoseGenerateFailure) can map this failure to a "most likely
        // cause + suggested fix" hypothesis. Without this, renderer only
        // sees err.message + err.code and cannot offer actionable hints
        // (e.g. the #130 404-page-not-found case that needs /v1 appended).
        const upstreamStatus = extractUpstreamHttpStatus(err);
        if (err !== null && typeof err === 'object') {
          const errAsRec = err as Record<string, unknown>;
          if (upstreamStatus !== undefined && errAsRec['upstream_status'] === undefined) {
            errAsRec['upstream_status'] = upstreamStatus;
          }
          if (errAsRec['upstream_provider'] === undefined) {
            errAsRec['upstream_provider'] = active.model.provider;
          }
          if (errAsRec['upstream_baseurl'] === undefined && baseUrl !== undefined) {
            errAsRec['upstream_baseurl'] = baseUrl;
          }
          if (errAsRec['upstream_wire'] === undefined && active.wire !== undefined) {
            errAsRec['upstream_wire'] = active.wire;
          }
          // Token-shape signal so the renderer's diagnose pipeline can pick
          // an OAuth-specific 401/403 hypothesis ("run claude/codex login")
          // instead of the generic "open Settings to update key" copy.
          if (errAsRec['key_kind'] === undefined) {
            errAsRec['key_kind'] = isOAuthShapedToken(apiKey) ? 'oauth' : 'static';
          }
        }
        // The SDK catches our AbortController and rethrows a generic
        // `'Request was aborted.'` that drops signal.reason. Prefer our
        // own classification so the user sees the configured timeout
        // (Settings path) for armed-timeout aborts, or STREAM_INTERRUPTED
        // (with the Resume CTA) for unplanned upstream stream cuts.
        const classifiedErr = classifyAbortError(err, controller.signal);
        const rethrow = classifiedErr ?? err;
        // Phase 1 of pause-prune-fix-2026-05-08 — write a continuation
        // marker for any pause-shaped abort (planned or unplanned). The
        // helper is idempotent against the success-path write so the
        // double-write race is impossible. Three cases:
        //   - PAUSE_AT_SAFE_BOUNDARY: streamFn refused dispatch because
        //     the hint was set at turn_end. Always planned.
        //   - STREAM_INTERRUPTED with hint set: turn_end signalled a
        //     planned pause but the next turn raced + got cancelled.
        //     Treat as planned — that's what the user actually saw.
        //   - STREAM_INTERRUPTED with no hint: a true unplanned mid-
        //     work abort.
        const isStreamInterruption =
          rethrow instanceof CodesignError && rethrow.code === ERROR_CODES.STREAM_INTERRUPTED;
        const isPauseAtSafeBoundary =
          rethrow instanceof CodesignError && rethrow.code === ERROR_CODES.PAUSE_AT_SAFE_BOUNDARY;
        const shouldPersistContinuation =
          (isStreamInterruption || isPauseAtSafeBoundary) &&
          payload.designId !== undefined &&
          db !== null;
        if (shouldPersistContinuation && payload.designId !== undefined && db !== null) {
          const hintAtAbort = continuationHints.get(id);
          const reason = hintAtAbort ?? 'unplanned_abort';
          const source: 'planned' | 'unplanned' =
            isPauseAtSafeBoundary || hintAtAbort !== undefined ? 'planned' : 'unplanned';
          persistContinuationRow({
            id,
            designId: payload.designId,
            db,
            t0,
            modelId: active.model.modelId,
            source,
            reason,
          });
        } else if (
          payload.designId !== undefined &&
          db !== null &&
          !continuationRowsWritten.has(id)
        ) {
          // Phase 4 of pause-prune-fix-2026-05-08 — regression alarm.
          // If we exit through catch with a non-pause error AND no row
          // was written by the success path either, log it loudly so
          // the next time Bug A returns it will be greppable.
          logIpc.info('continuation.row_skipped', {
            generationId: id,
            reason: 'no_path_matched',
            errCode: rethrow instanceof CodesignError ? rethrow.code : 'unknown',
          });
        }
        logIpc.error('generate.fail', {
          generationId: id,
          ms: Date.now() - t0,
          provider: active.model.provider,
          modelId: active.model.modelId,
          baseUrl: baseUrl ?? '<default>',
          status: upstreamStatus,
          message: rethrow instanceof Error ? rethrow.message : String(rethrow),
          code: rethrow instanceof CodesignError ? rethrow.code : undefined,
        });
        recordFinalError('generate', id, rethrow);
        throw rethrow;
      } finally {
        clearTimeoutGuard();
        inFlight.delete(id);
      }
    });
    // withRun returns Promise<T> | T; for async fn we always get a Promise but
    // the type widens, so wrap so we can attach a settlement listener.
    const wrapped = Promise.resolve(promise);
    inFlightGenerations.set(id, wrapped);
    inFlightContentToId.set(contentKey, id);
    // Side-effect-only cleanup. .then(_, _) catches both branches so the
    // cleanup chain doesn't surface a phantom unhandled rejection — the
    // original `wrapped` keeps the rejection for the awaiting caller.
    const cleanupDedup = () => {
      if (inFlightGenerations.get(id) === wrapped) inFlightGenerations.delete(id);
      if (inFlightContentToId.get(contentKey) === id) inFlightContentToId.delete(contentKey);
      // Backlog-3 §5 — clear any checkpoint hint so it doesn't leak
      // into a subsequent run with the same id (shouldn't happen
      // given GenerationId is unique-per-attempt, but belt-and-braces).
      checkpointHints.delete(id);
      // Integration E — drain continuation hint + cumulative state on
      // the failure path too. The success path inside the IPC handler
      // already drains; this catches the abort / error short-circuit.
      continuationHints.delete(id);
      // Phase 1 of pause-prune-fix-2026-05-08 — drain the
      // already-written set alongside the hint map.
      continuationRowsWritten.delete(id);
      cumulativeOutputBytes.delete(id);
      cumulativeToolResultBytes.delete(id);
      initialPromptBytes.delete(id);
      generationStartedAt.delete(id);
    };
    wrapped.then(cleanupDedup, cleanupDedup);
    return wrapped;
  });

  // Legacy shim — kept for one minor release while older renderer builds still
  // send codesign:generate without schemaVersion. Remove after v0.3.
  ipcMain.handle('codesign:generate', async (_e, raw: unknown) => {
    logIpc.warn('legacy codesign:generate channel used, schedule removal next minor');
    const legacy = GeneratePayload.parse(raw);
    const id = legacy.generationId ?? `gen-${Date.now()}`;
    return withRun(id, async () => {
      const v1Raw = { schemaVersion: 1 as const, ...legacy, generationId: id };
      const payload = GeneratePayloadV1.parse(v1Raw);
      const controller = new AbortController();
      inFlight.set(id, controller);

      const cfg = getCachedConfig();
      if (cfg === null) {
        inFlight.delete(id);
        throw new CodesignError(
          'No configuration found. Complete onboarding first.',
          'CONFIG_MISSING',
        );
      }
      const active = resolveActiveModel(cfg, payload.model);
      const allowKeyless = active.allowKeyless;
      let apiKey: string;
      try {
        await queueClaudeCodeRefresh(active.model.provider);
        apiKey = await resolveApiKeyForActive(active.model.provider, allowKeyless);
      } catch (err) {
        inFlight.delete(id);
        throw err;
      }
      // See codesign:v1:generate above — renderer baseUrl is ignored post-snap.
      const baseUrl = active.baseUrl ?? undefined;
      if (active.overridden) {
        payload.baseUrl = baseUrl;
      }
      const promptContext = await preparePromptContext({
        attachments: payload.attachments,
        referenceUrl: payload.referenceUrl,
        designSystem: cfg.designSystem ?? null,
      });

      logIpc.info('generate', {
        generationId: id,
        provider: active.model.provider,
        modelId: active.model.modelId,
        ...(active.overridden
          ? { requestedProvider: payload.model.provider, requestedModelId: payload.model.modelId }
          : {}),
        promptLen: payload.prompt.length,
        historyLen: payload.history.length,
        attachmentCount: payload.attachments.length,
        hasReferenceUrl: payload.referenceUrl !== undefined,
        hasDesignSystem: promptContext.designSystem !== null,
        baseUrl: baseUrl ?? '<default>',
      });

      const t0 = Date.now();
      let clearTimeoutGuard: () => void = () => {};
      try {
        clearTimeoutGuard = await armTimeout(id, controller);
        const isCodex = active.model.provider === CHATGPT_CODEX_PROVIDER_ID;
        const result = await runGenerate(
          {
            prompt: payload.prompt,
            history: payload.history,
            model: active.model,
            apiKey,
            ...(isCodex
              ? { getApiKey: () => resolveActiveApiKeyFromState(active.model.provider) }
              : {}),
            attachments: promptContext.attachments,
            referenceUrl: promptContext.referenceUrl,
            designSystem: promptContext.designSystem ?? null,
            ...(baseUrl !== undefined ? { baseUrl } : {}),
            wire: active.wire,
            ...(active.httpHeaders !== undefined ? { httpHeaders: active.httpHeaders } : {}),
            ...(allowKeyless ? { allowKeyless: true } : {}),
            ...(active.reasoningLevel !== undefined
              ? { reasoningLevel: active.reasoningLevel }
              : {}),
            ...(active.cacheRetention !== undefined
              ? { cacheRetention: active.cacheRetention }
              : {}),
            signal: controller.signal,
          },
          id,
          null,
          null,
        );
        logIpc.info('generate.ok', {
          generationId: id,
          ms: Date.now() - t0,
          artifacts: result.artifacts.length,
          cost: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedInputTokens: result.cachedInputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
        });
        return result;
      } catch (err) {
        // The SDK catches our AbortController and rethrows a generic
        // `'Request was aborted.'` that drops signal.reason. Prefer the
        // CodesignError we stashed on the signal so the user sees the
        // configured timeout + Settings path instead of an opaque message.
        const timeoutErr = extractGenerationTimeoutError(controller.signal);
        const rethrow = timeoutErr ?? err;
        logIpc.error('generate.fail', {
          generationId: id,
          ms: Date.now() - t0,
          provider: active.model.provider,
          modelId: active.model.modelId,
          baseUrl: baseUrl ?? '<default>',
          message: rethrow instanceof Error ? rethrow.message : String(rethrow),
          code: rethrow instanceof CodesignError ? rethrow.code : undefined,
        });
        recordFinalError('generate', id, rethrow);
        throw rethrow;
      } finally {
        clearTimeoutGuard();
        inFlight.delete(id);
      }
    });
  });

  ipcMain.handle('codesign:v1:cancel-generation', (_e, raw: unknown) => {
    const parsed = CancelGenerationPayloadV1.parse(raw);
    if (parsed.asCheckpoint === true) {
      // Backlog-3 §5 — soft cancel: set the hint and let the agent's
      // turn_end subscriber convert it into a clean abort at the next
      // safe boundary. Falls back to a hard abort after 10s in case
      // the model is mid-stream and won't reach turn_end on its own.
      requestCheckpointAbort(parsed.generationId, checkpointHints, logIpc);
      const fallbackId = parsed.generationId;
      setTimeout(() => {
        if (checkpointHints.get(fallbackId) === true) {
          logIpc.warn('generate.cancel.checkpoint_fallback', { id: fallbackId });
          cancelGenerationRequest(fallbackId, inFlight, logIpc);
          checkpointHints.delete(fallbackId);
        }
      }, 10_000);
      return;
    }
    cancelGenerationRequest(parsed.generationId, inFlight, logIpc);
  });

  /**
   * plan0305 P3.2 — return aggregated token + cost totals for a design,
   * summed across all `run_usage` rows. Renderer reads this for the
   * "this design cost $X.XX" footer and to render usage charts later.
   */
  ipcMain.handle('codesign:v1:design-usage', (_e, raw: unknown) => {
    const obj = raw as { designId?: unknown } | null;
    const designId = obj?.designId;
    if (typeof designId !== 'string' || designId.length === 0) {
      throw new CodesignError('design-usage expects { designId: string }', 'IPC_BAD_INPUT');
    }
    if (db === null) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
        runs: 0,
      };
    }
    return getDesignUsageTotals(db, designId);
  });

  /**
   * Backlog-3 §10 — read a budget record. id='global' returns the
   * catch-all entry; design IDs return per-design overrides.
   */
  ipcMain.handle('codesign:v1:get-budget', (_e, raw: unknown) => {
    const obj = raw as { id?: unknown } | null;
    const id = obj?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new CodesignError('get-budget expects { id: string }', 'IPC_BAD_INPUT');
    }
    if (db === null) return null;
    return getBudget(db, id);
  });

  /**
   * Backlog-3 §10 — upsert a budget record. Pass null for either limit
   * to clear it.
   */
  ipcMain.handle('codesign:v1:set-budget', (_e, raw: unknown) => {
    const obj = raw as {
      id?: unknown;
      dailyLimitUsd?: unknown;
      perDesignLimitUsd?: unknown;
      alertAtPct?: unknown;
    } | null;
    if (
      !obj ||
      typeof obj.id !== 'string' ||
      obj.id.length === 0 ||
      (obj.dailyLimitUsd !== null &&
        obj.dailyLimitUsd !== undefined &&
        typeof obj.dailyLimitUsd !== 'number') ||
      (obj.perDesignLimitUsd !== null &&
        obj.perDesignLimitUsd !== undefined &&
        typeof obj.perDesignLimitUsd !== 'number') ||
      typeof obj.alertAtPct !== 'number'
    ) {
      throw new CodesignError('set-budget payload malformed', 'IPC_BAD_INPUT');
    }
    if (db === null) return;
    upsertBudget(db, {
      id: obj.id,
      dailyLimitUsd:
        typeof obj.dailyLimitUsd === 'number' && Number.isFinite(obj.dailyLimitUsd)
          ? obj.dailyLimitUsd
          : null,
      perDesignLimitUsd:
        typeof obj.perDesignLimitUsd === 'number' && Number.isFinite(obj.perDesignLimitUsd)
          ? obj.perDesignLimitUsd
          : null,
      alertAtPct: Math.max(1, Math.min(100, Math.round(obj.alertAtPct))),
    });
  });

  /**
   * Backlog-3 §10 — last N days of daily_usage roll-ups for the
   * cost dashboard sparkline. Default 7 days.
   */
  ipcMain.handle('codesign:v1:daily-usage', (_e, raw: unknown) => {
    const obj = raw as { daysBack?: unknown } | null;
    const daysBack =
      typeof obj?.daysBack === 'number' && Number.isFinite(obj.daysBack)
        ? Math.max(1, Math.min(90, Math.round(obj.daysBack)))
        : 7;
    if (db === null) return [];
    return listDailyUsage(db, daysBack);
  });

  /**
   * User-driven steer: pushes a synthesized override message into the
   * agent's pendingUserSteers queue. The agent's turn_end subscriber
   * drains it via the getPendingSteers callback (see chunk loop above)
   * and surfaces it to the model as a user-role message via agent.steer().
   *
   * Currently used by the chat UI's "Wrap up now" button. Could be
   * extended with arbitrary user prompts in the future ("focus on the
   * pricing section", "stop adding new sections").
   */
  ipcMain.handle('codesign:v1:request-wrap-up', (_e, raw: unknown) => {
    const obj = raw as { generationId?: unknown } | null;
    const generationId = obj?.generationId;
    if (typeof generationId !== 'string' || generationId.length === 0) {
      throw new CodesignError('request-wrap-up expects { generationId: string }', 'IPC_BAD_INPUT');
    }
    if (!inFlight.has(generationId)) {
      logIpc.warn('agent.user_steer.no_inflight', { generationId });
      return { queued: false };
    }
    const message =
      '[user override] STOP all further work. Call `done` IMMEDIATELY with whatever the artifact looks like right now. Do NOT add more sections, do NOT polish further, do NOT ask for permission. The user wants to ship NOW. If `done` returns has_errors, fix the bare minimum and call `done` again — but absolutely no scope expansion.';
    enqueueUserSteer(generationId, message);
    logIpc.info('agent.user_steer.enqueued', { generationId, kind: 'wrap_up' });
    return { queued: true };
  });

  // Integration F — Continue IPC. The renderer's ContinuationPendingRow
  // calls this with the designId of a paused run; we reconstruct the
  // continuation prompt (latest set_todos + decisionRecap from the
  // continuation_pending row + current FS state) and return it to the
  // renderer, which then dispatches the existing `sendPrompt` flow.
  // This is by-design lighter than re-entering generate inline — it
  // reuses 100% of the existing dispatch path so cancellation, dedup,
  // and telemetry all work identically to a manual prompt.
  ipcMain.handle('codesign:v1:continue', async (_e, raw: unknown) => {
    const obj = raw as { designId?: unknown } | null;
    const designId = obj?.designId;
    if (typeof designId !== 'string' || designId.length === 0) {
      throw new CodesignError('continue expects { designId: string }', 'IPC_BAD_INPUT');
    }
    if (db === null) {
      throw new CodesignError('database unavailable', 'DB_UNAVAILABLE');
    }
    // Pull the chat history once. The latest continuation_pending row
    // carries the decision recap; the latest set_todos snapshot is the
    // plan to resume from; the original brief is the first user
    // message. All come from the same query.
    const messages = listChatMessages(db, designId);
    type Continuation = import('@open-codesign/shared').ChatContinuationPendingPayload;
    type SetTodosArgs = { items?: ReadonlyArray<{ text?: string; checked?: boolean }> };
    let latestContinuation: Continuation | null = null;
    let latestTodos: { items: ReadonlyArray<{ text: string; checked: boolean }> } | null = null;
    let originalBrief = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m) continue;
      if (latestContinuation === null && m.kind === 'continuation_pending') {
        latestContinuation = m.payload as Continuation;
      } else if (
        latestTodos === null &&
        m.kind === 'tool_call' &&
        (m.payload as { toolName?: string } | undefined)?.toolName === 'set_todos'
      ) {
        const args = (m.payload as { args?: SetTodosArgs } | undefined)?.args;
        if (args?.items) {
          latestTodos = {
            items: args.items.map((it) => ({
              text: typeof it.text === 'string' ? it.text : '',
              checked: it.checked === true,
            })),
          };
        }
      }
    }
    for (const m of messages) {
      if (m.kind === 'user') {
        originalBrief = (m.payload as { text?: string }).text ?? '';
        break;
      }
    }
    if (latestContinuation === null) {
      throw new CodesignError(
        'no continuation_pending row found for this design',
        'CONTINUATION_NOT_FOUND',
      );
    }
    // 2026-05-07 — when the row carries a `lastUserBrief`, prefer it
    // over the design's first-ever user message. Long-running designs
    // accumulate multiple briefs; resume should reflect the *current*
    // objective, not whatever started the design weeks ago.
    const continuationWithBrief = latestContinuation as typeof latestContinuation & {
      lastUserBrief?: string;
    };
    const briefForPrompt =
      typeof continuationWithBrief.lastUserBrief === 'string' &&
      continuationWithBrief.lastUserBrief.trim().length > 0
        ? continuationWithBrief.lastUserBrief
        : originalBrief;
    // FS state: the design's current files. Defensive — read may fail
    // when the design has no workspace yet.
    let fsState: Array<{ path: string; bytes: number }> = [];
    try {
      const designFiles = listDesignFiles(db, designId);
      fsState = designFiles.map((f) => ({ path: f.path, bytes: f.content.length }));
    } catch (fsErr) {
      logIpc.warn('continuation.fs_state.fail', {
        designId,
        message: fsErr instanceof Error ? fsErr.message : String(fsErr),
      });
    }
    const prompt = buildContinuationPrompt({
      todos: latestTodos,
      decisionRecap: latestContinuation.decisionRecap,
      fsState,
      originalUserPrompt: briefForPrompt,
    });
    logIpc.info('continuation.prompt_built', {
      designId,
      promptLen: prompt.length,
      hasTodos: latestTodos !== null,
      fsFileCount: fsState.length,
      usedLastUserBrief: briefForPrompt !== originalBrief,
    });
    return { prompt };
  });

  ipcMain.handle('codesign:apply-comment', async (event, raw: unknown) => {
    const payload = ApplyCommentPayload.parse(raw);
    const runId = crypto.randomUUID();
    // Capture sender so we can stream text deltas back without re-resolving
    // the BrowserWindow each delta. If the sender goes away (window closed
    // mid-revise), `isDestroyed()` short-circuits so we don't crash on send.
    const sender = event.sender;
    return withRun(runId, async () => {
      const cfg = getCachedConfig();
      if (cfg === null) {
        throw new CodesignError(
          'No configuration found. Complete onboarding first.',
          'CONFIG_MISSING',
        );
      }
      // Inline-comment edits don't need to be tied to whatever provider was
      // pinned in the original generate; resolve fresh against the canonical
      // active provider so a switch in Settings takes effect immediately.
      const hint = payload.model ?? { provider: cfg.provider, modelId: cfg.modelPrimary };
      const active = resolveActiveModel(cfg, hint);
      const allowKeyless = active.allowKeyless;
      await queueClaudeCodeRefresh(active.model.provider);
      const apiKey = await resolveApiKeyForActive(active.model.provider, allowKeyless);
      const baseUrl = active.baseUrl ?? undefined;
      const promptContext = await preparePromptContext({
        attachments: payload.attachments,
        referenceUrl: payload.referenceUrl,
        designSystem: cfg.designSystem ?? null,
      });

      logIpc.info('applyComment', {
        provider: active.model.provider,
        modelId: active.model.modelId,
        ...(active.overridden
          ? { requestedProvider: hint.provider, requestedModelId: hint.modelId }
          : {}),
        selector: payload.selection.selector,
        attachmentCount: payload.attachments.length,
        hasReferenceUrl: payload.referenceUrl !== undefined,
        hasDesignSystem: promptContext.designSystem !== null,
        baseUrl: baseUrl ?? '<default>',
      });

      const t0 = Date.now();
      try {
        const result = await applyComment({
          html: payload.html,
          comment: payload.comment,
          selection: payload.selection,
          model: active.model,
          apiKey,
          attachments: promptContext.attachments,
          referenceUrl: promptContext.referenceUrl,
          designSystem: promptContext.designSystem ?? null,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          wire: active.wire,
          ...(active.httpHeaders !== undefined ? { httpHeaders: active.httpHeaders } : {}),
          ...(allowKeyless ? { allowKeyless: true } : {}),
          ...(active.reasoningLevel !== undefined ? { reasoningLevel: active.reasoningLevel } : {}),
          ...(active.cacheRetention !== undefined ? { cacheRetention: active.cacheRetention } : {}),
          // Inherit prompt-assist constraints from the design so the
          // refinement turn stays on-brief. No-op when the payload omits
          // designId (legacy clients), when the snapshots DB is unavailable,
          // or when the design has no metadata.
          ...(payload.designId !== undefined && db !== null
            ? (() => {
                const design = getDesign(db, payload.designId);
                return design?.promptAssistMetadata
                  ? { promptAssist: design.promptAssistMetadata }
                  : {};
              })()
            : {}),
          // Forward each text delta to the renderer so the comment-revise UI
          // can show partial output instead of waiting on the full buffer.
          // Channel intentionally separate from the agent's `agent:event:v1`
          // — apply-comment is a one-shot revise, not a tool-loop, so its
          // event shape is simpler.
          onTextDelta: (delta: string) => {
            if (sender.isDestroyed()) return;
            sender.send('apply-comment:event:v1', { runId, kind: 'text_delta', delta });
          },
        });
        if (!sender.isDestroyed()) {
          sender.send('apply-comment:event:v1', { runId, kind: 'done' });
        }
        logIpc.info('applyComment.ok', {
          ms: Date.now() - t0,
          artifacts: result.artifacts.length,
          cost: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedInputTokens: result.cachedInputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
        });
        return result;
      } catch (err) {
        logIpc.error('applyComment.fail', {
          ms: Date.now() - t0,
          provider: active.model.provider,
          modelId: active.model.modelId,
          selector: payload.selection.selector,
          message: err instanceof Error ? err.message : String(err),
          code: err instanceof CodesignError ? err.code : undefined,
        });
        recordFinalError('apply-comment', runId, err);
        throw err;
      }
    });
  });

  ipcMain.handle('codesign:v1:generate-title', async (_e, raw: unknown): Promise<string> => {
    const runId = crypto.randomUUID();
    return withRun(runId, async () => {
      if (typeof raw !== 'object' || raw === null) {
        throw new CodesignError('generate-title expects an object payload', 'IPC_BAD_INPUT');
      }
      const prompt = (raw as { prompt?: unknown }).prompt;
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new CodesignError('generate-title requires a non-empty prompt', 'IPC_BAD_INPUT');
      }
      const cfg = getCachedConfig();
      if (cfg === null) throw new CodesignError('No configuration', 'CONFIG_MISSING');
      const active = resolveActiveModel(cfg, {
        provider: cfg.activeProvider,
        modelId: cfg.activeModel,
      });
      const allowKeyless = active.allowKeyless;
      await queueClaudeCodeRefresh(active.model.provider);
      const apiKey = await resolveApiKeyForActive(active.model.provider, allowKeyless);
      const baseUrl = active.baseUrl ?? undefined;
      const titleLogger: CoreLogger = {
        info: (event, data) => logIpc.info(event, data),
        warn: (event, data) => logIpc.warn(event, data),
        error: (event, data) => logIpc.error(event, data),
      };
      try {
        return await generateTitle({
          prompt,
          model: active.model,
          apiKey,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          wire: active.wire,
          ...(active.httpHeaders !== undefined ? { httpHeaders: active.httpHeaders } : {}),
          ...(allowKeyless ? { allowKeyless: true } : {}),
          logger: titleLogger,
        });
      } catch (err) {
        logIpc.error('[title] generate-title.fail', {
          provider: active.model.provider,
          modelId: active.model.modelId,
          baseUrl,
          message: err instanceof Error ? err.message : String(err),
          code: err instanceof CodesignError ? err.code : undefined,
        });
        recordFinalError('title', runId, err);
        throw err;
      }
    });
  });

  ipcMain.handle('codesign:open-log-folder', async () => {
    await shell.openPath(getLogPath());
  });

  ipcMain.handle('codesign:v1:open-external', async (_e, url: unknown) => {
    if (typeof url !== 'string') {
      throw new CodesignError('codesign:v1:open-external requires a string url', 'IPC_BAD_INPUT');
    }
    if (!isAllowedExternalUrl(url)) {
      throw new CodesignError('URL not allowed', 'IPC_BAD_INPUT');
    }
    await shell.openExternal(url);
  });
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', (info) => {
    pendingUpdateAvailable = info;
    mainWindow?.webContents.send('codesign:update-available', info);
  });
  autoUpdater.on('error', (err) => {
    getLogger('main:updates').error('autoUpdater.error', {
      message: err.message,
      stack: err.stack,
    });
  });
  ipcMain.handle('codesign:check-for-updates', () => autoUpdater.checkForUpdates());
  ipcMain.handle('codesign:download-update', () => autoUpdater.downloadUpdate());
  ipcMain.handle('codesign:install-update', () => autoUpdater.quitAndInstall());
}

async function scheduleStartupUpdateCheck(): Promise<void> {
  if (!app.isPackaged) return;
  const prefs = await readPreferences();
  if (prefs.checkForUpdatesOnStartup === false) return;
  setTimeout(() => {
    const updateLog = getLogger('main:updates');
    try {
      autoUpdater.checkForUpdates().catch((err: unknown) => {
        updateLog.error('startup.checkForUpdates.fail', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      updateLog.error('startup.checkForUpdates.throw', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, 30_000);
}

if (!IS_VITEST) {
  // gameplan §7.2 — `game-files://` privileged scheme MUST be registered
  // before app.whenReady() resolves. Setting privileges here means the
  // post-ready protocol.handle() call (further down) can serve module
  // imports + binary assets out of the multi-file project bundle into the
  // preview iframe. The handler itself attaches once the DB is open.
  try {
    protocol.registerSchemesAsPrivileged([
      GAME_FILES_PRIVILEGED_SCHEME,
      // Multi-file design-mode artifacts share the same privileged-scheme
      // shape as game-mode bundles (FS semantics, ES-module loading,
      // streaming binary assets). Registered alongside so the design
      // preview iframe can switch to `design-files://` when sidecar files
      // exist.
      DESIGN_FILES_PRIVILEGED_SCHEME,
      // motion-graphics-plan §4 — same posture for Remotion bundles
      // produced by the main-process bundler.
      MOTION_FILES_PRIVILEGED_SCHEME,
    ]);
  } catch (err) {
    // Re-registration in dev (hot reload) throws; main-process logger isn't
    // wired yet at this point, so route through console which is allowed
    // here only because it sits before app.whenReady().
    // biome-ignore lint/suspicious/noConsole: pre-ready bootstrap, no logger available
    console.warn('[game-files] scheme register failed', err);
  }

  void app.whenReady().then(async () => {
    // Extracted so the outer try/catch AND post-init listeners (whose callbacks
    // fire outside this block) can route failures through the same boot-fallback
    // path. Without this, a later createWindow() throw from app.on('activate')
    // would bypass writeBootErrorSync and leave the user with nothing to attach.
    const handleBootFailure = (err: unknown, title: string, message: string): void => {
      let logsDir: string;
      try {
        logsDir = app.getPath('logs');
      } catch {
        logsDir = app.getPath('temp');
      }
      const bootLogPath = writeBootErrorSync({
        error: err,
        logsDir,
        appVersion: app.getVersion(),
        platform: process.platform,
        electronVersion: process.versions.electron ?? 'unknown',
        nodeVersion: process.versions.node,
      });
      const choice = showBootDialog(app, dialog, {
        type: 'error',
        title,
        message,
        detail: `Error: ${err instanceof Error ? err.message : String(err)}\n\nDiagnostic log: ${bootLogPath}`,
        buttons: ['Copy diagnostic path', 'Open log folder', 'Quit'],
        defaultId: 2,
        cancelId: 2,
      });
      if (choice === 0) clipboard.writeText(bootLogPath);
      if (choice === 1) shell.showItemInFolder(bootLogPath);
    };

    try {
      initLogger();
      // Single-instance lock. Two simultaneous Electron instances would race
      // `cleanupStaleTmps` vs `writeAtomic` (B's cleanup unlinks A's in-flight
      // tmp → ENOENT rename) and collide on the SQLite WAL. macOS usually
      // enforces this at the OS level, but `open -n` defeats that — so we
      // acquire the lock explicitly before touching any shared files.
      const gotLock = app.requestSingleInstanceLock();
      if (!gotLock) {
        app.quit();
        return;
      }
      app.on('second-instance', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      });
      // Show a blocking dialog if the user launched from the DMG mount. If
      // they accept the remedy, we quit here before touching safeStorage / the
      // snapshots DB so nothing half-initialises against a bad install.
      const aborted = await maybeAbortIfRunningFromDmg();
      if (aborted) return;
      await loadConfigOnBoot();
      // Best-effort sweep of leftover `<file>.tmp.<pid>` siblings from previous
      // crashes. pid changes across restarts so without this the config dir
      // accumulates 0o600 litter forever.
      cleanupStaleTmps(join(configDir(), 'reported-fingerprints.json'));
      // Snapshot persistence is best-effort at boot — a failure here (corrupt DB,
      // permission denied, missing native binding) must NOT block the BrowserWindow
      // from opening. Surface it via an error dialog and skip registering the
      // snapshots IPC channels; the rest of the app stays usable.
      const dbResult = safeInitSnapshotsDb(join(app.getPath('userData'), 'designs.db'));
      const diagnosticsDb: Database | null = dbResult.ok ? dbResult.db : null;
      // Cache for motionDesignDirFor() (called from protocol handlers
      // outside this scope). When the DB failed to init, motion runs
      // gracefully degrade — the bundler reports "no design dir wired".
      _snapshotsDb = dbResult.ok ? dbResult.db : null;
      if (dbResult.ok) {
        // gameplan §7.2 — attach the game-files:// handler now that the DB is
        // open. Resolves multi-file game project bundles into the preview
        // iframe. Route any internal failure through the existing logger so
        // protocol issues surface in diagnostics rather than crashing the
        // iframe load.
        const gameFilesLog = getLogger('game-files');
        const gameFilesSynthesize = makeGameFilesSynthesizer(dbResult.db);
        protocol.handle(GAME_FILES_SCHEME, async (request) => {
          try {
            const parsed = parseGameFilesUrl(request.url);
            if (parsed?.isBuild) {
              const resolved = await resolveGameFilesBuildRequest({
                rawUrl: request.url,
                getBuildDir: getGodotWebBuildDir,
                readBuildFile: readGodotBuildFile,
              });
              return new Response(resolved.body, {
                status: resolved.status,
                headers: gameFilesResponseHeaders(resolved),
              });
            }
            const resolved = resolveGameFilesRequest({
              rawUrl: request.url,
              db: dbResult.db,
              synthesize: gameFilesSynthesize,
            });
            return new Response(resolved.body, {
              status: resolved.status,
              headers: gameFilesResponseHeaders(resolved),
            });
          } catch (err) {
            gameFilesLog.error('handle.fail', {
              url: request.url,
              message: err instanceof Error ? err.message : String(err),
            });
            return new Response('Internal protocol error', {
              status: 500,
              headers: { 'content-type': 'text/plain' },
            });
          }
        });
        // motion-graphics-plan §4 — `motion-files://` handler. Same
        // security posture as game-files; resolves to the on-disk
        // `<design>/.bundle/` and any sibling source files written by the
        // motion agent through text_editor. The shell template the
        // bundler copies into `<design>/.bundle/index.html` is the
        // entry the iframe targets.
        const motionFilesLog = getLogger('motion-files');
        protocol.handle(MOTION_FILES_SCHEME, async (request) => {
          try {
            const resolved = await resolveMotionFilesRequest({
              rawUrl: request.url,
              getDesignDir: (designId) => motionDesignDirFor(designId),
            });
            return new Response(resolved.body, {
              status: resolved.status,
              headers: motionFilesResponseHeaders(resolved),
            });
          } catch (err) {
            motionFilesLog.error('handle.fail', {
              url: request.url,
              message: err instanceof Error ? err.message : String(err),
            });
            return new Response('Internal protocol error', {
              status: 500,
              headers: { 'content-type': 'text/plain' },
            });
          }
        });
        // Wire the bundler's design-dir resolver + main-window getter
        // now that both are available in this scope.
        setMotionDesignDirResolver((designId) => motionDesignDirFor(designId));
        setMotionMainWindowGetter(() => mainWindow);
        setMotionCompositionEventSink((designId) => {
          mainWindow?.webContents.send('motion:event:v1', {
            type: 'motion:composition-registered',
            designId,
          });
        });
        // Multi-file design artifacts — same on-disk lookup as
        // game-files but no `_build/*` namespace and no synthesizer.
        // PreviewPane switches to this scheme when a design has more
        // than one file in `design_files`; trivial single-file
        // designs still take the cheaper `srcdoc` path.
        const designFilesLog = getLogger('design-files');
        protocol.handle(DESIGN_FILES_SCHEME, async (request) => {
          try {
            const resolved = resolveDesignFilesRequest({
              rawUrl: request.url,
              db: dbResult.db,
            });
            return new Response(resolved.body, {
              status: resolved.status,
              headers: gameFilesResponseHeaders(resolved),
            });
          } catch (err) {
            designFilesLog.error('handle.fail', {
              url: request.url,
              message: err instanceof Error ? err.message : String(err),
            });
            return new Response('Internal protocol error', {
              status: 500,
              headers: { 'content-type': 'text/plain' },
            });
          }
        });
        registerSnapshotsIpc(dbResult.db);
        registerWorkspaceIpc(dbResult.db, () => mainWindow);
        registerChatMessagesIpc(dbResult.db);
        registerCommentsIpc(dbResult.db);
        registerGameArtifactsIpc(dbResult.db);
        // motion-graphics-plan §4 — list_compositions IPC for the
        // Compositions tab. Same DB the agent's register_composition
        // tool writes through.
        ipcMain.handle('motion:v1:list-compositions', (_evt, payload: { designId: string }) => {
          if (typeof payload?.designId !== 'string') return [];
          return listMotionCompositions(dbResult.db, payload.designId);
        });
        // backlog-2 #7 — Skills CRUD + extractor. The extractor closure
        // routes through `generate()` so the active provider's auth /
        // cache / OAuth-refresh path is reused. systemPrompt override
        // skips skill loading + artifact parsing — extractor returns
        // raw JSON from the model.
        registerSkillsIpc(dbResult.db, {
          runOneShotCompletion: async (messages) => {
            const cfg = getCachedConfig();
            if (cfg === null) {
              throw new CodesignError(
                'No configuration; complete onboarding first.',
                'CONFIG_MISSING',
              );
            }
            const active = resolveActiveModel(cfg, {
              provider: cfg.activeProvider,
              modelId: cfg.activeModel,
            });
            const allowKeyless = active.allowKeyless;
            const apiKey = await resolveApiKeyForActive(active.model.provider, allowKeyless);
            const baseUrl = active.baseUrl ?? undefined;
            const sys = messages.find((m) => m.role === 'system')?.content ?? '';
            const userMsgs = messages.filter((m) => m.role !== 'system');
            const prompt = userMsgs.map((m) => m.content).join('\n\n');
            const out = await generate({
              prompt,
              history: [],
              model: active.model,
              apiKey,
              ...(baseUrl !== undefined ? { baseUrl } : {}),
              wire: active.wire,
              ...(active.httpHeaders !== undefined ? { httpHeaders: active.httpHeaders } : {}),
              ...(allowKeyless ? { allowKeyless: true } : {}),
              systemPrompt: sys,
              logger: getLogger('skills-extractor'),
            });
            return out.message;
          },
        });
        try {
          pruneDiagnosticEvents(dbResult.db, 500);
        } catch (err) {
          getLogger('main:boot').warn('diagnosticEvents.prune.fail', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        const bootLog = getLogger('main:boot');
        bootLog.error('snapshotsDb.init.fail', {
          message: dbResult.error.message,
          stack: dbResult.error.stack,
        });
        // Install stub handlers so renderer-side calls reject with a typed
        // SNAPSHOTS_UNAVAILABLE CodesignError instead of Electron's opaque
        // "No handler registered" rejection — see snapshots-ipc.ts.
        registerSnapshotsUnavailableIpc(dbResult.error.message);
        registerChatMessagesUnavailableIpc(dbResult.error.message);
        registerCommentsUnavailableIpc(dbResult.error.message);
        registerSkillsUnavailableIpc(dbResult.error.message);
        dialog.showErrorBox(
          'Design history unavailable',
          `Could not open the local snapshots database. Version history will be disabled for this session.\n\n${dbResult.error.message}`,
        );
      }
      registerIpcHandlers(diagnosticsDb);
      registerLocaleIpc();
      registerConnectionIpc();
      registerOnboardingIpc();
      registerCodexOAuthIpc();
      registerPreferencesIpc();
      registerImageGenerationSettingsIpc();
      registerExporterIpc(
        () => mainWindow,
        () => (dbResult.ok ? dbResult.db : null),
      );
      registerGodotWebBuildIpc(
        () => mainWindow,
        () => (dbResult.ok ? dbResult.db : null),
      );
      registerDiagnosticsIpc(diagnosticsDb);
      setupAutoUpdater();
      registerAppMenu();
      createWindow();
      void scheduleStartupUpdateCheck();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          try {
            createWindow();
          } catch (err) {
            handleBootFailure(err, 'Cannot reopen window', 'Window failed to open.');
          }
        }
      });
    } catch (err) {
      // Last-resort boot-phase handler. Reached when something before
      // `initLogger()` finishes (or during the first few setup calls)
      // throws — our electron-log sink might not exist yet, so write a
      // best-effort sync log and show a native three-button dialog.
      handleBootFailure(
        err,
        'Open CoDesign failed to start',
        'A startup error prevented the app from loading.',
      );
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
