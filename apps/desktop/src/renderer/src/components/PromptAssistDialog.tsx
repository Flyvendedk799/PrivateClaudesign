import { useT } from '@open-codesign/i18n';
import type { PromptAssistMetadata } from '@open-codesign/shared';
import { Check } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useCodesignStore } from '../store';

type Picks = Omit<PromptAssistMetadata, 'schemaVersion'>;

interface ChipRow<K extends keyof Picks> {
  key: K;
  label: string;
  options: Array<{ value: NonNullable<Picks[K]>; label: string }>;
}

/** Auto-skip the dialog after this many ms of inactivity. Lets the user keep
 *  flow when a short prompt is genuinely intentional ("just iterate"). The
 *  countdown is paused on any chip click. */
const AUTO_SKIP_MS = 5_000;

export function PromptAssistDialog(): ReactElement | null {
  const t = useT();
  const pending = useCodesignStore((s) => s.promptAssistPending);
  const resolve = useCodesignStore((s) => s.resolvePromptAssist);
  const cancel = useCodesignStore((s) => s.cancelPromptAssist);

  const [picks, setPicks] = useState<Picks>({});
  const [autoSkipPaused, setAutoSkipPaused] = useState(false);
  const [countdown, setCountdown] = useState<number>(AUTO_SKIP_MS / 1_000);

  const rows = useMemo<
    [ChipRow<'audience'>, ChipRow<'device'>, ChipRow<'depth'>, ChipRow<'vibe'>, ChipRow<'a11y'>]
  >(
    () => [
      {
        key: 'audience',
        label: t('promptAssist.rows.audience'),
        options: [
          { value: 'devs', label: t('promptAssist.audience.devs') },
          { value: 'pms', label: t('promptAssist.audience.pms') },
          { value: 'end-users', label: t('promptAssist.audience.endUsers') },
          { value: 'designers', label: t('promptAssist.audience.designers') },
        ],
      },
      {
        key: 'device',
        label: t('promptAssist.rows.device'),
        options: [
          { value: 'desktop', label: t('promptAssist.device.desktop') },
          { value: 'tablet', label: t('promptAssist.device.tablet') },
          { value: 'mobile', label: t('promptAssist.device.mobile') },
        ],
      },
      {
        key: 'depth',
        label: t('promptAssist.rows.depth'),
        options: [
          { value: 'quick', label: t('promptAssist.depth.quick') },
          { value: 'standard', label: t('promptAssist.depth.standard') },
          { value: 'deep', label: t('promptAssist.depth.deep') },
        ],
      },
      {
        key: 'vibe',
        label: t('promptAssist.rows.vibe'),
        options: [
          { value: 'calm', label: t('promptAssist.vibe.calm') },
          { value: 'energetic', label: t('promptAssist.vibe.energetic') },
          { value: 'editorial', label: t('promptAssist.vibe.editorial') },
          { value: 'minimal', label: t('promptAssist.vibe.minimal') },
        ],
      },
      {
        key: 'a11y',
        label: t('promptAssist.rows.a11y'),
        options: [
          { value: 'baseline', label: t('promptAssist.a11y.baseline') },
          { value: 'enhanced', label: t('promptAssist.a11y.enhanced') },
        ],
      },
    ],
    [t],
  );

  // Reset state when the dialog re-opens for a new pending submission.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pending identity is the trigger; depending on its full structure would reset on benign re-renders
  useEffect(() => {
    if (pending !== null) {
      setPicks({});
      setAutoSkipPaused(false);
      setCountdown(AUTO_SKIP_MS / 1_000);
    }
  }, [pending?.designId, pending?.input.prompt]);

  const skip = useCallback(() => {
    void resolve(null);
  }, [resolve]);

  // 1-second countdown ticker for the visible "Skip in N…" hint and the
  // auto-skip itself. Paused once the user touches any chip.
  useEffect(() => {
    if (pending === null || autoSkipPaused) return;
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          skip();
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);
    return () => clearInterval(interval);
  }, [pending, autoSkipPaused, skip]);

  if (pending === null) return null;

  const setPick = <K extends keyof Picks>(key: K, value: NonNullable<Picks[K]>): void => {
    setAutoSkipPaused(true);
    setPicks((cur) => {
      const next = { ...cur };
      if (cur[key] === value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const submit = (): void => {
    const hasAny = Object.values(picks).some((v) => v !== undefined && v !== null && v !== '');
    if (!hasAny) {
      // No picks → equivalent to skip. Avoids writing an empty metadata
      // object that would still satisfy the "design has metadata" guard
      // and stop us from re-prompting on the next short submission.
      void resolve(null);
      return;
    }
    void resolve({ schemaVersion: 1, ...picks });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('promptAssist.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-[overlay-in_120ms_ease-out]"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      <div
        role="document"
        className="w-full max-w-md rounded-[var(--radius-2xl)] bg-[var(--color-background)] border border-[var(--color-border)] shadow-[var(--shadow-elevated)] p-5 space-y-4 animate-[panel-in_160ms_ease-out]"
      >
        <header className="space-y-1">
          <h3 className="text-[var(--text-md)] font-medium text-[var(--color-text-primary)]">
            {t('promptAssist.title')}
          </h3>
          <p className="text-[var(--text-xs)] text-[var(--color-text-secondary)] leading-[var(--leading-body)]">
            {t('promptAssist.body')}
          </p>
        </header>

        <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {rows.map((row) => (
            <fieldset key={row.key} className="space-y-1.5">
              <legend className="text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)] uppercase tracking-wide">
                {row.label}
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {row.options.map((opt) => {
                  const active = (picks as Record<string, unknown>)[row.key] === opt.value;
                  return (
                    <button
                      key={String(opt.value)}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setPick(row.key, opt.value as never)}
                      className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-md)] text-[12px] transition-colors ${
                        active
                          ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]'
                          : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      {active ? <Check className="w-3 h-3" aria-hidden="true" /> : null}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <footer className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
            {autoSkipPaused
              ? t('promptAssist.skipPaused')
              : t('promptAssist.skipIn', { seconds: String(countdown) })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={skip}
              className="h-9 px-3 rounded-[var(--radius-md)] text-[var(--text-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              {t('promptAssist.skip')}
            </button>
            <button
              type="button"
              onClick={submit}
              className="h-9 px-3 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-on-accent)] text-[var(--text-sm)] font-medium hover:opacity-90 transition-opacity"
            >
              {t('promptAssist.submit')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
