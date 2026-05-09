import { useT } from '@open-codesign/i18n';
import { Boxes, Film, FolderOpen, Gamepad2, Joystick, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MotionStyle } from '../store';
import { useCodesignStore } from '../store';

type Mode = 'design' | 'game' | 'motion';
type Engine = 'auto' | 'three' | 'phaser' | 'pygame' | 'godot';
type StylePick = 'auto' | MotionStyle;

/** may9 Phase 10 — genre dropdown options. The seven shown here are
 *  the genres that ship a built-in playtest playbook (see
 *  packages/core/src/playtest-playbooks.ts) plus a small set of
 *  high-frequency briefs that don't yet have one but read naturally
 *  in a New-Design dropdown. The agent's declare_game_spec accepts
 *  more values than this; the dialog stays curated so the picker is
 *  scannable. */
type GenrePick =
  | 'auto'
  | 'platformer'
  | 'topdown_arcade'
  | 'fps'
  | 'tps'
  | 'fighting'
  | 'puzzle'
  | 'runner'
  | 'rpg'
  | 'shmup'
  | 'racing'
  | 'tower_defense'
  | 'rhythm';

const GENRE_OPTIONS: ReadonlyArray<{ value: GenrePick; label: string }> = [
  { value: 'auto', label: 'Auto (let the agent infer)' },
  { value: 'platformer', label: 'Platformer (side-scroll, jump arcs)' },
  { value: 'topdown_arcade', label: 'Top-down arcade' },
  { value: 'fps', label: 'FPS (first-person shooter)' },
  { value: 'tps', label: 'TPS (third-person shooter)' },
  { value: 'fighting', label: 'Fighting / brawler' },
  { value: 'puzzle', label: 'Puzzle (match / swap)' },
  { value: 'runner', label: 'Endless runner' },
  { value: 'rpg', label: 'RPG (top-down or iso)' },
  { value: 'shmup', label: 'Shoot-em-up (vertical / horiz)' },
  { value: 'racing', label: 'Racing' },
  { value: 'tower_defense', label: 'Tower defense' },
  { value: 'rhythm', label: 'Rhythm' },
];

const STYLE_OPTIONS: ReadonlyArray<{
  value: StylePick;
  label: string;
  blurb: string;
}> = [
  { value: 'auto', label: 'Auto', blurb: 'Let the agent pick based on the brief' },
  { value: '2d', label: '2D', blurb: 'Illustration / shapes / vector animation' },
  {
    value: 'kinetic-text',
    label: 'Kinetic text',
    blurb: 'Animated headlines, lyric video, intros',
  },
  { value: 'data-viz', label: 'Data viz', blurb: 'Animated chart reveal / dashboard motion' },
  { value: '3d', label: '3D', blurb: 'Three.js / React Three Fiber inside Remotion' },
  { value: 'mixed', label: 'Mixed', blurb: 'Combination of the above' },
];

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
  const setPendingArtifactSelection = useCodesignStore((s) => s.setPendingArtifactSelection);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  // gameplan §A6 + motion-graphics-plan §0.2 — dialog opens to the user's
  // last-picked mode. Hydrated from preferences.json via store.lastPickedMode.
  const [mode, setMode] = useState<Mode>(lastPickedMode);
  const [engine, setEngine] = useState<Engine>('auto');
  const [style, setStyle] = useState<StylePick>('auto');
  // may9 Phase 10 — genre seed. Seeds the agent's declare_game_spec
  // call so the spec gate has a typed genre from the get-go (closes
  // the FPS-vault iteration coherence regression class on the very
  // first turn). 'auto' leaves it to the agent.
  const [genre, setGenre] = useState<GenrePick>('auto');

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
      // gameplan §A6 + motion-graphics-plan §0.2 — stage mode/engine/style
      // into the store BEFORE creating the design so the next generate
      // payload picks them up. 'auto' engine/style becomes null → agent's
      // first tool call is choose_engine / choose_remotion_style.
      setPendingArtifactSelection({
        mode,
        engine: mode === 'game' && engine !== 'auto' ? engine : null,
        motionStyle: mode === 'motion' && style !== 'auto' ? style : null,
        gameGenre: mode === 'game' && genre !== 'auto' ? genre : null,
      });
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
  const isMotion = mode === 'motion';

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

        {/* gameplan §A6 + motion-graphics-plan §0.2 — Mode toggle (Design / Game / Motion). */}
        <div
          role="tablist"
          aria-label="Artifact mode"
          className="grid grid-cols-3 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={!isGame && !isMotion}
            onClick={() => setMode('design')}
            className={`flex items-center justify-center gap-2 h-9 rounded-[var(--radius-sm)] text-[var(--text-sm)] font-medium transition-colors ${
              !isGame && !isMotion
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
          <button
            type="button"
            role="tab"
            aria-selected={isMotion}
            onClick={() => setMode('motion')}
            className={`flex items-center justify-center gap-2 h-9 rounded-[var(--radius-sm)] text-[var(--text-sm)] font-medium transition-colors ${
              isMotion
                ? 'bg-[var(--color-background)] text-[var(--color-text-primary)] shadow-sm'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Film className="size-4" />
            Motion
          </button>
        </div>

        {isMotion ? (
          <div className="space-y-2">
            <p className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">Style</p>
            <div className="space-y-1.5">
              {STYLE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2 p-2.5 rounded-[var(--radius-md)] border cursor-pointer transition-colors ${
                    style === opt.value
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="motion-style"
                    value={opt.value}
                    checked={style === opt.value}
                    onChange={() => setStyle(opt.value)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-[var(--text-sm)] font-medium text-[var(--color-text-primary)]">
                      {opt.value === 'auto' ? (
                        <Boxes className="size-3.5" />
                      ) : (
                        <Film className="size-3.5" />
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
        ) : isGame ? (
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
            {/* may9 Phase 10 — genre dropdown. Seeds declare_game_spec
                so the spec gate runs with a typed genre from turn 0. */}
            <div className="space-y-1.5 pt-1">
              <label
                htmlFor="newdesign-genre"
                className="text-[var(--text-xs)] text-[var(--color-text-secondary)]"
              >
                Genre
              </label>
              <select
                id="newdesign-genre"
                value={genre}
                onChange={(e) => setGenre(e.target.value as GenrePick)}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[var(--text-sm)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
              >
                {GENRE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
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
