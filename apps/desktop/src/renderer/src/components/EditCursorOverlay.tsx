import { EDIT_CURSOR_KEY } from '@open-codesign/runtime/overlay';
import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCodesignStore } from '../store';

/**
 * Follow-the-edit cursor overlay — a halo + tool-name pill that floats over
 * the live preview at the DOM element corresponding to the agent's most
 * recent str_replace / insert. Updated by the iframe overlay's
 * `__edit_cursor__` rect broadcast (see `packages/runtime/src/overlay.ts`)
 * and the renderer's `editCursor` store slice (see `store.ts`).
 *
 * Visual: 32px ring + small pill, glides with `transition: top/left 280ms`.
 * Pure Tailwind, no SVG / framer-motion. `pointer-events: none` so it never
 * blocks the iframe.
 */
export function EditCursorOverlay() {
  const editCursor = useCodesignStore((s) => s.editCursor);
  const liveRects = useCodesignStore((s) => s.liveRects);
  const previewZoom = useCodesignStore((s) => s.previewZoom);
  const clearEditCursor = useCodesignStore((s) => s.clearEditCursor);

  // Auto-clear the slice when the visible window expires. Without this the
  // halo would stay visible if the run stalled (no further edits arriving)
  // and the user would have no way to dismiss it.
  useEffect(() => {
    if (!editCursor) return;
    const remaining = editCursor.expiresAt - performance.now();
    if (remaining <= 0) {
      clearEditCursor();
      return;
    }
    const timer = setTimeout(clearEditCursor, remaining);
    return () => clearTimeout(timer);
  }, [editCursor, clearEditCursor]);

  // 1Hz tick so the expiresAt check above re-evaluates even when no new
  // edit lands. Cheap.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editCursor) return;
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 250);
    return () => clearInterval(id);
  }, [editCursor]);

  if (!editCursor) return null;
  const rect = liveRects[EDIT_CURSOR_KEY];
  if (!rect) return null;

  // Same zoom-scale pattern CommentChipBar uses (see chat/CommentChipBar.tsx).
  // Iframe rects are in iframe viewport coords; the renderer applies
  // previewZoom to land them in the parent's coord system.
  const scale = previewZoom / 100;
  const top = rect.top * scale;
  const left = rect.left * scale;
  const width = Math.max(rect.width * scale, 24);
  const height = Math.max(rect.height * scale, 24);

  // Center the 32px halo on the element's center; if the element is bigger,
  // scale the halo to roughly match (capped) so we hug the target.
  const haloSize = Math.min(Math.max(Math.min(width, height) * 0.4, 24), 64);
  const haloTop = top + height / 2 - haloSize / 2;
  const haloLeft = left + width / 2 - haloSize / 2;

  return (
    <div
      key={editCursor.key}
      className="pointer-events-none absolute z-30"
      style={{
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }}
      aria-hidden
    >
      {/* Halo — center on element, glide via CSS transition on top/left */}
      <div
        className="absolute rounded-full border-2 border-[var(--color-accent)] bg-[var(--color-accent)]/15 shadow-[0_0_0_4px_rgba(201,100,66,0.18)] animate-pulse"
        style={{
          top: haloTop,
          left: haloLeft,
          width: haloSize,
          height: haloSize,
          transition:
            'top 280ms cubic-bezier(.4,0,.2,1), left 280ms cubic-bezier(.4,0,.2,1), width 280ms cubic-bezier(.4,0,.2,1), height 280ms cubic-bezier(.4,0,.2,1)',
        }}
      />
      {/* Tool-label pill anchored to the top-right of the halo */}
      <div
        className="absolute flex items-center gap-[var(--space-1)] rounded-full bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-[var(--space-2)] py-[2px] text-[var(--text-2xs)] font-medium text-[var(--color-text-primary)] shadow-sm whitespace-nowrap"
        style={{
          top: haloTop - 18,
          left: haloLeft + haloSize + 6,
          transition: 'top 280ms cubic-bezier(.4,0,.2,1), left 280ms cubic-bezier(.4,0,.2,1)',
        }}
      >
        <Pencil className="h-[10px] w-[10px] text-[var(--color-accent)]" aria-hidden />
        <span>{editCursor.toolLabel}</span>
      </div>
    </div>
  );
}
