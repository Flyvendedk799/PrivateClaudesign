/**
 * Hidden BrowserWindow screenshot pipeline for the agent's
 * `render_preview` tool (backlog-2 #5).
 *
 * Mirrors the done-verify hidden-window pattern: build the artifact's
 * srcdoc via `@open-codesign/runtime`, mount it in a sandboxed off-
 * screen BrowserWindow sized to the requested viewport preset, wait
 * for `did-finish-load` + a short settle, then capture the page as PNG
 * and return it as a `data:image/png;base64,…` URL plus the actual
 * dimensions.
 *
 * Not unit-tested by design — Electron + Babel runtime in vitest is
 * the same lift as `done-verify.ts`. Manual verify via `pnpm dev`.
 */

import type { RenderPreviewViewport, RenderPreviewer } from '@open-codesign/core';
import { buildSrcdoc } from '@open-codesign/runtime';
import { BrowserWindow } from './electron-runtime';
import { getLogger } from './logger';

/** Hard cap on total wall-clock per render. Includes window create,
 *  load, settle, capture, destroy. */
const RENDER_TIMEOUT_MS = 1500;
/** How long to wait after did-finish-load for React to settle into a
 *  steady frame before we screenshot. Keep tight — the screenshot
 *  itself is the goal, not the post-mount animation. */
const SETTLE_AFTER_LOAD_MS = 250;

interface ViewportPreset {
  widthPx: number;
  heightPx: number;
}

/** Match the `--size-preview-*` tokens in `packages/ui/src/tokens.css`
 *  so the agent's screenshot is the same shape the renderer would show
 *  the user. iPhone is the canonical mobile target; the e-learning run
 *  was tested at 390×844. */
const VIEWPORT_PRESETS: Record<RenderPreviewViewport, ViewportPreset> = {
  iphone: { widthPx: 390, heightPx: 844 },
  ipad: { widthPx: 768, heightPx: 1024 },
  desktop: { widthPx: 1440, heightPx: 900 },
};

export function makeRenderPreviewer(): RenderPreviewer {
  const log = getLogger('render-preview');
  return async ({ artifactSource, viewport }) => {
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
    try {
      const wc = win.webContents as unknown as {
        once: (event: string, listener: (...args: unknown[]) => void) => void;
        capturePage: () => Promise<{ toPNG: () => Buffer }>;
      };
      const started = Date.now();
      // Race load → settle → capture vs hard timeout. Both branches must
      // resolve so we always destroy the window in `finally`.
      const captured: { png: Buffer | null } = { png: null };
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const hardTimeout = setTimeout(finish, RENDER_TIMEOUT_MS);
        const onFinish = () => {
          // Brief settle so React's first paint stabilises.
          setTimeout(() => {
            void (async () => {
              try {
                const image = await wc.capturePage();
                captured.png = image.toPNG();
              } catch (err) {
                log.warn('capture.fail', {
                  message: err instanceof Error ? err.message : String(err),
                });
              } finally {
                clearTimeout(hardTimeout);
                finish();
              }
            })();
          }, SETTLE_AFTER_LOAD_MS);
        };
        wc.once('did-finish-load', onFinish);
        wc.once('did-fail-load', () => {
          clearTimeout(hardTimeout);
          finish();
        });
        void win.loadURL(dataUrl).catch((err: unknown) => {
          log.warn('loadURL.fail', { message: err instanceof Error ? err.message : String(err) });
          clearTimeout(hardTimeout);
          finish();
        });
      });
      const ms = Date.now() - started;
      if (captured.png === null) {
        throw new Error(
          `render_preview: capture timed out / failed at viewport=${viewport} (${preset.widthPx}×${preset.heightPx}) after ${ms}ms`,
        );
      }
      log.info('capture.ok', {
        viewport,
        widthPx: preset.widthPx,
        heightPx: preset.heightPx,
        bytes: captured.png.length,
        ms,
      });
      return {
        pngDataUrl: `data:image/png;base64,${captured.png.toString('base64')}`,
        widthPx: preset.widthPx,
        heightPx: preset.heightPx,
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
