import { useT } from '@open-codesign/i18n';
import {
  type ElementRectsMessage,
  type IframeErrorMessage,
  type OverlayMessage,
  buildSrcdoc,
  isElementRectsMessage,
  isIframeErrorMessage,
  isOverlayMessage,
} from '@open-codesign/runtime';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesignFiles } from '../hooks/useDesignFiles';
import { EmptyState } from '../preview/EmptyState';
import { ErrorState } from '../preview/ErrorState';
import { useCodesignStore } from '../store';
import { CanvasErrorBar } from './CanvasErrorBar';
import { CanvasTabBar } from './CanvasTabBar';
import { EditCursorOverlay } from './EditCursorOverlay';
import { FilesTabView } from './FilesTabView';
import { PhoneFrame } from './PhoneFrame';
import { PreviewToolbar } from './PreviewToolbar';
import { TweakPanel } from './TweakPanel';
import { CommentBubble } from './comment/CommentBubble';
import { PinOverlay } from './comment/PinOverlay';
import { AnimationsTabView } from './game/AnimationsTabView';
import { GameProjectTabs } from './game/GameProjectTabs';
import { LevelsTabView } from './game/LevelsTabView';
import { SpritesTabView } from './game/SpritesTabView';
import { WorldDesignerTabView } from './game/WorldDesignerTabView';
import { MotionCompositionsView } from './motion/MotionCompositionsView';
import { MotionPreviewPane } from './motion/MotionPreviewPane';
import { MotionProjectTabs } from './motion/MotionProjectTabs';

export interface PreviewPaneProps {
  onPickStarter: (prompt: string) => void;
}

export function formatIframeError(
  kind: string,
  message: string,
  source?: string,
  lineno?: number,
): string {
  const location = source && lineno ? ` (${source}:${lineno})` : '';
  return `${kind}: ${message}${location}`;
}

export function isTrustedPreviewMessageSource(
  source: MessageEventSource | null,
  previewWindow: Window | null | undefined,
): boolean {
  return source !== null && source === previewWindow;
}

export function postModeToPreviewWindow(
  win: Window | null | undefined,
  mode: string,
  onError: (message: string) => void,
): boolean {
  if (!win) return false;
  try {
    win.postMessage({ __codesign: true, type: 'SET_MODE', mode }, '*');
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    onError(`SET_MODE postMessage failed: ${reason}`);
    return false;
  }
}

export function scaleRectForZoom(
  rect: { top: number; left: number; width: number; height: number },
  zoomPercent: number,
): { top: number; left: number; width: number; height: number } {
  const scale = zoomPercent / 100;
  return {
    top: rect.top * scale,
    left: rect.left * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * Backlog-3 §1 — extract the body text of every `<style>` or `<script>`
 * block in document order. Used by the HMR effect in `PreviewSlot` to
 * build the postMessage envelope that patches CSS / single-script
 * content in place.
 */
function collectBlockBodies(html: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
  while ((m = re.exec(html)) !== null) out.push(m[1] ?? '');
  return out;
}

export function stablePreviewSourceKey(source: string): string {
  const head = source.trimStart().slice(0, 2048).toLowerCase();
  // Full HTML documents — Backlog-3 §1 — collapse `<style>` and
  // `<script>` block bodies to placeholders so CSS-only / JS-only diffs
  // produce the same stable key. The HMR patcher (./hmr-patcher.ts in
  // packages/runtime) takes the content delta via postMessage, so the
  // iframe document never reloads when only block bodies changed.
  // Structural changes (added/removed elements outside blocks, or
  // mismatched block counts) DO change the key and force a reload.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    return source
      .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '<style>__HMR_CSS__</style>')
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '<script>__HMR_JS__</script>');
  }
  return source
    .replace(
      /\/\*\s*EDITMODE-BEGIN\s*\*\/[\s\S]*?\/\*\s*EDITMODE-END\s*\*\//g,
      '/*EDITMODE-BEGIN*/__STABLE__/*EDITMODE-END*/',
    )
    .replace(
      /\/\*\s*TWEAK-SCHEMA-BEGIN\s*\*\/[\s\S]*?\/\*\s*TWEAK-SCHEMA-END\s*\*\//g,
      '/*TWEAK-SCHEMA-BEGIN*/__STABLE__/*TWEAK-SCHEMA-END*/',
    );
}

export type AllowedPreviewMessageType = 'ELEMENT_SELECTED' | 'IFRAME_ERROR' | 'ELEMENT_RECTS';

export interface PreviewMessageHandlers {
  onElementSelected: (msg: OverlayMessage) => void;
  onIframeError: (msg: IframeErrorMessage) => void;
  onElementRects: (msg: ElementRectsMessage) => void;
}

export type PreviewMessageOutcome =
  | { status: 'handled'; type: AllowedPreviewMessageType }
  | { status: 'rejected'; reason: 'envelope' | 'unknown-type' | 'shape'; type?: string };

export function handlePreviewMessage(
  data: unknown,
  handlers: PreviewMessageHandlers,
): PreviewMessageOutcome {
  if (typeof data !== 'object' || data === null) {
    return { status: 'rejected', reason: 'envelope' };
  }
  const envelope = data as { __codesign?: unknown; type?: unknown };
  if (envelope.__codesign !== true || typeof envelope.type !== 'string') {
    return { status: 'rejected', reason: 'envelope' };
  }

  switch (envelope.type) {
    case 'ELEMENT_SELECTED':
      if (isOverlayMessage(data)) {
        handlers.onElementSelected(data);
        return { status: 'handled', type: 'ELEMENT_SELECTED' };
      }
      return { status: 'rejected', reason: 'shape', type: envelope.type };
    case 'IFRAME_ERROR':
      if (isIframeErrorMessage(data)) {
        handlers.onIframeError(data);
        return { status: 'handled', type: 'IFRAME_ERROR' };
      }
      return { status: 'rejected', reason: 'shape', type: envelope.type };
    case 'ELEMENT_RECTS':
      if (isElementRectsMessage(data)) {
        handlers.onElementRects(data);
        return { status: 'handled', type: 'ELEMENT_RECTS' };
      }
      return { status: 'rejected', reason: 'shape', type: envelope.type };
    default:
      return { status: 'rejected', reason: 'unknown-type', type: envelope.type };
  }
}

const COMMENT_HINT_CLASS =
  'absolute left-[var(--space-5)] top-[var(--space-5)] z-10 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-[var(--space-3)] py-[var(--space-1)] text-[var(--text-xs)] text-[var(--color-text-secondary)] shadow-[var(--shadow-soft)] backdrop-blur';

import type { GamePreviewMode } from '@open-codesign/shared';
import { resolveDesignFilesSrc, resolveGamePreviewSrc, resolveGameSrc } from '../lib/preview-src';

export { resolveDesignFilesSrc, resolveGamePreviewSrc, resolveGameSrc };

const DEFAULT_GAME_PREVIEW_MODE: GamePreviewMode = { mode: 'game' };

interface PreviewSlotProps {
  designId: string;
  html: string;
  /** A6.x — when present, the iframe loads from this URL via src= instead
   *  of rendering `html` via srcdoc. Used for game-mode designs whose
   *  preview lives behind game-files://, and Godot web builds that point
   *  at the per-design _build/ output. */
  srcUrl?: string;
  active: boolean;
  viewport: 'mobile' | 'tablet' | 'desktop';
  /** A6.x — when set, the iframe renders inside a max-aspect frame
   *  instead of the device-form-factor wrappers. Game designs use this
   *  exclusively. */
  gameAspect?: '16:9' | '4:3' | '1:1' | '9:16';
  zoom: number;
  showCommentUi: boolean;
  commentHintLabel: string;
  pinOverlay: React.ReactNode;
  interactionMode: string;
  registerIframe: (designId: string, el: HTMLIFrameElement | null) => void;
  onIframeError: (message: string) => void;
  onIframeLoaded: (designId: string) => void;
}

/** A6.x — width / height the preview wrapper uses for each aspect.
 *  Larger axis is 1280 (16:9) / 1024 (4:3) / 800 (1:1) / 540 (9:16) so
 *  most desktops show the full frame without scrolling. The iframe
 *  scales to its container so these are upper bounds, not fixed sizes. */
const GAME_ASPECT_DIMS = {
  '16:9': { w: 1280, h: 720 },
  '4:3': { w: 1024, h: 768 },
  '1:1': { w: 800, h: 800 },
  '9:16': { w: 540, h: 960 },
} as const;

// One iframe per pool entry. Hidden (display:none) when not active, but kept
// in the DOM so its document — already parsed HTML, executed scripts, laid
// out — survives design switches. That's the whole point of the pool. The
// srcDocStableKey trick is per-slot so token-only tweaks via postMessage
// don't rebuild the document (~300-500ms blank on JSX cards).
function PreviewSlot({
  designId,
  html,
  srcUrl,
  active,
  viewport,
  gameAspect,
  zoom,
  showCommentUi,
  commentHintLabel,
  pinOverlay,
  interactionMode,
  registerIframe,
  onIframeError,
  onIframeLoaded,
}: PreviewSlotProps) {
  const srcDocStableKey = useMemo(() => stablePreviewSourceKey(html), [html]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: srcDocStableKey is the intentional dependency. html flows through naturally because the factory closes over it and re-runs whenever the stable key flips, which is exactly when structural changes (anything outside EDITMODE / TWEAK_SCHEMA markers) are present.
  const srcDoc = useMemo(() => buildSrcdoc(html), [srcDocStableKey]);

  // Backlog-3 §1 — when srcDocStableKey did NOT change but `html` did
  // (i.e. CSS-only or single-script JS-only edits to a full HTML
  // document), post the patch into the iframe so the in-document
  // `<style>` block updates without a full reload. This preserves
  // canvas rAF state, video playback, scroll position, and form
  // values across iteration runs.
  const lastAppliedHtmlRef = useRef<string>(html);
  const iframeElRef = useRef<HTMLIFrameElement | null>(null);

  // Backlog-3 §1 telemetry — capture HMR acks from the in-iframe
  // patcher so we can see how often CSS/JS-only patches succeed vs.
  // fall back to a full reload. Active is the only slot that matters
  // (background pool slots don't fire HMR). Throttled-light: one
  // console.debug per ack.
  useEffect(() => {
    if (!active) return;
    const onAck = (event: MessageEvent) => {
      const iframe = iframeElRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as {
        __codesign_hmr_ack?: unknown;
        protocolVersion?: unknown;
        ok?: unknown;
        kind?: unknown;
        error?: unknown;
      } | null;
      if (!data || data.__codesign_hmr_ack !== true) return;
      // eslint-disable-next-line no-console
      console.debug('[hmr] ack', {
        designId,
        ok: data.ok,
        kind: data.kind,
        protocolVersion: data.protocolVersion,
        ...(typeof data.error === 'string' ? { error: data.error } : {}),
      });
    };
    window.addEventListener('message', onAck);
    return () => window.removeEventListener('message', onAck);
  }, [active, designId]);

  useEffect(() => {
    const prev = lastAppliedHtmlRef.current;
    if (prev === html) return;
    lastAppliedHtmlRef.current = html;
    const iframe = iframeElRef.current;
    if (!iframe || !iframe.contentWindow) return;
    const win = iframe.contentWindow;
    const headPrev = prev.trimStart().slice(0, 2048).toLowerCase();
    const headCur = html.trimStart().slice(0, 2048).toLowerCase();
    const wasFullDoc = headPrev.startsWith('<!doctype') || headPrev.startsWith('<html');
    const isFullDoc = headCur.startsWith('<!doctype') || headCur.startsWith('<html');
    if (!wasFullDoc || !isFullDoc) return;
    const oldStyles = collectBlockBodies(prev, /<style\b[^>]*>([\s\S]*?)<\/style>/gi);
    const newStyles = collectBlockBodies(html, /<style\b[^>]*>([\s\S]*?)<\/style>/gi);
    const oldScripts = collectBlockBodies(prev, /<script\b[^>]*>([\s\S]*?)<\/script>/gi);
    const newScripts = collectBlockBodies(html, /<script\b[^>]*>([\s\S]*?)<\/script>/gi);
    const stylesDiffer =
      oldStyles.length === newStyles.length && oldStyles.some((s, i) => s !== newStyles[i]);
    const scriptsDiffer =
      oldScripts.length === newScripts.length && oldScripts.some((s, i) => s !== newScripts[i]);
    if (stylesDiffer && oldStyles.length === newStyles.length) {
      try {
        win.postMessage(
          {
            __codesign_hmr: true,
            protocolVersion: 1,
            kind: 'css',
            oldStyles,
            newStyles,
          },
          '*',
        );
        // Backlog-3 §1 telemetry — record what we just attempted so
        // a missing ack reads as "iframe never replied" rather than
        // "renderer skipped the patch path".
        // eslint-disable-next-line no-console
        console.debug('[hmr] send', { designId, kind: 'css', styleBlocks: newStyles.length });
      } catch {
        /* iframe may have closed */
      }
    } else if (scriptsDiffer && oldScripts.length === newScripts.length) {
      try {
        win.postMessage(
          {
            __codesign_hmr: true,
            protocolVersion: 1,
            kind: 'js',
            oldScripts,
            newScripts,
          },
          '*',
        );
        // eslint-disable-next-line no-console
        console.debug('[hmr] send', { designId, kind: 'js', scriptBlocks: newScripts.length });
      } catch {
        /* iframe may have closed */
      }
    }
  }, [html, designId]);

  const setRef = useCallback(
    (el: HTMLIFrameElement | null) => {
      iframeElRef.current = el;
      registerIframe(designId, el);
    },
    [designId, registerIframe],
  );

  const isMobile = viewport === 'mobile';
  const scale = zoom / 100;
  const inversePct = `${10000 / zoom}%`;

  // A6.x — game-mode designs (and Godot web-builds) load via src= so the
  // iframe document lives on a real origin (game-files://) and modules /
  // assets resolve through the protocol handler. Falls back to srcDoc for
  // design-mode designs and game designs without a usable URL yet (e.g. a
  // Godot project the user hasn't built a web preview for).
  const useSrcUrl = typeof srcUrl === 'string' && srcUrl.length > 0;
  const rawIframe = (
    <iframe
      ref={setRef}
      title={`design-preview-${designId}`}
      sandbox={
        useSrcUrl
          ? 'allow-scripts allow-same-origin allow-pointer-lock allow-fullscreen'
          : 'allow-scripts'
      }
      {...(useSrcUrl ? { src: srcUrl } : { srcDoc })}
      onLoad={(e) => {
        // Once the iframe's document has actually loaded, its in-page message
        // handler is ready — this is the reliable moment to (re)post SET_MODE.
        // The parent's currentDesignId useEffect can fire before the document
        // loads, so that post may be dropped. Only re-post for the active
        // slot so we don't redirect background iframes into comment mode.
        if (!active) return;
        const target = e.currentTarget as HTMLIFrameElement;
        postModeToPreviewWindow(target.contentWindow, interactionMode, onIframeError);
        // The parent's WATCH_SELECTORS post can race past a freshly-mounted
        // iframe before its message listener installs. Ping the parent so it
        // re-broadcasts after load has confirmed the overlay is live.
        onIframeLoaded(designId);
      }}
      className={
        isMobile
          ? 'block w-full h-full bg-transparent border-0'
          : 'w-full h-full bg-transparent border-0'
      }
    />
  );
  const iframe =
    zoom === 100 ? (
      rawIframe
    ) : (
      <div
        className="origin-top-left"
        style={{ transform: `scale(${scale})`, width: inversePct, height: inversePct }}
      >
        {rawIframe}
      </div>
    );

  let body: React.ReactNode;
  if (gameAspect !== undefined) {
    const dims = GAME_ASPECT_DIMS[gameAspect];
    body = (
      <div className="h-full w-full p-6 flex items-center justify-center overflow-auto bg-[var(--color-background)]">
        <div
          className="relative bg-black shadow-[var(--shadow-elevated)]"
          style={{
            width: '100%',
            height: '100%',
            maxWidth: `${dims.w}px`,
            maxHeight: `${dims.h}px`,
            aspectRatio: `${dims.w} / ${dims.h}`,
          }}
        >
          {iframe}
          {active ? pinOverlay : null}
        </div>
      </div>
    );
  } else if (isMobile) {
    body = (
      <div className="min-h-full p-6 flex flex-col items-center justify-center overflow-auto">
        <div className="relative inline-flex">
          <PhoneFrame>{iframe}</PhoneFrame>
          {active ? pinOverlay : null}
        </div>
      </div>
    );
  } else if (viewport === 'tablet') {
    body = (
      <div className="h-full p-6 flex flex-col items-center justify-start overflow-auto">
        <div
          className="relative"
          style={{
            width: 'var(--size-preview-tablet-width)',
            height: 'var(--size-preview-tablet-height)',
            flexShrink: 0,
          }}
        >
          {showCommentUi && active ? (
            <div className={COMMENT_HINT_CLASS}>{commentHintLabel}</div>
          ) : null}
          {iframe}
          {active ? pinOverlay : null}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="h-full w-full relative">
        {showCommentUi && active ? (
          <div className={COMMENT_HINT_CLASS}>{commentHintLabel}</div>
        ) : null}
        {iframe}
        {active ? pinOverlay : null}
      </div>
    );
  }

  return (
    <div hidden={!active} className="h-full w-full">
      {body}
    </div>
  );
}

/**
 * Floating "Preview updated" pill — appears briefly over the active iframe
 * after an agent run lands edits. Without this, a long multi-section
 * refactor (e.g. the drone-portfolio run on 2026-04-28 added 5 sections
 * below the hero) is invisible: the user sees the same hero/above-the-fold
 * view and concludes nothing changed. The pill makes the change perceptible
 * AND tells the user to scroll. Fades out after 6 s.
 */
function PreviewUpdatedPill() {
  const previewUpdatedAt = useCodesignStore((s) => s.previewUpdatedAt);
  const currentDesignId = useCodesignStore((s) => s.currentDesignId);
  const setPreviewUpdatedAt = useCodesignStore((s) => s.setPreviewUpdatedAt);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!previewUpdatedAt || previewUpdatedAt.designId !== currentDesignId) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const id = setTimeout(() => {
      setVisible(false);
      // Clear the global state shortly after the fade so it doesn't re-fire
      // on the next currentDesignId change.
      setTimeout(() => setPreviewUpdatedAt(null), 400);
    }, 6_000);
    return () => clearTimeout(id);
  }, [previewUpdatedAt, currentDesignId, setPreviewUpdatedAt]);
  if (!previewUpdatedAt || previewUpdatedAt.designId !== currentDesignId) return null;
  const kb = (Math.abs(previewUpdatedAt.bytesDelta) / 1024).toFixed(1);
  const sign = previewUpdatedAt.bytesDelta >= 0 ? '+' : '−';
  const big = Math.abs(previewUpdatedAt.bytesDelta) >= 4096; // ≥4 KB ≈ a meaningful structural rewrite
  return (
    <div
      className={`pointer-events-none absolute top-[var(--space-2)] left-1/2 -translate-x-1/2 z-30 transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
      aria-live="polite"
    >
      <div className="rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-surface)] shadow-[0_4px_18px_-6px_rgba(0,0,0,0.25)] px-[var(--space-3)] py-[var(--space-1)] flex items-center gap-[var(--space-2)] text-[12px]">
        <span className="relative inline-flex w-[8px] h-[8px]">
          <span className="absolute inline-block w-full h-full rounded-full bg-[var(--color-accent)]" />
          <span className="absolute inline-block w-full h-full rounded-full bg-[var(--color-accent)]/40 animate-ping" />
        </span>
        <span className="font-medium text-[var(--color-text-primary)]">Preview updated</span>
        <span className="text-[var(--color-text-muted)]">
          {sign}
          {kb} KB
        </span>
        {big ? (
          <span className="text-[var(--color-text-muted)] italic">
            — scroll to see new sections
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function PreviewPane({ onPickStarter }: PreviewPaneProps) {
  const t = useT();
  const previewHtml = useCodesignStore((s) => s.previewHtml);
  const previewHtmlByDesign = useCodesignStore((s) => s.previewHtmlByDesign);
  const recentDesignIds = useCodesignStore((s) => s.recentDesignIds);
  const currentDesignId = useCodesignStore((s) => s.currentDesignId);
  // Multi-file design-mode artifacts route through the `design-files://`
  // protocol so sidecar `.css` / `.js` resolve via the FS-backed handler.
  // Only the active slot needs this — background pool slots are
  // display:none and never render. Cheap: the hook only re-IPCs when
  // designId or previewReloadTick changes.
  const activeDesignFiles = useDesignFiles(currentDesignId);
  const currentDesignEngine = useCodesignStore((s) => s.currentDesignEngine);
  const godotPreviewByDesign = useCodesignStore((s) => s.godotPreviewByDesign);
  const gameAspect = useCodesignStore((s) => s.gameAspect);
  const designs = useCodesignStore((s) => s.designs);
  const chatMessages = useCodesignStore((s) => s.chatMessages);
  const canvasTabs = useCodesignStore((s) => s.canvasTabs);
  const activeCanvasTab = useCodesignStore((s) => s.activeCanvasTab);
  const errorMessage = useCodesignStore((s) => s.errorMessage);
  const retry = useCodesignStore((s) => s.retryLastPrompt);
  const clearError = useCodesignStore((s) => s.clearError);
  const pushIframeError = useCodesignStore((s) => s.pushIframeError);
  const selectCanvasElement = useCodesignStore((s) => s.selectCanvasElement);
  const previewViewport = useCodesignStore((s) => s.previewViewport);
  const previewZoom = useCodesignStore((s) => s.previewZoom);
  const previewReloadTick = useCodesignStore((s) => s.previewReloadTick);
  const previewUpdatedAt = useCodesignStore((s) => s.previewUpdatedAt);
  // D1 — short-lived edit-flash on the active iframe wrapper. Fires the
  // moment an agent run completes with a non-zero byte delta (same trigger
  // as the "Preview updated" pill), then settles after 1.4 s. Adds a
  // visceral "something just landed" cue on top of the textual pill — the
  // user's eye catches the flash even if they weren't looking at the chat
  // when the run completed.
  const [editFlashKey, setEditFlashKey] = useState(0);
  useEffect(() => {
    if (!previewUpdatedAt) return;
    setEditFlashKey((n) => n + 1);
  }, [previewUpdatedAt]);
  const interactionMode = useCodesignStore((s) => s.interactionMode);
  const comments = useCodesignStore((s) => s.comments);
  const currentSnapshotId = useCodesignStore((s) => s.currentSnapshotId);
  const commentBubble = useCodesignStore((s) => s.commentBubble);
  const openCommentBubble = useCodesignStore((s) => s.openCommentBubble);
  const closeCommentBubble = useCodesignStore((s) => s.closeCommentBubble);
  const submitComment = useCodesignStore((s) => s.submitComment);
  const applyLiveRects = useCodesignStore((s) => s.applyLiveRects);
  const clearLiveRects = useCodesignStore((s) => s.clearLiveRects);
  const liveRects = useCodesignStore((s) => s.liveRects);
  const editCursor = useCodesignStore((s) => s.editCursor);

  // Active iframe ref consumed by TweakPanel (postMessage target) and by the
  // window.message guard. We re-point this whenever the active design changes
  // or the active iframe element re-mounts.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Unsent bubble drafts, keyed by bubbleKey (edit:<id> | new:<selector>).
  // Lives across bubble remounts so switching to another chip / element and
  // coming back restores the text the user had typed. Cleared on successful
  // submit; explicit close (Esc / ×) deliberately preserves.
  const bubbleDraftsRef = useRef<Map<string, string>>(new Map());
  const iframesByDesign = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // Bumped every time the active iframe fires onLoad — used to re-trigger
  // the WATCH_SELECTORS effect so we don't race past overlay installation
  // on first mount.
  const [iframeLoadTick, setIframeLoadTick] = useState(0);

  const registerIframe = useCallback((designId: string, el: HTMLIFrameElement | null) => {
    if (el) {
      iframesByDesign.current.set(designId, el);
    } else {
      iframesByDesign.current.delete(designId);
    }
  }, []);

  const handleIframeLoaded = useCallback(
    (designId: string) => {
      if (designId === currentDesignId) setIframeLoadTick((t) => t + 1);
    },
    [currentDesignId],
  );

  // When the active design changes, retarget iframeRef and re-broadcast the
  // current interaction mode. Background iframes keep their last mode — fine,
  // they're inert until reactivated.
  useEffect(() => {
    if (currentDesignId === null) {
      iframeRef.current = null;
      return;
    }
    const el = iframesByDesign.current.get(currentDesignId) ?? null;
    iframeRef.current = el;
    if (el) {
      postModeToPreviewWindow(el.contentWindow, interactionMode, pushIframeError);
    }
    // New iframe / new design → liveRects from the old one are stale.
    clearLiveRects();
  }, [currentDesignId, interactionMode, pushIframeError, clearLiveRects]);

  // Tell the sandbox which selectors to track. The sandbox re-measures each
  // on scroll/resize and broadcasts ELEMENT_RECTS; we merge into liveRects.
  // Selectors: all comments on the current snapshot + the active bubble's
  // selector (usually the freshly-pinned one, included for the moment
  // between click and save).
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentDesignId and iframeLoadTick are deliberate triggers — iframeRef.current is a ref so biome can't see it swap when the active design changes, and we must wait for the iframe's onLoad before the overlay's message listener exists (otherwise the post is dropped).
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const selectors = new Set<string>();
    if (currentSnapshotId) {
      for (const c of comments) {
        if (c.snapshotId === currentSnapshotId) selectors.add(c.selector);
      }
    }
    if (commentBubble) selectors.add(commentBubble.selector);
    try {
      win.postMessage(
        { __codesign: true, type: 'WATCH_SELECTORS', selectors: Array.from(selectors) },
        '*',
      );
    } catch {
      /* sandbox gone — retry happens next render */
    }
  }, [comments, currentSnapshotId, commentBubble, currentDesignId, iframeLoadTick]);

  // Follow-the-edit cursor — push the agent's source-line range into the
  // iframe overlay whenever the editCursor slice updates. The overlay finds
  // the matching DOM element and broadcasts its rect under `EDIT_CURSOR_KEY`
  // via the existing ELEMENT_RECTS pipeline. We key the effect on
  // `editCursor.key` (bumped on every edit) so consecutive edits to the same
  // line range still trigger a refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editCursor?.key is the intentional re-trigger; iframeRef is a ref.
  useEffect(() => {
    if (!editCursor) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          __codesign: true,
          type: 'HIGHLIGHT_SRC_LINE',
          startLine: editCursor.startLine,
          endLine: editCursor.endLine,
        },
        '*',
      );
    } catch {
      /* sandbox gone — next edit posts again */
    }
  }, [editCursor?.key, currentDesignId, iframeLoadTick]);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      // Only accept messages from the ACTIVE iframe — background pool members
      // are inert from the user's POV and their messages would race with the
      // foreground design's state.
      if (!isTrustedPreviewMessageSource(event.source, iframeRef.current?.contentWindow)) return;

      const outcome = handlePreviewMessage(event.data, {
        onElementSelected: (msg) => {
          const scaled = scaleRectForZoom(msg.rect, previewZoom);
          selectCanvasElement({
            selector: msg.selector,
            tag: msg.tag,
            outerHTML: msg.outerHTML,
            rect: scaled,
          });
          openCommentBubble({
            selector: msg.selector,
            tag: msg.tag,
            outerHTML: msg.outerHTML,
            rect: scaled,
            ...(typeof msg.parentOuterHTML === 'string' && msg.parentOuterHTML.length > 0
              ? { parentOuterHTML: msg.parentOuterHTML }
              : {}),
          });
        },
        onIframeError: (msg) =>
          pushIframeError(formatIframeError(msg.kind, msg.message, msg.source, msg.lineno)),
        onElementRects: (msg) => {
          applyLiveRects(msg.entries);
        },
      });

      if (outcome.status === 'rejected' && outcome.reason === 'unknown-type') {
        console.warn('[PreviewPane] rejected iframe message type:', outcome.type);
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pushIframeError, selectCanvasElement, openCommentBubble, previewZoom, applyLiveRects]);

  // Pool entries: active design first (using the freshest in-memory
  // previewHtml), then any other recently-visited designs that still have a
  // cached preview. Store-side LRU bounds the size; we just render what's
  // handed to us.
  const poolEntries = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; html: string }> = [];
    if (currentDesignId !== null) {
      const html = previewHtml ?? previewHtmlByDesign[currentDesignId];
      if (typeof html === 'string' && html.length > 0) {
        out.push({ id: currentDesignId, html });
        seen.add(currentDesignId);
      }
    }
    for (const id of recentDesignIds) {
      if (seen.has(id)) continue;
      const html = previewHtmlByDesign[id];
      if (typeof html === 'string' && html.length > 0) {
        out.push({ id, html });
        seen.add(id);
      }
    }
    return out;
  }, [currentDesignId, previewHtml, previewHtmlByDesign, recentDesignIds]);

  const activeTab = canvasTabs[activeCanvasTab];
  const showCommentUi = interactionMode === 'comment';
  const currentArtifactType = useCodesignStore((s) => s.currentArtifactType);
  // motion-graphics-plan §0.2 — primary mode discriminator. We still
  // accept the legacy currentDesignEngine !== null fallback so designs
  // hydrated before currentArtifactType existed don't lose their game
  // chrome on the first render.
  const isGameMode = currentArtifactType === 'game' || currentDesignEngine !== null;
  const isMotionMode = currentArtifactType === 'motion';
  const activeProjectTab = useCodesignStore((s) => s.activeProjectTab);
  const activeMotionTab = useCodesignStore((s) => s.activeMotionTab);
  const gamePreviewMode = useCodesignStore((s) =>
    currentDesignId !== null
      ? (s.gamePreviewModeByDesign[currentDesignId] ?? DEFAULT_GAME_PREVIEW_MODE)
      : DEFAULT_GAME_PREVIEW_MODE,
  );
  const snapshotComments = currentSnapshotId
    ? comments.filter((c) => c.snapshotId === currentSnapshotId)
    : [];
  const pinOverlay = (
    <PinOverlay
      comments={snapshotComments}
      zoom={previewZoom}
      liveRects={liveRects}
      onPinClick={(c) => {
        const live = liveRects[c.selector] ?? c.rect;
        openCommentBubble({
          selector: c.selector,
          tag: c.tag,
          outerHTML: c.outerHTML,
          rect: scaleRectForZoom(live, previewZoom),
          existingCommentId: c.id,
          initialText: c.text,
        });
      }}
    />
  );

  const activeHasHtml =
    currentDesignId !== null && poolEntries.some((e) => e.id === currentDesignId);

  // When a design already has persisted content (thumbnail from a prior save,
  // or chat history), the preview IS coming — we're just waiting on the IPC
  // round-trip for the snapshot. Show a skeleton instead of the new-design
  // welcome screen so users don't read the transient state as "load failed".
  const currentDesign = currentDesignId ? designs.find((d) => d.id === currentDesignId) : undefined;
  const designHasContent =
    currentDesign !== undefined &&
    ((currentDesign.thumbnailText !== null && currentDesign.thumbnailText.length > 0) ||
      chatMessages.length > 0);

  let body: React.ReactNode;
  // Only take over the whole pane with ErrorState when there's nothing to
  // show yet. If the agent produced a preview before failing on the last
  // step (common with token-overflow / validation errors), keep the preview
  // visible — the user can still inspect and tweak what did generate.
  // A small dismissible error banner surfaces via CanvasErrorBar / toast.
  if (errorMessage && !previewHtml) {
    body = (
      <ErrorState
        message={errorMessage}
        onRetry={() => {
          void retry();
        }}
        onDismiss={clearError}
      />
    );
  } else if (isGameMode && activeProjectTab === 'sprites') {
    body = <SpritesTabView />;
  } else if (isGameMode && activeProjectTab === 'animations') {
    body = <AnimationsTabView />;
  } else if (isGameMode && activeProjectTab === 'levels') {
    body = <LevelsTabView />;
  } else if (isGameMode && activeProjectTab === 'world') {
    body = <WorldDesignerTabView />;
  } else if (isGameMode && activeProjectTab === 'files' && previewHtml) {
    body = <FilesTabView />;
  } else if (isMotionMode && activeMotionTab === 'compositions') {
    body = <MotionCompositionsView />;
  } else if (isMotionMode && activeMotionTab === 'files') {
    body = <FilesTabView />;
  } else if (isMotionMode && activeMotionTab === 'preview') {
    body = <MotionPreviewPane />;
  } else if (!isGameMode && !isMotionMode && activeTab?.kind === 'files' && previewHtml) {
    body = <FilesTabView />;
  } else {
    // Pool slots stay mounted even when the current design has no preview —
    // background iframes for recently-visited designs keep their documents
    // alive for instant switch-back. EmptyState is overlaid in the same
    // stacking context when the active design has no content yet.
    body = (
      <div className="relative h-full w-full">
        {poolEntries.map((entry) => (
          // Active slot's key includes previewReloadTick so the manual
          // refresh button (PreviewToolbar → bumpPreviewReload()) forces a
          // genuine unmount + remount — discarding any stuck iframe state
          // and re-parsing srcdoc fresh. Background pool slots keep their
          // stable keys so they stay alive for instant design-switch.
          <PreviewSlot
            key={entry.id === currentDesignId ? `${entry.id}::r${previewReloadTick}` : entry.id}
            designId={entry.id}
            html={entry.html}
            {...(() => {
              // Game-mode designs always go through the protocol when an
              // engine is selected. Design-mode designs only switch to
              // the protocol when the active design has > 1 file in
              // `design_files`. Background slots fall through to srcdoc
              // (cheaper, and they're invisible anyway).
              if (entry.id === currentDesignId && isGameMode) {
                const gameUrl = resolveGamePreviewSrc({
                  designId: entry.id,
                  engine: currentDesignEngine,
                  previewMode: gamePreviewMode,
                  godotPreviewByDesign,
                });
                if (gameUrl !== undefined) return { srcUrl: gameUrl };
              }
              const gameUrl = resolveGameSrc(entry.id, currentDesignEngine, godotPreviewByDesign);
              if (gameUrl !== undefined) return { srcUrl: gameUrl };
              if (entry.id === currentDesignId) {
                const designUrl = resolveDesignFilesSrc(
                  entry.id,
                  activeDesignFiles.multiFile,
                  previewReloadTick,
                );
                if (designUrl !== undefined) return { srcUrl: designUrl };
              }
              return {};
            })()}
            active={entry.id === currentDesignId}
            viewport={previewViewport}
            {...(currentDesignEngine !== null ? { gameAspect } : {})}
            zoom={previewZoom}
            showCommentUi={showCommentUi}
            commentHintLabel={t('preview.commentModeHint')}
            pinOverlay={pinOverlay}
            interactionMode={interactionMode}
            registerIframe={registerIframe}
            onIframeError={pushIframeError}
            onIframeLoaded={handleIframeLoaded}
          />
        ))}
        {!activeHasHtml ? (
          designHasContent ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-background)]">
              <div className="w-[60%] max-w-[720px] aspect-[4/3] rounded-[var(--radius-lg)] bg-[linear-gradient(110deg,var(--color-background-secondary)_0%,rgba(0,0,0,0.03)_40%,var(--color-background-secondary)_80%)] animate-pulse" />
            </div>
          ) : (
            <EmptyState onPickStarter={onPickStarter} />
          )
        ) : null}
      </div>
    );
  }

  const hasTabs = canvasTabs.length > 0;
  const isWelcome = !errorMessage && !previewHtml && !designHasContent;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex flex-col min-h-0 flex-1">
        {isWelcome ? null : isMotionMode ? (
          <>
            <div className="flex items-stretch justify-between gap-[var(--space-2)] border-b border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] pl-[var(--space-2)]">
              <MotionProjectTabs />
              <PreviewToolbar />
            </div>
            {activeMotionTab === 'files' && hasTabs ? <CanvasTabBar /> : null}
          </>
        ) : isGameMode ? (
          <>
            <div className="flex items-stretch justify-between gap-[var(--space-2)] border-b border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] pl-[var(--space-2)]">
              <GameProjectTabs />
              <PreviewToolbar />
            </div>
            {activeProjectTab === 'files' && hasTabs ? <CanvasTabBar /> : null}
          </>
        ) : (
          <div className="flex items-stretch justify-between gap-[var(--space-2)] border-b border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] pl-[var(--space-2)]">
            {hasTabs ? <CanvasTabBar /> : <div />}
            <PreviewToolbar />
          </div>
        )}
        <CanvasErrorBar />
        <div className="relative flex-1 overflow-hidden">
          {body}
          {previewHtml ? <TweakPanel iframeRef={iframeRef} /> : null}
          {/* D1 — pulsing accent ring overlay. Mounted with a fresh key on
           * each previewUpdatedAt so React re-creates the element and the
           * one-shot keyframe re-fires. pointer-events:none so it doesn't
           * steal interaction from the iframe. */}
          {editFlashKey > 0 ? (
            <div
              key={`edit-flash-${editFlashKey}`}
              className="pointer-events-none absolute inset-0 z-20 rounded-[var(--radius-md)]"
              style={{
                animation: 'codesign-iframe-edit-flash 1.4s ease-out 1 forwards',
              }}
              aria-hidden
            />
          ) : null}
          <PreviewUpdatedPill />
          {/* Follow-the-edit cursor — halo + tool pill that floats over the
           *  active iframe at the DOM element corresponding to the agent's
           *  most recent str_replace. Renders nothing when no edit is active. */}
          <EditCursorOverlay />
        </div>
        {commentBubble && interactionMode === 'comment'
          ? (() => {
              const liveForBubble = liveRects[commentBubble.selector];
              const scaled = liveForBubble
                ? scaleRectForZoom(liveForBubble, previewZoom)
                : commentBubble.rect;
              const existingId = commentBubble.existingCommentId;
              // Keying by comment id (when editing) rather than selector alone
              // means two comments on the same element each get their own draft
              // state and don't stomp each other on reopen.
              const bubbleKey = existingId ? `edit:${existingId}` : `new:${commentBubble.selector}`;
              // Draft precedence: prior unsent draft for this anchor > DB text
              // on a reopened chip > empty. This preserves mid-typing context
              // when the user clicks another chip and comes back.
              const stashed = bubbleDraftsRef.current.get(bubbleKey);
              const initialText = stashed ?? commentBubble.initialText;
              return (
                <CommentBubble
                  key={bubbleKey}
                  selector={commentBubble.selector}
                  tag={commentBubble.tag}
                  outerHTML={commentBubble.outerHTML}
                  rect={scaled}
                  {...(initialText !== undefined ? { initialText } : {})}
                  onDraftChange={(text) => {
                    if (text.length === 0) bubbleDraftsRef.current.delete(bubbleKey);
                    else bubbleDraftsRef.current.set(bubbleKey, text);
                  }}
                  onClose={() => {
                    const win = iframeRef.current?.contentWindow;
                    if (win) {
                      try {
                        win.postMessage({ __codesign: true, type: 'CLEAR_PIN' }, '*');
                      } catch {
                        /* noop */
                      }
                    }
                    closeCommentBubble();
                  }}
                  onSendToClaude={async (text: string) => {
                    const row = await submitComment({
                      kind: 'edit',
                      selector: commentBubble.selector,
                      tag: commentBubble.tag,
                      outerHTML: commentBubble.outerHTML,
                      rect: commentBubble.rect,
                      text,
                      scope: 'element',
                      ...(existingId ? { existingCommentId: existingId } : {}),
                      ...(commentBubble.parentOuterHTML
                        ? { parentOuterHTML: commentBubble.parentOuterHTML }
                        : {}),
                    });
                    // On failure (no snapshot, IPC error, duplicate) keep the
                    // bubble open so the user's draft survives. A toast has
                    // already been surfaced by the store layer.
                    if (!row) return;
                    // Persisted — wipe the stashed draft so the next open
                    // starts clean (a reopened chip re-reads from DB).
                    bubbleDraftsRef.current.delete(bubbleKey);
                    const win = iframeRef.current?.contentWindow;
                    if (win) {
                      try {
                        win.postMessage({ __codesign: true, type: 'CLEAR_PIN' }, '*');
                      } catch {
                        /* noop */
                      }
                    }
                    closeCommentBubble();
                    // Stage only — user clicks the "Apply" button on the chip bar
                    // to send all accumulated edits in one go.
                  }}
                />
              );
            })()
          : null}
      </div>
    </div>
  );
}
