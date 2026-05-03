import { mkdirSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path_module from 'node:path';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentEvent,
  type CoreLogger,
  DESIGN_SKILLS,
  FRAME_TEMPLATES,
  type GenerateImageAssetRequest,
  type GenerateImageAssetResult,
  applyComment,
  generate,
  generateTitle,
  generateViaAgent,
} from '@open-codesign/core';
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
  GeneratePayload,
  GeneratePayloadV1,
} from '@open-codesign/shared';
import { computeFingerprint } from '@open-codesign/shared/fingerprint';
import type BetterSqlite3 from 'better-sqlite3';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AgentStreamEvent } from '../preload/index';
import { registerAppMenu } from './app-menu';
import { showBootDialog, writeBootErrorSync } from './boot-fallback';
import { registerChatMessagesIpc, registerChatMessagesUnavailableIpc } from './chat-messages-ipc';
import { ensureFreshClaudeCodeToken } from './claude-code-token-refresh';
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
import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from './electron-runtime';
import { registerExporterIpc } from './exporter-ipc';
import { findInFlightDuplicate, generateDedupKey, hashContentKey } from './generate-dedup';
import {
  armGenerationTimeout,
  cancelGenerationRequest,
  extractGenerationTimeoutError,
} from './generation-ipc';
import {
  registerImageGenerationSettingsIpc,
  resolveImageGenerationConfig,
  toGenerateImageOptions,
} from './image-generation-settings';
import { maybeAbortIfRunningFromDmg } from './install-check';
import { registerLocaleIpc } from './locale-ipc';
import { getLogPath, getLogger, initLogger } from './logger';
import {
  getApiKeyForProvider,
  getCachedConfig,
  getOnboardingState,
  loadConfigOnBoot,
  registerOnboardingIpc,
  setDesignSystem,
} from './onboarding-ipc';
import { isAllowedExternalUrl } from './open-external';
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
  getDesign,
  getDesignUsageTotals,
  listChatMessages,
  listUserSkills,
  normalizeDesignFilePath,
  pruneDiagnosticEvents,
  recordDiagnosticEvent,
  recordRunUsage,
  safeInitSnapshotsDb,
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
  // Null the reference on close so stale IPC sends from async emitters
  // (autoUpdater, long-running generate runs) become clean no-ops rather
  // than throwing "Object has been destroyed" on a discarded webContents.
  mainWindow.on('closed', () => {
    mainWindow = null;
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

function loadHistoryForAutoContinue(
  db: BetterSqlite3.Database | null,
  designId: string | null,
  mode: 'slim' | 'full' = 'slim',
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
  logger: Pick<CoreLogger, 'error'>;
}

export function createRuntimeTextEditorFs({
  db,
  generationId,
  designId,
  previousHtml,
  sendEvent,
  logger,
}: CreateRuntimeTextEditorFsOptions) {
  const baseCtx = { designId: designId ?? '', generationId } as const;
  const fsMap = new Map<string, string>();
  if (previousHtml && previousHtml.trim().length > 0) {
    fsMap.set('index.html', previousHtml);
  }
  for (const [name, content] of FRAME_TEMPLATES) {
    fsMap.set(`frames/${name}`, content);
  }
  for (const [name, content] of DESIGN_SKILLS) {
    fsMap.set(`skills/${name}`, content);
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
    const { fs, fsMap } = createRuntimeTextEditorFs({
      db,
      designId,
      generationId: id,
      logger: logIpc,
      previousHtml,
      sendEvent,
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
          try {
            const image = await generateImage(options);
            const path = allocateAssetPath(fsMap, request, image.mimeType);
            imageLog.info('provider.ok', {
              generationId: id,
              provider: image.provider,
              model: image.model,
              path,
              ms: Date.now() - started,
              revised: image.revisedPrompt !== undefined,
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

    return generateViaAgent(input, {
      fs,
      runtimeVerify,
      renderPreview,
      userSkills,
      ...(generateImageAsset !== undefined ? { generateImageAsset } : {}),
      onEvent: (event: AgentEvent) => {
        // High-signal only. Skip per-token deltas and inner message_*
        // markers. Emit a concise summary at turn_end.
        if (event.type === 'turn_start') {
          deltaCount = 0;
          toolCount = 0;
          totalTurns += 1;
          logIpc.info('agent.turn_start', { generationId: id });
        } else if (event.type === 'message_update') {
          const ame = event.assistantMessageEvent;
          if (ame.type === 'text_delta') deltaCount += 1;
        } else if (event.type === 'tool_execution_start') {
          toolCount += 1;
          const tn = event.toolName ?? 'unknown';
          toolByName.set(tn, (toolByName.get(tn) ?? 0) + 1);
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
          logIpc.info('agent.turn_end', { generationId: id, deltas: deltaCount, tools: toolCount });
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
          // Per-tool latency telemetry — emits one log line per tool call so
          // post-hoc analysis (`grep agent.tool_duration`) can spot slow
          // tools without requiring SQLite queries against chat_messages.
          logIpc.info('agent.tool_duration', {
            generationId: id,
            tool: event.toolName,
            ms: durationMs,
          });
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
        await ensureFreshClaudeCodeToken(active.model.provider);
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
      // Single-session default. Production trace 2026-04-27 demonstrated
      // that chunked execution + history-reload-between-chunks is the
      // wrong abstraction for design generation: it forces re-planning,
      // loses chain-of-thought (especially with reasoning on), and
      // exits prematurely when the model goes quiet. Claude Code /
      // Cursor / Aider all run a single agent session bounded by an
      // outer timeout. We default to that shape now.
      //
      // The chunk-loop scaffolding stays in place (so we can opt back
      // into chunking via a Settings toggle later if telemetry shows
      // it's needed for ultra-long runs), but MAX_AUTO_CONTINUE=1 means
      // exactly one runGenerate call fires per IPC request. The
      // wall_clock budget for that single chunk is set to the user's
      // GENERATION_TIMEOUT minus 30s headroom, so the agent runs until
      // the user's outer pref — not the old hardcoded 5 min.
      const MAX_AUTO_CONTINUE = 1;
      const generationTimeoutSec = (await readPreferences()).generationTimeoutSec;
      const SINGLE_SESSION_WALL_CLOCK_MS = Math.max(60_000, generationTimeoutSec * 1000 - 30_000);
      const isCodex = active.model.provider === CHATGPT_CODEX_PROVIDER_ID;
      let activeController = controller;
      let chunkPrompt = payload.prompt;
      let chunkHistory = payload.history;
      let chunkPreviousHtml = payload.previousHtml ?? null;
      let lastResult: Awaited<ReturnType<typeof runGenerate>> | null = null;
      const totals = {
        chunks: 0,
        chunksInterrupted: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedInputTokens: 0,
        totalCacheCreationInputTokens: 0,
        totalCostUsd: 0,
      };
      try {
        for (let chunk = 1; chunk <= MAX_AUTO_CONTINUE; chunk += 1) {
          // Fresh controller per chunk so Cancel reliably aborts the
          // current chunk only. Initial chunk uses the outer controller
          // (already in inFlight); subsequent chunks swap in new ones.
          if (chunk > 1) {
            // Bail if the user already cancelled during the previous chunk.
            if (activeController.signal.aborted) break;
            activeController = new AbortController();
            inFlight.set(id, activeController);
          }
          // Fresh GENERATION_TIMEOUT per chunk — that's the whole point
          // of "a new prompt whenever it finishes a task in its plan".
          clearTimeoutGuard();
          clearTimeoutGuard = await armTimeout(id, activeController);

          // Surface chunk progress to the renderer so the chat status
          // header can show "Chunk N of M · X:YY remaining" without
          // inferring from log lines.
          const chunkBudgetMs = active.wallClockBudgetMs ?? SINGLE_SESSION_WALL_CLOCK_MS;
          mainWindow?.webContents.send('agent:event:v1', {
            type: 'chunk_start',
            designId: payload.designId ?? '',
            generationId: id,
            chunkIndex: chunk,
            chunkCap: MAX_AUTO_CONTINUE,
            chunkBudgetMs,
          });

          const chunkResult = await runGenerate(
            {
              prompt: chunkPrompt,
              history: chunkHistory,
              model: active.model,
              apiKey,
              ...(isCodex
                ? { getApiKey: () => resolveActiveApiKeyFromState(active.model.provider) }
                : {}),
              // Attachments + referenceUrl are first-prompt context only;
              // re-sending on auto-continue would re-bill input tokens for
              // unchanged content already in the system prompt.
              attachments: chunk === 1 ? promptContext.attachments : [],
              ...(chunk === 1 && promptContext.referenceUrl !== undefined
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
                chunkIndex: chunk,
                // Per-provider override beats the single-session default;
                // the single-session default beats core's hardcoded 5-min.
                maxWallClockMs: active.wallClockBudgetMs ?? SINGLE_SESSION_WALL_CLOCK_MS,
              },
              // Drain any user-pushed steers (e.g. Wrap-up button) that
              // landed since this chunk's prior turn_end.
              getPendingSteers: () => drainUserSteers(id),
              // Slash-command-driven artifact pattern (renderer parses
              // /jsx /vanilla and forwards via the IPC payload). Defaults
              // to undefined → JSX guidance in agent.ts.
              ...(payload.pattern !== undefined ? { pattern: payload.pattern } : {}),
              // Read prompt-assist constraints from the design so the system
              // prompt can render them as load-bearing scope guidance. Only
              // available when the design has metadata (long prompts skip
              // the dialog and leave it null/undefined). See backlog-1 #9.
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
            chunkPreviousHtml,
          );

          totals.chunks += 1;
          totals.totalInputTokens += chunkResult.inputTokens;
          totals.totalOutputTokens += chunkResult.outputTokens;
          totals.totalCachedInputTokens += chunkResult.cachedInputTokens;
          totals.totalCacheCreationInputTokens += chunkResult.cacheCreationInputTokens;
          totals.totalCostUsd += chunkResult.costUsd;
          if (chunkResult.interrupted) totals.chunksInterrupted += 1;
          lastResult = chunkResult;

          // Notify renderer that this chunk just settled. Includes the
          // interrupted flag so the status header can transition between
          // "auto-resuming…" (interrupted, more chunks coming) and
          // "completing" (clean finish or cap reached).
          mainWindow?.webContents.send('agent:event:v1', {
            type: 'chunk_end',
            designId: payload.designId ?? '',
            generationId: id,
            chunkIndex: chunk,
            chunkCap: MAX_AUTO_CONTINUE,
            chunkInterrupted: chunkResult.interrupted,
          });

          // Cap reached → exit and let the cap-message branch below fire.
          if (chunk >= MAX_AUTO_CONTINUE) break;
          // Exit detection — three states:
          //   1. interrupted = budget hit, definitely keep going
          //   2. !interrupted + done called this run = clean finish, stop
          //   3. !interrupted + NO done called yet = ABANDONED — model
          //      stopped emitting tools without converging. Production
          //      trace 2026-04-27 mogvfm77 hit this on chunk 4: agent
          //      ran out of ideas mid-design and the loop wrongly read
          //      the empty turn as "we're done". Force one more chunk
          //      with a strong steer; if THAT chunk also abandons,
          //      truly stop (fall through on the next iteration).
          if (!chunkResult.interrupted) {
            const doneCallCount =
              db && payload.designId
                ? listChatMessages(db, payload.designId).filter((row) => {
                    if (row.kind !== 'tool_call') return false;
                    const p = row.payload as { toolName?: string } | null;
                    return p?.toolName === 'done';
                  }).length
                : 0;
            if (doneCallCount > 0) break; // clean exit — agent really finished
            // Abandonment: agent went quiet without calling done. Fire
            // one more chunk with an explicit "you stopped without
            // calling done — finish or call done now" steer. We fold
            // the steer into chunkPrompt for the next iteration.
            logIpc.warn('agent.abandoned_without_done', {
              generationId: id,
              chunk,
              tip: 'forcing one more chunk with a wrap-up steer',
            });
            chunkPrompt = `[auto-continue chunk ${chunk + 1}/${MAX_AUTO_CONTINUE}] You stopped emitting tool calls but never called \`done\`. The artifact is incomplete. Either: (a) finish the remaining unticked todos as quickly as possible (1-3 small str_replace per turn, then call \`done\`), OR (b) if you genuinely think the artifact is finished, call \`done\` immediately so the run can exit cleanly. Do NOT just produce more prose — every turn must include at least one tool call.`;
            chunkHistory = loadHistoryForAutoContinue(
              db,
              payload.designId ?? null,
              active.reasoningLevel !== undefined ? 'full' : 'slim',
            );
            chunkPreviousHtml = chunkResult.artifacts[0]?.content ?? chunkPreviousHtml;
            continue;
          }

          // Prepare the next chunk: synthesized continue prompt, history
          // reloaded from DB (includes everything just appended during
          // this chunk's runGenerate), seed previousHtml with the artifact
          // we just produced so the next chunk's fresh fs starts from it.
          chunkPrompt = `[auto-continue chunk ${chunk + 1}/${MAX_AUTO_CONTINUE}] Continue where you left off — pick the next plan items and finish them. Aim to finish the design within the remaining ${MAX_AUTO_CONTINUE - chunk} chunk(s).`;
          // Reasoning-on agents need full history to maintain chain-of-
          // thought across chunk boundaries (Anthropic doesn't expose
          // internal thinking blocks to subsequent API calls). Reasoning-
          // off agents get the slim summary for the cache + first-token
          // win.
          chunkHistory = loadHistoryForAutoContinue(
            db,
            payload.designId ?? null,
            active.reasoningLevel !== undefined ? 'full' : 'slim',
          );
          chunkPreviousHtml = chunkResult.artifacts[0]?.content ?? chunkPreviousHtml;
        }

        if (!lastResult) {
          throw new CodesignError('Auto-continue loop produced no result', 'PROVIDER_ERROR');
        }

        // Hit the cap with work still pending — rewrite the final message
        // so the user knows manual resume is needed. Distinct copy from
        // the per-chunk "Paused — auto-resuming" hint so the UI reads
        // differently in the cap-reached case.
        if (lastResult.interrupted && totals.chunks >= MAX_AUTO_CONTINUE) {
          const baseMsg = lastResult.message;
          lastResult = {
            ...lastResult,
            message: `${baseMsg}${baseMsg.length > 0 ? '\n\n' : ''}— Reached the ${MAX_AUTO_CONTINUE}-chunk auto-continue cap. The artifact above is what landed; type **keep going** (or any follow-up) to do more. —`,
          };
        }

        logIpc.info('generate.ok', {
          generationId: id,
          ms: Date.now() - t0,
          artifacts: lastResult.artifacts.length,
          cost: totals.totalCostUsd,
          inputTokens: totals.totalInputTokens,
          outputTokens: totals.totalOutputTokens,
          cachedInputTokens: totals.totalCachedInputTokens,
          cacheCreationInputTokens: totals.totalCacheCreationInputTokens,
        });
        logIpc.info('generate.summary', {
          generationId: id,
          totalMs: Date.now() - t0,
          totalChunks: totals.chunks,
          chunksInterrupted: totals.chunksInterrupted,
          capReached: lastResult.interrupted && totals.chunks >= MAX_AUTO_CONTINUE,
          totalInputTokens: totals.totalInputTokens,
          totalOutputTokens: totals.totalOutputTokens,
          totalCachedInputTokens: totals.totalCachedInputTokens,
          totalCostUsd: totals.totalCostUsd,
        });
        // plan0305 P3.2 — persist per-run token + cost telemetry. Aggregated
        // across all auto-continue chunks; keyed by generationId so a retry
        // overwrites rather than duplicating. Read by the chat status header
        // ("this design cost $X.XX") and any future cost dashboards.
        if (db !== null) {
          try {
            recordRunUsage(db, {
              generationId: id,
              designId: payload.designId ?? null,
              inputTokens: totals.totalInputTokens,
              outputTokens: totals.totalOutputTokens,
              cachedInputTokens: totals.totalCachedInputTokens,
              cacheCreationInputTokens: totals.totalCacheCreationInputTokens,
              costUsd: totals.totalCostUsd,
              totalChunks: totals.chunks,
              totalMs: Date.now() - t0,
              provider: active.model.provider,
              modelId: active.model.modelId,
            });
          } catch (err) {
            logIpc.warn('run_usage.persist.fail', {
              generationId: id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Surface aggregate metrics on the returned result so the renderer
        // shows total tokens (across all chunks), not just the last one.
        return {
          ...lastResult,
          inputTokens: totals.totalInputTokens,
          outputTokens: totals.totalOutputTokens,
          cachedInputTokens: totals.totalCachedInputTokens,
          cacheCreationInputTokens: totals.totalCacheCreationInputTokens,
          costUsd: totals.totalCostUsd,
        };
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
        await ensureFreshClaudeCodeToken(active.model.provider);
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
    const { generationId } = CancelGenerationPayloadV1.parse(raw);
    cancelGenerationRequest(generationId, inFlight, logIpc);
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
      await ensureFreshClaudeCodeToken(active.model.provider);
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
      await ensureFreshClaudeCodeToken(active.model.provider);
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
      if (dbResult.ok) {
        registerSnapshotsIpc(dbResult.db);
        registerWorkspaceIpc(dbResult.db, () => mainWindow);
        registerChatMessagesIpc(dbResult.db);
        registerCommentsIpc(dbResult.db);
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
