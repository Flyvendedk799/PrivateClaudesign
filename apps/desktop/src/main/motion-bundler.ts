/**
 * motion-graphics-plan §0.5 + §4 — main-process Remotion bundler.
 *
 * Owns one bundler instance per design, debounces rapid file writes from
 * the agent, and produces `<design>/.bundle/index.js` plus a copy of the
 * fixed iframe shell at `<design>/.bundle/index.html`. Emits IPC events
 * the renderer's `MotionPreviewPane` subscribes to.
 *
 * Lazy-imports `@remotion/bundler` and `@remotion/renderer` per CLAUDE.md
 * §5 — design and game runs pay nothing for motion's heavy webpack stack.
 *
 * Outputs are filesystem-only (`<design>/.bundle/`) — no SQLite row, no
 * snapshot. Treated as a build cache that's safe to nuke and rebuild.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { getLogger } from './logger';

const log = getLogger('motion-bundler');

interface PerDesignState {
  designId: string;
  designDir: string;
  bundleDir: string;
  /** Active bundle promise (for coalescing rapid saves). */
  pending: Promise<BundleResult> | null;
  /** Debounce timer pending a deferred bundle kickoff. */
  debounceTimer: NodeJS.Timeout | null;
  /** Last-known bundle entrypoint absolute path (cached webpack reuse). */
  lastEntryPoint: string | null;
}

const states = new Map<string, PerDesignState>();

export interface BundleResult {
  ok: boolean;
  /** Entrypoint passed to `@remotion/bundler.bundle()`. */
  entryPoint: string;
  /** Absolute path to the produced bundle dir (`<design>/.bundle/`). */
  bundleDir: string;
  /** Compile error string when ok=false. First ~20 lines suitable for the
   *  banner the renderer surfaces. */
  errorText?: string;
  /** Bundle wall-clock in ms. */
  ms: number;
}

const DEFAULT_DEBOUNCE_MS = 300;

/** Resolve the on-disk path the agent's text_editor writes go to.
 *  Apps wire this via setMotionDesignDirResolver(); without it, the bundler
 *  is a no-op. */
let designDirResolver: ((designId: string) => string | null) | null = null;
let mainWindowGetter: (() => BrowserWindow | null) | null = null;

export function setMotionDesignDirResolver(resolver: (designId: string) => string | null): void {
  designDirResolver = resolver;
}

export function setMotionMainWindowGetter(getter: () => BrowserWindow | null): void {
  mainWindowGetter = getter;
}

function getOrInitState(designId: string): PerDesignState | null {
  const existing = states.get(designId);
  if (existing) return existing;
  if (designDirResolver === null) return null;
  const dir = designDirResolver(designId);
  if (dir === null) return null;
  const state: PerDesignState = {
    designId,
    designDir: dir,
    bundleDir: join(dir, '.bundle'),
    pending: null,
    debounceTimer: null,
    lastEntryPoint: null,
  };
  states.set(designId, state);
  return state;
}

/** Schedule a bundle for the design. Coalesces rapid saves with a 300ms
 *  debounce; returns the in-flight promise so callers can await the
 *  result they triggered (or a later one — they're functionally
 *  equivalent for "did this save make it to the iframe?"). */
export function scheduleBundle(designId: string, opts?: { debounceMs?: number }): void {
  const state = getOrInitState(designId);
  if (state === null) return;
  if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
  const delay = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void runBundle(state).catch((err) => {
      log.warn('schedule_bundle.failed', {
        designId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, delay);
}

/** Synchronously trigger a bundle and return the result (no debounce).
 *  Used by `validate_motion_composition` so the agent can read a real
 *  compile error inline in its tool result. */
export async function bundleNow(designId: string): Promise<BundleResult> {
  const state = getOrInitState(designId);
  if (state === null) {
    return {
      ok: false,
      entryPoint: '',
      bundleDir: '',
      errorText: `motion-bundler: no design directory resolver wired for design ${designId}`,
      ms: 0,
    };
  }
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  if (state.pending !== null) return state.pending;
  return runBundle(state);
}

async function runBundle(state: PerDesignState): Promise<BundleResult> {
  if (state.pending !== null) return state.pending;
  const job = (async (): Promise<BundleResult> => {
    const start = Date.now();
    const entryPoint = await pickEntryPoint(state.designDir);
    if (entryPoint === null) {
      return {
        ok: false,
        entryPoint: '',
        bundleDir: state.bundleDir,
        errorText:
          'motion-bundler: no Remotion entry found. Author src/Root.tsx (or src/index.tsx) and try again.',
        ms: Date.now() - start,
      };
    }
    state.lastEntryPoint = entryPoint;
    await mkdir(state.bundleDir, { recursive: true });
    // Note: Remotion's bundler emits its own index.html alongside
    // bundle.js — we let it own that file rather than shipping a
    // custom shell. The relative publicPath option keeps every
    // asset URL bundle-dir-relative so the iframe can load via
    // `motion-files://designs/{id}/.bundle/index.html` cleanly.

    interface RemotionBundler {
      bundle: (input: {
        entryPoint: string;
        outDir: string;
        publicPath?: string;
      }) => Promise<string>;
    }
    let bundlerMod: RemotionBundler | null = null;
    try {
      // Lazy import — design/game runs never pay this. CLAUDE.md §5.
      bundlerMod = (await import('@remotion/bundler')) as unknown as RemotionBundler;
    } catch (err) {
      const errorText = `motion-bundler: @remotion/bundler is not installed. ${
        err instanceof Error ? err.message : String(err)
      }`;
      log.warn('bundler.import_failed', { designId: state.designId, message: errorText });
      emit(state.designId, {
        type: 'motion:bundle-error',
        designId: state.designId,
        errorText,
      });
      return {
        ok: false,
        entryPoint,
        bundleDir: state.bundleDir,
        errorText,
        ms: Date.now() - start,
      };
    }

    try {
      await bundlerMod.bundle({
        entryPoint,
        outDir: state.bundleDir,
        // Make every asset URL the bundler emits (bundle.js, favicon,
        // chunked JS) resolve relative to the bundle dir. Without this
        // the index.html references absolute /bundle.js paths which
        // break under the motion-files:// protocol layout.
        publicPath: './',
      });
    } catch (err) {
      const errorText = (err instanceof Error ? err.message : String(err)).slice(0, 4000);
      log.info('bundle.fail', {
        designId: state.designId,
        ms: Date.now() - start,
        sample: errorText.slice(0, 240),
      });
      emit(state.designId, {
        type: 'motion:bundle-error',
        designId: state.designId,
        errorText,
      });
      return {
        ok: false,
        entryPoint,
        bundleDir: state.bundleDir,
        errorText,
        ms: Date.now() - start,
      };
    }
    log.info('bundle.ok', { designId: state.designId, ms: Date.now() - start });
    emit(state.designId, {
      type: 'motion:bundled',
      designId: state.designId,
      bundleDir: state.bundleDir,
    });
    return { ok: true, entryPoint, bundleDir: state.bundleDir, ms: Date.now() - start };
  })();
  state.pending = job;
  try {
    return await job;
  } finally {
    state.pending = null;
  }
}

async function pickEntryPoint(designDir: string): Promise<string | null> {
  const candidates = [
    join(designDir, 'src/Root.tsx'),
    join(designDir, 'src/index.tsx'),
    join(designDir, 'src/Root.jsx'),
    join(designDir, 'src/index.jsx'),
  ];
  for (const cand of candidates) {
    try {
      await readFile(cand, 'utf8');
      return cand;
    } catch {
      // try next
    }
  }
  return null;
}

interface BundledEvent {
  type: 'motion:bundled';
  designId: string;
  bundleDir: string;
}
interface BundleErrorEvent {
  type: 'motion:bundle-error';
  designId: string;
  errorText: string;
}

function emit(_designId: string, event: BundledEvent | BundleErrorEvent): void {
  const win = mainWindowGetter?.() ?? null;
  if (win === null) return;
  win.webContents.send('motion:event:v1', event);
}

/** Drop all per-design bundler state. Tests call this between cases. */
export function resetMotionBundler(): void {
  for (const s of states.values()) {
    if (s.debounceTimer !== null) clearTimeout(s.debounceTimer);
  }
  states.clear();
  designDirResolver = null;
  mainWindowGetter = null;
}
