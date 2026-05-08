import type { GameArtifact, LevelDoc } from '@open-codesign/shared';
import { LevelDoc as LevelDocSchema, inferLevelKind } from '@open-codesign/shared';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useCodesignStore } from '../../store';
import {
  ADD_LEVEL_BRIEF,
  DEFINE_LEVEL_SCHEMA_BRIEF,
  EXTRACT_LEVELS_FROM_GAME_BRIEF,
} from './game-briefs';
import { LevelDetail } from './level-renderers/LevelDetail';

/**
 * level-and-world-designer §Phase 2 — top-level view for the Levels tab.
 *
 * Reads the design's `kind='level'` artifacts from the store (populated
 * via `loadGameArtifacts` on design switch + after every snapshot).
 * Selecting a level streams its `level.json` content via the
 * `gameArtifacts.readFile` IPC, parses against `LevelDoc`, and dispatches
 * to a kind-specific renderer through `LevelDetail`. Unparsable levels
 * surface as a warning banner above the JSON fallback so divergence is
 * visible — never silent.
 *
 * Empty state offers two paths:
 *   - "Add level" → seeds the prompt draft with `ADD_LEVEL_BRIEF`
 *     (Phase 6) so the agent generates a level conforming to the
 *     design's `_schema.json`.
 *   - "Extract from existing artwork" → seeds the much larger
 *     `EXTRACT_LEVELS_FROM_GAME_BRIEF` for designs that already have
 *     a game in `index.html` (the user's three.js shooter use case).
 */
export function LevelsTabView() {
  const designId = useCodesignStore((s) => s.currentDesignId);
  const allArtifacts = useCodesignStore((s) =>
    designId !== null ? (s.gameArtifactsByDesign[designId] ?? null) : null,
  );
  const levels = useMemo(
    () => (allArtifacts ?? []).filter((a) => a.kind === 'level'),
    [allArtifacts],
  );
  const setPromptDraft = useCodesignStore((s) => s.setPromptDraft);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // Auto-select the first level when one becomes available and nothing
  // is selected yet. Subsequent renders preserve user selection.
  useEffect(() => {
    if (selectedSlug !== null) return;
    const first = levels[0];
    if (first !== undefined) setSelectedSlug(first.slug);
  }, [levels, selectedSlug]);

  if (designId === null) return null;

  return (
    <div className="flex h-full min-h-0 flex-1 bg-[var(--color-background)]">
      <div className="flex w-[300px] flex-col border-r border-[var(--color-border-muted)]">
        <div className="flex items-center justify-between p-[var(--space-3)]">
          <h3 className="text-[13px] font-medium text-[var(--color-text-primary)]">Levels</h3>
          <button
            type="button"
            onClick={() => setPromptDraft(ADD_LEVEL_BRIEF)}
            title="Seed the prompt with a brief asking the agent to add a new level conforming to the design's _schema.json"
            className="inline-flex items-center gap-[4px] rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-[var(--space-2)] py-[2px] text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            New level
          </button>
        </div>
        {levels.length === 0 ? (
          <LevelsEmptyState
            onAddLevel={() => setPromptDraft(ADD_LEVEL_BRIEF)}
            onDefineSchema={() => setPromptDraft(DEFINE_LEVEL_SCHEMA_BRIEF)}
            onExtractFromGame={() => setPromptDraft(EXTRACT_LEVELS_FROM_GAME_BRIEF)}
          />
        ) : (
          <ul className="flex-1 overflow-y-auto px-[var(--space-2)] pb-[var(--space-2)]">
            {levels.map((lvl) => (
              <LevelRow
                key={lvl.id}
                level={lvl}
                active={lvl.slug === selectedSlug}
                onSelect={() => setSelectedSlug(lvl.slug)}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-1 flex-col p-[var(--space-3)]">
        {selectedSlug !== null ? (
          <LevelDetail designId={designId} slug={selectedSlug} levels={levels} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">
            Select a level to inspect or edit it.
          </div>
        )}
      </div>
    </div>
  );
}

function LevelRow({
  level,
  active,
  onSelect,
}: {
  level: GameArtifact;
  active: boolean;
  onSelect: () => void;
}) {
  const kindLabel = level.metadata.kind === 'level' ? level.metadata.levelKind : 'unknown';
  const biome = level.metadata.kind === 'level' ? level.metadata.biome : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        data-testid={`level-row-${level.slug}`}
        className={`my-[2px] w-full rounded-[var(--radius-sm)] p-[var(--space-2)] text-left ${
          active
            ? 'bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <div className="flex items-center justify-between gap-[var(--space-1)]">
          <span className="truncate text-[12px] font-medium">{level.name}</span>
          <span
            className={`shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] px-[6px] py-[1px] text-[10px] tabular-nums ${
              kindLabel === 'unknown'
                ? 'border-amber-500/40 text-amber-500'
                : 'text-[var(--color-text-muted)]'
            }`}
          >
            {kindLabel}
          </span>
        </div>
        <div className="mt-[2px] truncate text-[11px] text-[var(--color-text-muted)]">
          {biome !== undefined && biome !== '' ? biome : level.slug}
        </div>
      </button>
    </li>
  );
}

function LevelsEmptyState({
  onAddLevel,
  onDefineSchema,
  onExtractFromGame,
}: {
  onAddLevel: () => void;
  onDefineSchema: () => void;
  onExtractFromGame: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[var(--space-2)] p-[var(--space-3)] text-center text-[12px] text-[var(--color-text-muted)]">
      <p>No levels yet.</p>
      <p className="text-[11px]">
        Levels live under <code>assets/levels/&lt;slug&gt;/level.json</code>. The agent owns the
        schema; pick a starting point.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-[var(--space-2)]">
        <button
          type="button"
          onClick={onAddLevel}
          className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-[var(--space-3)] py-[var(--space-1)] text-[12px] text-white hover:opacity-90"
        >
          Generate first level
        </button>
        <button
          type="button"
          onClick={onDefineSchema}
          title="Decide the level shape for this game (tilemap-2d, scene-3d, node-graph, wave-script, freeform-json)"
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-3)] py-[var(--space-1)] text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          Define level schema
        </button>
        <button
          type="button"
          onClick={onExtractFromGame}
          title="If the design already has a game in index.html, extract level/area boundaries into discrete level files"
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-3)] py-[var(--space-1)] text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          Extract from existing game
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 6 briefs (ADD_LEVEL_BRIEF / DEFINE_LEVEL_SCHEMA_BRIEF /
// EXTRACT_LEVELS_FROM_GAME_BRIEF) live in ./game-briefs.ts so the
// unified Decompose orchestrator can reference them too.
// ---------------------------------------------------------------------------

// Export the parser type for downstream renderers.
export type ParsedLevelDoc = LevelDoc;

/** Best-effort parse helper — used by LevelDetail. Returns the typed
 *  doc on success, the raw value + zod issues on failure. */
export function parseLevelDoc(
  raw: string,
):
  | { ok: true; doc: LevelDoc; rawJson: unknown }
  | { ok: false; rawJson: unknown; issues: string[] } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      rawJson: raw,
      issues: [`JSON parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const inferred = inferLevelKind(parsedJson);
  if (inferred === 'unknown') {
    return {
      ok: false,
      rawJson: parsedJson,
      issues: [
        'Missing or unknown "kind" field. Expected one of: tilemap-2d, scene-3d, node-graph, wave-script, freeform-json.',
      ],
    };
  }
  const result = LevelDocSchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      rawJson: parsedJson,
      issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  return { ok: true, doc: result.data, rawJson: parsedJson };
}
