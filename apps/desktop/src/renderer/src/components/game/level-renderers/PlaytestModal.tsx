import type { LevelDoc } from '@open-codesign/shared';
import { Activity, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCodesignStore } from '../../../store';
import { SANDBOX_GODOT_WEB } from '../../sandbox-tokens';

/**
 * level-and-world-designer §Phase 8.8 — thin-slice "Playtest level"
 * surface.
 *
 * Mounts a sandboxed iframe containing the design's `previewHtml`
 * with the *level* injected as a global `window.__OPEN_CODESIGN_LEVEL`
 * before the rest of the script runs. Games that opt in (by reading
 * that global) get one-click "play this specific level" without the
 * agent having to wire a level-loader UI into the in-game shell.
 *
 * Observations: a tiny inline script in the iframe relays
 * `console.error`, uncaught exceptions, and explicit
 * `window.parent.postMessage({ type: 'playtest:event', ... })` events
 * back to the host. We surface the last 50 in a side panel so the
 * agent (in a follow-up brief) has signal about what broke.
 *
 * Deeper sandboxing — automated input-replay, deterministic seed,
 * frame-by-frame screenshot capture, perf metrics — deferred to a
 * post-v1 follow-up. This thin slice exists so the empty-handed
 * "Playtest" button is no longer a TODO.
 */
export function PlaytestModal({
  doc,
  slug,
  onClose,
}: {
  doc: LevelDoc;
  slug: string;
  onClose: () => void;
}) {
  const previewHtml = useCodesignStore((s) => s.previewHtml);
  const [observations, setObservations] = useState<
    Array<{ id: string; ts: number; level: 'info' | 'warn' | 'error'; message: string }>
  >([]);
  const observationsRef = useRef(observations);
  observationsRef.current = observations;

  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (typeof e.data !== 'object' || e.data === null) return;
      const msg = e.data as { type?: unknown; level?: unknown; message?: unknown };
      if (msg.type !== 'playtest:event') return;
      const level: 'info' | 'warn' | 'error' =
        msg.level === 'error' || msg.level === 'warn' ? msg.level : 'info';
      const message = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg);
      setObservations((prev) => {
        const next = [
          ...prev,
          {
            id: `obs-${prev.length}-${Date.now().toString(36)}`,
            ts: Date.now(),
            level,
            message: message.slice(0, 500),
          },
        ];
        return next.slice(-50);
      });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Inject the level data + observation relay into the previewHtml.
  // We splice a <script> tag into <head> rather than rewriting the
  // whole document — minimal blast radius, easy to opt out of.
  const injected = useMemo(() => {
    if (previewHtml === null) return null;
    const levelLiteral = JSON.stringify(doc);
    const inject = `<script>(function(){
      window.__OPEN_CODESIGN_LEVEL = ${levelLiteral};
      var origErr = console.error;
      console.error = function(){
        try { window.parent.postMessage({ type: 'playtest:event', level: 'error', message: Array.from(arguments).map(String).join(' ') }, '*'); } catch (e) {}
        return origErr.apply(this, arguments);
      };
      var origWarn = console.warn;
      console.warn = function(){
        try { window.parent.postMessage({ type: 'playtest:event', level: 'warn', message: Array.from(arguments).map(String).join(' ') }, '*'); } catch (e) {}
        return origWarn.apply(this, arguments);
      };
      window.addEventListener('error', function(e){
        try { window.parent.postMessage({ type: 'playtest:event', level: 'error', message: 'Uncaught: ' + (e.message || e.error) }, '*'); } catch (e2) {}
      });
      window.addEventListener('unhandledrejection', function(e){
        try { window.parent.postMessage({ type: 'playtest:event', level: 'error', message: 'Unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)) }, '*'); } catch (e2) {}
      });
    })();</script>`;
    if (previewHtml.includes('</head>')) {
      return previewHtml.replace('</head>', `${inject}</head>`);
    }
    // No <head> — splice at the start of <body> so the relay still loads.
    if (previewHtml.includes('<body>')) {
      return previewHtml.replace('<body>', `<body>${inject}`);
    }
    // Fallback: prepend.
    return `${inject}${previewHtml}`;
  }, [previewHtml, doc]);

  if (previewHtml === null) {
    return (
      <Modal onClose={onClose} title={`Playtest · ${slug}`}>
        <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">
          No preview HTML loaded for this design yet.
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title={`Playtest · ${slug}`}>
      <div className="flex flex-1 gap-[var(--space-2)] overflow-hidden">
        <div className="relative flex-1 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)]">
          <iframe
            srcDoc={injected ?? previewHtml}
            title={`Playtest ${slug}`}
            sandbox={SANDBOX_GODOT_WEB}
            className="h-full w-full border-0"
          />
        </div>
        <div className="flex w-[280px] flex-col rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)]">
          <div className="flex items-center gap-[var(--space-1)] border-b border-[var(--color-border-muted)] p-[var(--space-2)] text-[11px] text-[var(--color-text-muted)]">
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Observations · {observations.length}</span>
          </div>
          <ul className="flex-1 overflow-y-auto p-[var(--space-2)]">
            {observations.length === 0 ? (
              <li className="text-[10px] text-[var(--color-text-muted)]">
                Errors, warnings, and `playtest:event` postMessages will appear here.
              </li>
            ) : (
              observations.map((obs) => (
                <li
                  key={obs.id}
                  className={`rounded-[var(--radius-sm)] px-[var(--space-1)] py-[2px] text-[10px] ${
                    obs.level === 'error'
                      ? 'text-red-400'
                      : obs.level === 'warn'
                        ? 'text-amber-400'
                        : 'text-[var(--color-text-secondary)]'
                  }`}
                >
                  {obs.message}
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Close on escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-[var(--space-3)]"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className="flex h-[80%] max-h-[720px] w-[90%] max-w-[1280px] flex-col rounded-[var(--radius-md)] border border-[var(--color-border-muted)] bg-[var(--color-background)] p-[var(--space-3)] shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-[var(--space-2)] flex items-center justify-between">
          <h3 className="text-[14px] font-medium text-[var(--color-text-primary)]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close playtest"
            className="rounded-[var(--radius-sm)] p-[var(--space-1)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
