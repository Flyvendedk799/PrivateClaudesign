import { useMemo } from 'react';
import type { GameProjectTab } from '../../store';
import { useCodesignStore } from '../../store';

const TABS: Array<{ id: GameProjectTab; label: string }> = [
  { id: 'preview', label: 'Preview' },
  { id: 'files', label: 'Files' },
  { id: 'sprites', label: 'Sprites' },
  { id: 'animations', label: 'Animations' },
];

/** game-artifacts §2 — top-level tab bar for game-mode designs. Mounted
 *  above the iframe; design-mode designs use the existing CanvasTabBar
 *  inside the Files tab instead. */
export function GameProjectTabs() {
  const activeTab = useCodesignStore((s) => s.activeProjectTab);
  const selectProjectTab = useCodesignStore((s) => s.selectProjectTab);
  const designId = useCodesignStore((s) => s.currentDesignId);
  // Select the raw stable array reference and derive the filtered
  // subsets via useMemo. The previous shape called `.filter()` (and a
  // bare `[]` literal) inside the selector, which returned a fresh
  // array reference on every render — zustand sees the new reference,
  // forces a re-render, the selector runs again, and the loop never
  // terminates ("Maximum update depth exceeded"). The bug stayed
  // dormant until the first design got promoted into game mode and
  // GameProjectTabs actually mounted.
  const artifacts = useCodesignStore((s) =>
    designId !== null ? (s.gameArtifactsByDesign[designId] ?? null) : null,
  );
  const sprites = useMemo(() => (artifacts ?? []).filter((a) => a.kind === 'sprite'), [artifacts]);
  const animations = useMemo(
    () => (artifacts ?? []).filter((a) => a.kind === 'animation'),
    [artifacts],
  );

  const counts: Record<GameProjectTab, number | null> = {
    preview: null,
    files: null,
    sprites: sprites.length,
    animations: animations.length,
  };

  return (
    <div
      role="tablist"
      aria-label="Game project tabs"
      className="flex h-9 items-end gap-1 border-b border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-2)]"
    >
      {TABS.map((tab) => {
        const active = tab.id === activeTab;
        const count = counts[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`game-project-tab-${tab.id}`}
            onClick={() => selectProjectTab(tab.id)}
            className={`relative flex h-8 items-center gap-1 rounded-t-[var(--radius-sm)] px-[var(--space-3)] text-[12px] transition-colors ${
              active
                ? 'bg-[var(--color-background)] text-[var(--color-text-primary)] shadow-[inset_0_1px_0_var(--color-border-muted),inset_1px_0_0_var(--color-border-muted),inset_-1px_0_0_var(--color-border-muted)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <span>{tab.label}</span>
            {count !== null ? (
              <span
                className={`min-w-[18px] rounded-full px-[6px] text-[10px] leading-[16px] ${
                  active
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'bg-[var(--color-surface-elevated)] text-[var(--color-text-muted)]'
                }`}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
