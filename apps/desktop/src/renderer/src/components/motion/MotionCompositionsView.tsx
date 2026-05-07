import { useCodesignStore } from '../../store';

/** motion-graphics-plan §4 — list of registered Remotion compositions for
 *  the current design. Click selects a composition, which the iframe URL
 *  picks up via ?compositionId=. */
export function MotionCompositionsView() {
  const designId = useCodesignStore((s) => s.currentDesignId);
  const compositions = useCodesignStore((s) =>
    designId !== null ? (s.motionCompositionsByDesign[designId] ?? []) : [],
  );
  const selectedId = useCodesignStore((s) =>
    designId !== null ? (s.selectedCompositionIdByDesign[designId] ?? null) : null,
  );
  const selectComposition = useCodesignStore((s) => s.selectComposition);
  const selectMotionTab = useCodesignStore((s) => s.selectMotionTab);

  if (designId === null) return null;

  if (compositions.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--color-background)] p-6 text-center">
        <p className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">
          No compositions registered yet.
        </p>
        <p className="text-[var(--text-xs)] text-[var(--color-text-muted)] max-w-md">
          Ask the assistant to author a Remotion composition. The agent calls
          <code className="mx-1 rounded bg-[var(--color-surface)] px-1">register_composition</code>
          after writing <code>src/Root.tsx</code>; rows will appear here as soon as a generation
          lands.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--color-background)] p-[var(--space-3)]">
      <div className="grid gap-2">
        {compositions.map((c) => {
          const active = c.compositionId === selectedId;
          return (
            <button
              key={c.id}
              type="button"
              data-testid={`motion-composition-${c.compositionId}`}
              onClick={() => {
                selectComposition(designId, c.compositionId);
                selectMotionTab('preview');
              }}
              className={`flex flex-col gap-1 rounded-[var(--radius-md)] border px-[var(--space-3)] py-[var(--space-3)] text-left transition-colors ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-primary)]">
                  {c.name}
                </span>
                <span className="font-mono text-[var(--text-xs)] text-[var(--color-text-muted)]">
                  {c.compositionId}
                </span>
              </div>
              <div className="flex flex-wrap gap-3 text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                <span>
                  {c.width}×{c.height}
                </span>
                <span>{c.fps} fps</span>
                <span>{c.durationInFrames} frames</span>
                <span>{(c.durationInFrames / c.fps).toFixed(2)} s</span>
                <span className="font-mono">{c.entryFile}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
