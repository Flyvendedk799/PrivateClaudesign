import { useT } from '@open-codesign/i18n';
import { Tooltip } from '@open-codesign/ui';
import { ArrowUp, Flag, Square } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { formatUsd, projectCostUsd, resolvePricing } from '../../lib/model-pricing';
import { useCodesignStore } from '../../store';

const MAX_TEXTAREA_ROWS = 6;

export function getTextareaLineHeight(el: HTMLTextAreaElement): number {
  const styles = getComputedStyle(el);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(styles.fontSize);
  const leading = Number.parseFloat(styles.getPropertyValue('--leading-body'));
  if (!Number.isFinite(fontSize) || fontSize <= 0 || !Number.isFinite(leading) || leading <= 0) {
    throw new Error('Textarea sizing tokens (--leading-body / fontSize) are missing or invalid');
  }
  return fontSize * leading;
}

function resizeTextarea(el: HTMLTextAreaElement): void {
  const rowHeight = getTextareaLineHeight(el);
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, rowHeight * MAX_TEXTAREA_ROWS)}px`;
}

export interface PromptInputProps {
  prompt: string;
  setPrompt: (value: string) => void;
  onSubmit: () => void;
  /** Cancel handler. `asCheckpoint=true` (Backlog-3 §5) writes a
   *  checkpoint chat row before tearing down the run so the user can
   *  resume from the same point. Triggered via shift-click on Stop. */
  onCancel: (asCheckpoint?: boolean) => void;
  /** Optional "Wrap up now" handler — when provided AND isGenerating,
   *  renders a flag-style button next to the Stop button that pushes a
   *  user-override steering message into the agent's queue, asking it
   *  to converge to `done` immediately without further section/polish
   *  expansion. Distinct from cancel: doesn't drop in-progress work. */
  onWrapUp?: () => void;
  isGenerating: boolean;
  /** Optional content rendered above the textarea, inside the composer card. */
  contextSummary?: ReactNode;
  /** Optional element rendered inside the textarea container, bottom-left. */
  leadingAction?: ReactNode;
}

export interface PromptInputHandle {
  focus: () => void;
}

/**
 * Prompt textarea + send/stop button. Extracted from Sidebar.tsx so the
 * chat pane can be rewritten without disturbing the send-path keybindings.
 *
 * Keybindings:
 *   Enter           — submit (unless Shift/Meta/Ctrl held)
 *   Meta/Ctrl+Enter — submit (power-user muscle memory)
 *   Shift+Enter     — newline
 */
export const PromptInput = forwardRef<PromptInputHandle, PromptInputProps>(function PromptInput(
  { prompt, setPrompt, onSubmit, onCancel, onWrapUp, isGenerating, contextSummary, leadingAction },
  ref,
) {
  const t = useT();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const generationStage = useCodesignStore((s) => s.generationStage);

  const runningLabel = isGenerating
    ? (() => {
        switch (generationStage) {
          case 'sending':
            return t('loading.stage.sending');
          case 'thinking':
            return t('loading.stage.thinking');
          case 'streaming':
            return t('loading.stage.streaming');
          case 'parsing':
            return t('loading.stage.parsing');
          case 'rendering':
            return t('loading.stage.rendering');
          default:
            return t('loading.stage.thinking');
        }
      })()
    : null;

  // Elapsed timer — reassures users that long agent runs are still alive.
  // Only ticks while isGenerating; resets to 0 on each new run.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isGenerating) {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    setElapsedSec(0);
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [isGenerating]);

  const elapsedText =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`;

  useEffect(() => {
    if (taRef.current) resizeTextarea(taRef.current);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      taRef.current?.focus();
    },
  }));

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!prompt.trim() || isGenerating) return;
    onSubmit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const isSendCombo =
      (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) ||
      (e.key === 'Enter' && (e.metaKey || e.ctrlKey));
    if (isSendCombo) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  const canSend = prompt.trim().length > 0 && !isGenerating;
  const sendDisabledReason = isGenerating
    ? t('disabledReason.generatingInProgress')
    : t('disabledReason.typePromptToSend');
  // Backlog-3 §10 — pre-flight cost projection. Computed only when
  // composing (not while generating) and only when the prompt has
  // weight; updates as the user types.
  const cfg = useCodesignStore((s) => s.config);
  const sendTooltipText = (() => {
    if (!canSend) return sendDisabledReason;
    if (prompt.trim().length < 20) return undefined;
    const pricing = resolvePricing(cfg?.provider ?? null, cfg?.modelPrimary ?? null);
    const projection = projectCostUsd({
      promptLen: prompt.length,
      historyMessages: 0,
      attachmentBytes: 0,
      pricing,
    });
    if (projection.high < 0.0001) return undefined;
    return `Send · estimated cost ${formatUsd(projection.low)}–${formatUsd(projection.high)}`;
  })();

  return (
    <form onSubmit={handleSubmit}>
      <div className="relative rounded-[16px] bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border-muted)] focus-within:border-[var(--color-accent)] transition-colors duration-150 ease-out">
        {contextSummary ? (
          <div className="border-b border-[var(--color-border-subtle)] px-[12px] py-[10px]">
            {contextSummary}
          </div>
        ) : null}
        <textarea
          ref={taRef}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            resizeTextarea(e.currentTarget);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.placeholderRich')}
          rows={1}
          className="codesign-prompt-textarea block w-full resize-none appearance-none border-0 bg-transparent px-[14px] pt-[12px] pb-[44px] text-[14px] leading-[1.55] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] shadow-none outline-none focus:outline-none focus:ring-0 min-h-[24px] overflow-y-auto"
          style={{ fontFamily: 'var(--font-sans)' }}
        />

        {leadingAction ? (
          <div className="absolute bottom-[8px] left-[8px]">{leadingAction}</div>
        ) : null}

        {/* Send / Stop / Wrap-up — bottom right cluster */}
        <div className="absolute bottom-[8px] right-[8px] flex items-center gap-[6px]">
          {isGenerating && onWrapUp ? (
            <Tooltip
              label="Wrap up now — agent converges to `done` at the next safe boundary, no in-progress work lost"
              side="top"
            >
              <button
                type="button"
                onClick={onWrapUp}
                aria-label="Wrap up now"
                className="inline-flex items-center justify-center w-[28px] h-[28px] rounded-full bg-[var(--color-surface)] border border-[var(--color-border-muted)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] active:scale-[0.92] transition-all duration-150"
              >
                <Flag className="w-[12px] h-[12px]" strokeWidth={2} />
              </button>
            </Tooltip>
          ) : null}
          {isGenerating ? (
            <Tooltip
              label="Stop. Shift-click to save a checkpoint so you can resume from this point later."
              side="top"
            >
              <button
                type="button"
                onClick={(e) => onCancel(e.shiftKey === true)}
                aria-label={t('chat.stop')}
                className="relative inline-flex items-center justify-center w-[32px] h-[32px] rounded-full bg-[var(--color-accent)] text-white shadow-[0_2px_6px_color-mix(in_srgb,var(--color-accent)_35%,transparent)] hover:bg-[var(--color-accent-hover)] active:scale-[0.92] transition-all duration-150"
              >
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-[var(--color-accent)] opacity-40 animate-ping"
                />
                <Square
                  className="relative w-[10px] h-[10px]"
                  strokeWidth={0}
                  fill="currentColor"
                />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label={sendTooltipText} side="top">
              <button
                type="submit"
                disabled={!canSend}
                aria-label={t('chat.send')}
                className="inline-flex items-center justify-center w-[32px] h-[32px] rounded-full bg-[var(--color-accent)] text-white shadow-[0_2px_6px_color-mix(in_srgb,var(--color-accent)_30%,transparent)] hover:bg-[var(--color-accent-hover)] hover:shadow-[0_3px_10px_color-mix(in_srgb,var(--color-accent)_40%,transparent)] active:scale-[0.92] disabled:opacity-25 disabled:shadow-none disabled:cursor-not-allowed transition-all duration-150"
              >
                <ArrowUp className="w-[16px] h-[16px]" strokeWidth={2.5} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {runningLabel ? (
        <div
          aria-live="polite"
          className="mt-[var(--space-2)] flex items-center justify-between gap-[var(--space-2)] px-[var(--space-1)]"
        >
          <div className="inline-flex items-center gap-[var(--space-1_5)] rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-[var(--space-2)] py-[3px] text-[11px] text-[var(--color-text-secondary)] shadow-[var(--shadow-soft)]">
            <span aria-hidden className="relative inline-flex h-[6px] w-[6px] shrink-0">
              <span className="absolute inset-0 rounded-full bg-[var(--color-accent)] opacity-45 animate-ping" />
              <span className="relative inline-block h-full w-full rounded-full bg-[var(--color-accent)]" />
            </span>
            <span className="whitespace-nowrap">{runningLabel}</span>
          </div>
          <span
            className="text-[11px] text-[var(--color-text-muted)]"
            style={{ fontFamily: 'var(--font-mono)', fontFeatureSettings: "'tnum'" }}
          >
            {elapsedText}
          </span>
        </div>
      ) : null}
    </form>
  );
});
