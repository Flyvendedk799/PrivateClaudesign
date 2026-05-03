/**
 * Host playtester for the agent's `playtest_game` tool (game-mode guardrails).
 *
 * Mirrors the render-preview hidden-window pattern, but instead of
 * capturing a screenshot the worker dispatches a small ordered list of
 * synthetic input events and reads back `window.__game.debug.snapshot()`
 * between them. The agent gets a serialised trace it can reason against.
 *
 * Synthetic events run via `webContents.executeJavaScript` so we don't
 * need to attach the Electron debugger protocol — the same context the
 * iframe scripts run in dispatches `KeyboardEvent` / `MouseEvent`
 * directly on the canvas + window. This is good enough to flush
 * input → state plumbing (the failure mode the c44763af trace shipped)
 * without simulating a real human at the OS-input layer.
 *
 * Not unit-tested by design — Electron + Babel runtime in vitest is the
 * same lift as `render-preview.ts` / `done-verify.ts`. Manual verify
 * via `pnpm dev`.
 */

import type { PlaytestStep, Playtester } from '@open-codesign/core';
import { buildSrcdoc } from '@open-codesign/runtime';
import { BrowserWindow } from './electron-runtime';
import { getLogger } from './logger';

/** Hard cap on total wall-clock per playtest run. Includes window
 *  create, load, settle, every step, and destroy. Sized so a 12-step
 *  playtest at ~150ms/step + 800ms settle still finishes inside the
 *  budget with margin. */
const PLAYTEST_TIMEOUT_MS = 8000;
/** How long to wait after did-finish-load for the game to boot, RAF
 *  to start, and the agent's `__game.debug.snapshot` getter to become
 *  available. Generous because Three.js scene init + texture upload
 *  can easily eat 400-600 ms before `tick` runs once. */
const SETTLE_AFTER_LOAD_MS = 800;

interface ViewportPreset {
  widthPx: number;
  heightPx: number;
}

const VIEWPORT_PRESETS: Record<'iphone' | 'ipad' | 'desktop', ViewportPreset> = {
  iphone: { widthPx: 390, heightPx: 844 },
  ipad: { widthPx: 768, heightPx: 1024 },
  desktop: { widthPx: 1440, heightPx: 900 },
};

/** Serialised once at the top of the playtest harness. Installs an error
 *  trap, exposes a small dispatcher that runs synthetic events on the
 *  next available animation frame, and provides the snapshot/wait
 *  primitives. Kept inline as a string (rather than a transpiled module)
 *  because `executeJavaScript` is the ONLY path back into the iframe's
 *  context — sandbox + contextIsolation prevent require-style imports. */
const HARNESS_BOOT = `
(() => {
  const errs = [];
  if (!window.__playtestHarness) {
    window.__playtestErrors = errs;
    window.addEventListener('error', (e) => {
      errs.push(String(e.message || e.error || e.type));
    });
    window.addEventListener('unhandledrejection', (e) => {
      errs.push('unhandled: ' + String(e.reason));
    });
    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    async function waitFrames(n) {
      for (let i = 0; i < n; i++) await nextFrame();
    }
    function getCanvas() {
      return (
        document.querySelector('canvas#game') ||
        document.querySelector('#game canvas') ||
        document.querySelector('canvas')
      );
    }
    function dispatchKey(type, code) {
      const ev = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
      const c = getCanvas();
      if (c) c.dispatchEvent(ev);
    }
    function dispatchMouse(type, nx, ny, button) {
      const c = getCanvas();
      const rect = c ? c.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const x = rect.left + Math.max(0, Math.min(1, nx)) * rect.width;
      const y = rect.top + Math.max(0, Math.min(1, ny)) * rect.height;
      const init = { clientX: x, clientY: y, button: button || 0, bubbles: true, cancelable: true, view: window };
      const ev = new MouseEvent(type, init);
      const target = c || window;
      target.dispatchEvent(ev);
      const pe = type === 'mousedown' ? 'pointerdown' : type === 'mouseup' ? 'pointerup' : 'pointermove';
      try {
        const pev = new PointerEvent(pe, { ...init, pointerId: 1, pointerType: 'mouse' });
        target.dispatchEvent(pev);
      } catch (_) { /* PointerEvent unsupported — fall through */ }
    }
    function safeSnapshot() {
      try {
        const dbg = (window.__game && window.__game.debug) || null;
        if (dbg && typeof dbg.snapshot === 'function') {
          return JSON.parse(JSON.stringify(dbg.snapshot()));
        }
      } catch (e) {
        errs.push('snapshot: ' + String(e && e.message ? e.message : e));
      }
      return null;
    }
    window.__playtestHarness = {
      waitFrames,
      dispatchKey,
      dispatchMouse,
      safeSnapshot,
      drainErrors: () => {
        const out = errs.slice();
        errs.length = 0;
        return out;
      },
    };
  }
  return true;
})();
`;

function buildStepScript(step: PlaytestStep): string {
  switch (step.kind) {
    case 'key': {
      const frames = Math.max(1, Math.min(240, step.frames ?? 15));
      const code = JSON.stringify(step.code);
      return `(async () => {
        window.__playtestHarness.dispatchKey('keydown', ${code});
        await window.__playtestHarness.waitFrames(${frames});
        window.__playtestHarness.dispatchKey('keyup', ${code});
        await window.__playtestHarness.waitFrames(2);
        return { snap: window.__playtestHarness.safeSnapshot(), errs: window.__playtestHarness.drainErrors() };
      })();`;
    }
    case 'mouseMove':
      return `(async () => {
        window.__playtestHarness.dispatchMouse('mousemove', ${step.x}, ${step.y}, 0);
        await window.__playtestHarness.waitFrames(2);
        return { snap: window.__playtestHarness.safeSnapshot(), errs: window.__playtestHarness.drainErrors() };
      })();`;
    case 'mouseDown':
      return `(async () => {
        const last = window.__playtestLast || { x: 0.5, y: 0.5 };
        window.__playtestHarness.dispatchMouse('mousedown', last.x, last.y, ${step.button ?? 0});
        await window.__playtestHarness.waitFrames(4);
        return { snap: window.__playtestHarness.safeSnapshot(), errs: window.__playtestHarness.drainErrors() };
      })();`;
    case 'mouseUp':
      return `(async () => {
        const last = window.__playtestLast || { x: 0.5, y: 0.5 };
        window.__playtestHarness.dispatchMouse('mouseup', last.x, last.y, ${step.button ?? 0});
        await window.__playtestHarness.waitFrames(2);
        return { snap: window.__playtestHarness.safeSnapshot(), errs: window.__playtestHarness.drainErrors() };
      })();`;
    case 'wait':
      return `(async () => {
        await window.__playtestHarness.waitFrames(${Math.max(1, Math.min(240, step.frames))});
        return { snap: window.__playtestHarness.safeSnapshot(), errs: window.__playtestHarness.drainErrors() };
      })();`;
  }
}

/** Track the most recent mouseMove coords so a subsequent mouseDown can
 *  fire at the same location without the agent having to re-pass them
 *  every step. The tiny prelude updates `window.__playtestLast` before
 *  `dispatchMouse('mousedown', …)` reads it. */
function buildPreStepUpdate(step: PlaytestStep): string | null {
  if (step.kind !== 'mouseMove') return null;
  return `window.__playtestLast = { x: ${step.x}, y: ${step.y} };`;
}

interface StepRunResult {
  snap: unknown;
  errs: string[];
}

export function makePlaytester(): Playtester {
  const log = getLogger('playtest-game');
  return async ({ artifactSource, viewport, steps }) => {
    const preset = VIEWPORT_PRESETS[viewport];
    const srcdoc = buildSrcdoc(artifactSource);
    const dataUrl = `data:text/html;base64,${Buffer.from(srcdoc, 'utf8').toString('base64')}`;
    const win = new BrowserWindow({
      show: false,
      width: preset.widthPx,
      height: preset.heightPx,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        offscreen: true,
      },
    });
    const wc = win.webContents as unknown as {
      once: (event: string, listener: (...args: unknown[]) => void) => void;
      executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
    };
    const bootErrors: string[] = [];
    const stepResults: Array<{ step: PlaytestStep; snapshotAfter: unknown; errors: string[] }> = [];
    let baselineSnapshot: unknown = null;
    let hasDebugContract = false;
    const started = Date.now();
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const hardTimeout = setTimeout(finish, PLAYTEST_TIMEOUT_MS);
        const onFinish = () => {
          setTimeout(() => {
            void (async () => {
              try {
                await wc.executeJavaScript(HARNESS_BOOT, true);
                const baseline = (await wc.executeJavaScript(
                  '(() => ({ snap: window.__playtestHarness.safeSnapshot(), errs: window.__playtestHarness.drainErrors() }))();',
                  true,
                )) as StepRunResult;
                baselineSnapshot = baseline.snap;
                hasDebugContract = baselineSnapshot !== null;
                bootErrors.push(...(baseline.errs ?? []));
                for (const step of steps) {
                  const remaining = PLAYTEST_TIMEOUT_MS - (Date.now() - started);
                  if (remaining < 200) {
                    bootErrors.push(
                      `playtest budget exhausted before step ${stepResults.length + 1}`,
                    );
                    break;
                  }
                  const pre = buildPreStepUpdate(step);
                  if (pre !== null) await wc.executeJavaScript(pre, true);
                  const result = (await wc.executeJavaScript(buildStepScript(step), true)) as
                    | StepRunResult
                    | undefined;
                  stepResults.push({
                    step,
                    snapshotAfter: result?.snap ?? null,
                    errors: result?.errs ?? [],
                  });
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('playtest.step.fail', { message: msg });
                bootErrors.push(msg);
              } finally {
                clearTimeout(hardTimeout);
                finish();
              }
            })();
          }, SETTLE_AFTER_LOAD_MS);
        };
        wc.once('did-finish-load', onFinish);
        wc.once('did-fail-load', () => {
          bootErrors.push('did-fail-load');
          clearTimeout(hardTimeout);
          finish();
        });
        const winLoadable = win as unknown as { loadURL: (url: string) => Promise<void> };
        void winLoadable.loadURL(dataUrl).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('playtest.loadURL.fail', { message: msg });
          bootErrors.push(`loadURL: ${msg}`);
          clearTimeout(hardTimeout);
          finish();
        });
      });
      const ms = Date.now() - started;
      log.info('playtest.ok', {
        viewport,
        steps: stepResults.length,
        bootErrors: bootErrors.length,
        ms,
        hasDebugContract,
      });
      return {
        hasDebugContract,
        baselineSnapshot,
        steps: stepResults,
        bootErrors,
      };
    } finally {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* noop */
      }
    }
  };
}
