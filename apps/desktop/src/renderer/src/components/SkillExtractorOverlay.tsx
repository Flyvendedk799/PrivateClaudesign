/**
 * Region-capture overlay for the Skills authoring flow (backlog-2 #7).
 *
 * Renders a fixed-position overlay above the workspace iframe when
 * `interactionMode === 'skill-extract'`. The user drags to draw a
 * rectangle; on pointer-up, a small modal asks "what is this?", and
 * on submit calls the `skills:v1:extract-from-design` IPC. The
 * extractor persists a new user_skills row that the agent can pick up
 * via list_design_skills on the next generation.
 *
 * Capturing pointer events on a sibling div above the iframe sidesteps
 * the iframe sandbox protocol entirely — no postMessage, no click-to-
 * pick choreography. Coordinates are page-relative px (matching the
 * existing CommentRect convention) computed against the bounding rect
 * of the previewer container.
 */

import { useT } from '@open-codesign/i18n';
import type { CommentRect } from '@open-codesign/shared';
import { X } from 'lucide-react';
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useCodesignStore } from '../store';

const MIN_RECT_PX = 20;

export function SkillExtractorOverlay() {
  const t = useT();
  const interactionMode = useCodesignStore((s) => s.interactionMode);
  const draft = useCodesignStore((s) => s.skillExtractDraft);
  const setRect = useCodesignStore((s) => s.setSkillExtractRect);
  const submit = useCodesignStore((s) => s.submitSkillExtract);
  const cancel = useCodesignStore((s) => s.cancelSkillExtract);
  const pushToast = useCodesignStore((s) => s.pushToast);

  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset on every fresh entry into skill-extract mode.
  useEffect(() => {
    if (interactionMode === 'skill-extract' && draft === null) {
      setDrag(null);
      setPrompt('');
      setError(null);
    }
  }, [interactionMode, draft]);

  // Esc cancels at any phase; Cmd/Ctrl+Enter submits when the form is up.
  useEffect(() => {
    if (interactionMode !== 'skill-extract') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactionMode, cancel]);

  if (interactionMode !== 'skill-extract') return null;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draft !== null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDrag({ x0: x, y0: y, x1: x, y1: y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDrag({ ...drag, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const r = normalizeRect(drag);
    setDrag(null);
    if (r.width < MIN_RECT_PX || r.height < MIN_RECT_PX) {
      // Tap, not drag — quietly reset; keep mode active for another try.
      return;
    }
    setRect(r);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (draft === null) return;
    if (prompt.trim().length === 0) {
      setError(t('skills.extractor.promptRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const skill = await submit(prompt.trim());
      pushToast({
        variant: 'success',
        title: t('skills.extractor.savedTitle', { name: skill.name }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const previewRect = drag === null ? null : normalizeRect(drag);

  return (
    <div className="fixed inset-0 z-40 pointer-events-none">
      {/* Drag-capture surface — only catches pointer events when no
          draft is pending so the prompt-input modal stays interactive. */}
      <div
        ref={ref}
        role="presentation"
        aria-label={t('skills.extractor.overlayLabel')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`absolute inset-0 ${
          draft === null ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'
        } bg-[var(--color-overlay)] opacity-30`}
      />

      {previewRect !== null ? (
        <div
          className="absolute pointer-events-none border-2 border-[var(--color-accent)] bg-[var(--color-accent)] opacity-30"
          style={{
            left: previewRect.left,
            top: previewRect.top,
            width: previewRect.width,
            height: previewRect.height,
          }}
        />
      ) : null}

      {draft === null ? (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto rounded-[var(--radius-md)] bg-[var(--color-background)] border border-[var(--color-border)] shadow-[var(--shadow-elevated)] px-3 py-2 flex items-center gap-3">
          <span className="text-[var(--text-sm)] text-[var(--color-text-primary)]">
            {t('skills.extractor.hint')}
          </span>
          <button
            type="button"
            onClick={cancel}
            aria-label={t('common.cancel')}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <form
          onSubmit={onSubmit}
          className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto rounded-[var(--radius-lg)] bg-[var(--color-background)] border border-[var(--color-border)] shadow-[var(--shadow-elevated)] p-3 space-y-2 w-[420px] max-w-[90vw]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onSubmit(e as unknown as FormEvent);
            }
          }}
        >
          <header className="flex items-start justify-between gap-2">
            <div className="space-y-0.5">
              <h3 className="text-[var(--text-sm)] font-medium text-[var(--color-text-primary)] m-0">
                {t('skills.extractor.title')}
              </h3>
              <p className="text-[var(--text-xs)] text-[var(--color-text-muted)] tabular-nums">
                {Math.round(draft.rect.width)} × {Math.round(draft.rect.height)} px
              </p>
            </div>
            <button
              type="button"
              onClick={cancel}
              aria-label={t('common.cancel')}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </header>
          <input
            type="text"
            // biome-ignore lint/a11y/noAutofocus: deliberate — modal opens on user pointer-up so focusing the lone input is the obvious next step.
            autoFocus
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('skills.extractor.placeholder')}
            className="block w-full h-9 px-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--text-sm)] text-[var(--color-text-primary)]"
          />
          {error ? (
            <p className="text-[var(--text-xs)] text-[var(--color-error)]">{error}</p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              className="h-9 px-3 rounded-[var(--radius-md)] text-[var(--text-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="h-9 px-3 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-on-accent)] text-[var(--text-sm)] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {submitting ? t('skills.extractor.extracting') : t('skills.extractor.extract')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function normalizeRect(d: { x0: number; y0: number; x1: number; y1: number }): CommentRect {
  const left = Math.min(d.x0, d.x1);
  const top = Math.min(d.y0, d.y1);
  const right = Math.max(d.x0, d.x1);
  const bottom = Math.max(d.y0, d.y1);
  return { left, top, width: right - left, height: bottom - top };
}
