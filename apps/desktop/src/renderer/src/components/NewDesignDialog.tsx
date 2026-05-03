import { useT } from '@open-codesign/i18n';
import { Boxes, FolderOpen, Gamepad2, Joystick, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCodesignStore } from '../store';

type Mode = 'design' | 'game';
type Engine = 'auto' | 'three' | 'phaser' | 'pygame' | 'godot';

const ENGINE_OPTIONS: ReadonlyArray<{
  value: Engine;
  label: string;
  blurb: string;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    blurb: 'Let the agent pick based on the brief',
  },
  {
    value: 'three',
    label: 'Three.js',
    blurb: '3D, parallax depth, WebGL — live preview',
  },
  {
    value: 'phaser',
    label: 'Phaser',
    blurb: '2D arcade / platformer / puzzle — live preview',
  },
  {
    value: 'pygame',
    label: 'Pygame',
    blurb: 'Retro / Python source — preview lands in Phase C',
  },
  {
    value: 'godot',
    label: 'Godot',
    blurb: 'Mid-fidelity 2D RPG — project download (preview in Phase D)',
  },
];

export function NewDesignDialog() {
  const t = useT();
  const open = useCodesignStore((s) => s.newDesignDialogOpen);
  const close = useCodesignStore((s) => s.closeNewDesignDialog);
  const createNewDesign = useCodesignStore((s) => s.createNewDesign);
  const setView = useCodesignStore((s) => s.setView);
  const lastPickedMode = useCodesignStore((s) => s.lastPickedMode);
  const setPendingGameSelection = useCodesignStore((s) => s.setPendingGameSelection);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  // gameplan §A6 — dialog opens to the user's last-picked mode (Q2: c).
  // Hydrated from preferences.json via store.lastPickedMode at boot.
  const [mode, setMode] = useState<Mode>(lastPickedMode);
  const [engine, setEngine] = useState<Engine>('auto');

  useEffect(() => {
    if (open) setMode(lastPickedMode);
  }, [open, lastPickedMode]);

  if (!open) return null;

  async function handlePickFolder() {
    if (!window.codesign?.snapshots?.pickWorkspaceFolder) return;
    setPicking(true);
    try {
      const picked = await window.codesign.snapshots.pickWorkspaceFolder();
      if (picked) setSelectedPath(picked);
    } finally {
      setPicking(false);
    }
  }

  async function handleCreate(withPath: string | null) {
    setCreating(true);
    try {
      // gameplan §A6 — stage the mode/engine into the store BEFORE creating
      // the design so the next generate payload picks it up. 'auto' engine
      // becomes null → agent's first tool call is choose_engine.
      setPendingGameSelection(mode, mode === 'game' && engine !== 'auto' ? engine : null);
      const design = await createNewDesign(withPath);
      close();
      setSelectedPath(null);
      if (design) setView('workspace');
    } finally {
      setCreating(false);
    }
  }

  const busy = picking || creating;
  const isGame = mode === 'game';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas.newDesignDialog.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-[overlay-in_120ms_ease-out]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          close();
          setSelectedPath(null);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          close();
          setSelectedPath(null);
        }
      }}
    >
      <div
        role="document"
        className="w-full max-w-md rounded-[var(--radius-2xl)] bg-[var(--color-background)] border border-[var(--color-border)] shadow-[var(--shadow-elevated)] p-5 space-y-4 animate-[panel-in_160ms_ease-out]"
      >
        <div className="space-y-1">
          <h3 className="text-[var(--text-md)] font-medium text-[var(--color-text-primary)]">
            {t('canvas.newDesignDialog.title')}
          </h3>
          <p className="text-[var(--text-sm)] text-[var(--color-text-secondary)] leading-[var(--leading-body)]">
            {t('canvas.newDesignDialog.subtitle')}
          </p>
        </div>

        {/* gameplan §A6 — Mode toggle (Design / Game). */}
        <div
          role="tablist"
          aria-label="Artifact mode"
          className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={!isGame}
            onClick={() => setMode('design')}
            className={`flex items-center justify-center gap-2 h-9 rounded-[var(--radius-sm)] text-[var(--text-sm)] font-medium transition-colors ${
              !isGame
                ? 'bg-[var(--color-background)] text-[var(--color-text-primary)] shadow-sm'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Sparkles className="size-4" />
            Design
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isGame}
            onClick={() => setMode('game')}
            className={`flex items-center justify-center gap-2 h-9 rounded-[var(--radius-sm)] text-[var(--text-sm)] font-medium transition-colors ${
              isGame
                ? 'bg-[var(--color-background)] text-[var(--color-text-primary)] shadow-sm'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Gamepad2 className="size-4" />
            Game
          </button>
        </div>

        {isGame ? (
          <div className="space-y-2">
            <p className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">Engine</p>
            <div className="space-y-1.5">
              {ENGINE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2 p-2.5 rounded-[var(--radius-md)] border cursor-pointer transition-colors ${
                    engine === opt.value
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="engine"
                    value={opt.value}
                    checked={engine === opt.value}
                    onChange={() => setEngine(opt.value)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-[var(--text-sm)] font-medium text-[var(--color-text-primary)]">
                      {opt.value === 'auto' ? (
                        <Boxes className="size-3.5" />
                      ) : (
                        <Joystick className="size-3.5" />
                      )}
                      {opt.label}
                    </div>
                    <div className="text-[var(--text-xs)] text-[var(--color-text-secondary)] mt-0.5">
                      {opt.blurb}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
            <span className="flex-1 text-[var(--text-sm)] text-[var(--color-text-secondary)] font-mono truncate">
              {selectedPath ?? t('canvas.newDesignDialog.noWorkspace')}
            </span>
            <button
              type="button"
              onClick={() => void handlePickFolder()}
              disabled={busy}
              className="flex items-center gap-1.5 shrink-0 h-7 px-2.5 rounded-[var(--radius-sm)] text-[var(--text-xs)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <FolderOpen className="size-3.5" />
              {selectedPath ? t('canvas.workspace.change') : t('canvas.workspace.choose')}
            </button>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void handleCreate(null)}
            disabled={busy}
            className="h-9 px-3 rounded-[var(--radius-md)] text-[var(--text-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('canvas.newDesignDialog.skip')}
          </button>
          <button
            type="button"
            onClick={() => void handleCreate(selectedPath)}
            disabled={busy}
            className="h-9 px-3 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-on-accent)] text-[var(--text-sm)] font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {t('canvas.newDesignDialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
