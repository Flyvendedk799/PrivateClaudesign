import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCodesignStore } from '../../store';

/**
 * v8 — banner shown above the per-tab content when the live game artifact
 * has changed since the last successful Decompose run, or while a fresh
 * run is in progress. Lives in the four game-mode tab views (Sprites,
 * Animations, Levels, World) so the user has an immediate signal that
 * the tab contents are about to refresh and aren't stuck.
 *
 * States:
 *   running → "Updating <tab> from new game changes…" (spinner)
 *   stale   → "Game changed since last decompose — extracting now…"
 *             (rendered briefly between the change event and the
 *             tryAutoDecompose pipeline kicking off; if auto is OFF
 *             the banner persists with a manual trigger CTA)
 *   fresh   → null (no banner)
 *   never   → null (the tab's own empty state already explains
 *             "Run Decompose to populate this tab")
 *
 * Hash compare is async via Web Crypto, so we keep the result in
 * component state and recompute when previewHtml or the persisted hash
 * change. A pre-existing decomposeFlow takes precedence over hash drift
 * for the running label.
 */
export function DecomposeFreshnessBanner({
  tabLabel,
}: {
  /** "sprites" / "animations" / "levels" / "world graph" — interpolated
   *  into the running-state label so the banner reads naturally on each
   *  tab without four separate components. */
  tabLabel: string;
}) {
  const designId = useCodesignStore((s) => s.currentDesignId);
  const previewHtml = useCodesignStore((s) => s.previewHtml);
  const lastHash = useCodesignStore((s) =>
    designId !== null ? (s.lastDecomposedHashByDesign[designId] ?? null) : null,
  );
  const flow = useCodesignStore((s) => s.decomposeFlow);
  const tryAutoDecompose = useCodesignStore((s) => s.tryAutoDecompose);

  const [staleDetected, setStaleDetected] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    if (designId === null || typeof previewHtml !== 'string' || previewHtml.length === 0) {
      setStaleDetected(false);
      return;
    }
    void (async () => {
      // Hash the live artifact and compare to the persisted hash. We
      // could centralise this in a derived selector, but useEffect keeps
      // the async work out of the render cycle and the render-cheap
      // "fresh" no-op in the common case.
      const bytes = new TextEncoder().encode(previewHtml);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      if (cancelled) return;
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      const stale = lastHash !== null && hex !== lastHash;
      setStaleDetected(stale);
    })();
    return () => {
      cancelled = true;
    };
  }, [designId, previewHtml, lastHash]);

  const isRunning = flow !== null && flow.designId === designId && flow.overallStatus === 'running';
  if (!isRunning && !staleDetected) return null;

  const description = isRunning
    ? `Updating ${tabLabel} from your latest changes…`
    : `Game changed since last decompose — extracting ${tabLabel} now…`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-[var(--space-3)] mt-[var(--space-3)] flex items-center gap-[var(--space-2)] rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-3)] py-[var(--space-2)]"
    >
      {isRunning ? (
        <Loader2
          className="h-3.5 w-3.5 codesign-spin-once text-[var(--color-accent)]"
          aria-hidden="true"
        />
      ) : (
        <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
      )}
      <p className="flex-1 text-[11px] text-[var(--color-text-secondary)]">{description}</p>
      {!isRunning && designId !== null ? (
        <button
          type="button"
          onClick={() => void tryAutoDecompose(designId)}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] px-[var(--space-2)] py-[2px] text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          Run now
        </button>
      ) : null}
    </div>
  );
}
