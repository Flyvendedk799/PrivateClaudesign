import { useCallback, useEffect, useState } from 'react';

/**
 * level-and-world-designer §Phase 5 — fallback renderer for
 * `freeform-json` levels and parse-failed levels. Plain textarea with
 * a "Validate JSON" indicator and a manual "Save" button. Avoids
 * Monaco for now to keep bundle size flat — the schema-aware
 * renderers handle the structured cases.
 */
export function JsonRenderer({
  rawContent,
  onChangeRaw,
}: {
  rawContent: string;
  onChangeRaw: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(rawContent);
  const [parseError, setParseError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(rawContent);
  }, [rawContent]);

  const validate = useCallback((value: string): string | null => {
    if (value.trim().length === 0) return null;
    try {
      JSON.parse(value);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  const onTextChange = useCallback(
    (value: string) => {
      setDraft(value);
      setParseError(validate(value));
    },
    [validate],
  );

  const onSave = useCallback(() => {
    if (parseError !== null) return;
    onChangeRaw(draft);
  }, [draft, onChangeRaw, parseError]);

  const dirty = draft !== rawContent;

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)]">
      <div className="flex items-center justify-between gap-[var(--space-2)]">
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {parseError !== null ? (
            <span className="text-red-500">JSON error: {parseError}</span>
          ) : dirty ? (
            <span>Unsaved changes</span>
          ) : (
            <span>JSON OK</span>
          )}
        </div>
        <button
          type="button"
          disabled={parseError !== null || !dirty}
          onClick={onSave}
          className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-[var(--space-3)] py-[2px] text-[12px] text-white hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none"
        >
          Save
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(e) => onTextChange(e.target.value)}
        spellCheck={false}
        className="flex-1 w-full resize-none rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] p-[var(--space-2)] font-mono text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
      />
    </div>
  );
}
