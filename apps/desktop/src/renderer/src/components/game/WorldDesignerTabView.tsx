import type { GameArtifact, WorldDoc } from '@open-codesign/shared';
import { WorldDoc as WorldDocSchema } from '@open-codesign/shared';
import { Download, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCodesignStore } from '../../store';
import { GENERATE_WORLD_GRAPH_BRIEF } from './game-briefs';
import { computeForceLayout } from './level-renderers/forceLayout';

/**
 * level-and-world-designer §Phase 4 — World Designer.
 *
 * SVG-based graph view of the design's world.json: levels as nodes,
 * transitions as directed edges. Layout reads each level's
 * sequencePosition (linear) and transitions to compute positions;
 * graph-style force layout deferred to Phase 8 polish.
 *
 * Editing today (Phase 4 minimum):
 *  - Pick start level via dropdown.
 *  - Click a level node → switches to Levels tab + selects that slug.
 *  - Add transition: structured form below the graph.
 *  - Empty state: "Generate world graph from existing levels" CTA seeds
 *    GENERATE_WORLD_GRAPH_BRIEF in the prompt.
 */
export function WorldDesignerTabView() {
  const designId = useCodesignStore((s) => s.currentDesignId);
  const allArtifacts = useCodesignStore((s) =>
    designId !== null ? (s.gameArtifactsByDesign[designId] ?? null) : null,
  );
  const worldArtifact = useMemo(
    () => (allArtifacts ?? []).find((a) => a.kind === 'world') ?? null,
    [allArtifacts],
  );
  const levelArtifacts = useMemo(
    () => (allArtifacts ?? []).filter((a) => a.kind === 'level'),
    [allArtifacts],
  );
  const setPromptDraft = useCodesignStore((s) => s.setPromptDraft);
  const selectProjectTab = useCodesignStore((s) => s.selectProjectTab);

  const [doc, setDoc] = useState<WorldDoc | null>(null);
  const [rawIssue, setRawIssue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const path = worldArtifact?.primaryFilePath ?? 'assets/world/world.json';

  useEffect(() => {
    if (designId === null) return;
    if (worldArtifact === null) {
      setDoc(null);
      setRawIssue(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    if (window.codesign === undefined) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void window.codesign.gameArtifacts
      .readFile(designId, path)
      .then((res) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(res.content) as unknown;
          const result = WorldDocSchema.safeParse(parsed);
          if (result.success) {
            setDoc(result.data);
            setRawIssue(null);
          } else {
            setDoc(null);
            setRawIssue(result.error.issues.map((i) => i.message).join('; '));
          }
        } catch (err) {
          setDoc(null);
          setRawIssue(err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDoc(null);
          setRawIssue(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [designId, worldArtifact, path]);

  const writeDoc = useCallback(
    (next: WorldDoc) => {
      if (designId === null || window.codesign === undefined) return;
      if (saveDebounceRef.current !== null) clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = setTimeout(() => {
        setSaving(true);
        void window.codesign?.gameArtifacts
          .writeFile(designId, 'assets/world/world.json', JSON.stringify(next, null, 2))
          .catch(() => {
            /* swallow — toast surfaced via the IPC layer */
          })
          .finally(() => setSaving(false));
      }, 300);
    },
    [designId],
  );

  if (designId === null) return null;

  if (worldArtifact === null) {
    return (
      <WorldEmptyState
        hasLevels={levelArtifacts.length > 0}
        onGenerate={() => setPromptDraft(GENERATE_WORLD_GRAPH_BRIEF)}
      />
    );
  }

  if (loading || (doc === null && rawIssue === null)) {
    return (
      <div className="flex flex-1 items-center justify-center gap-[var(--space-2)] text-[12px] text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 codesign-spin-once" aria-hidden="true" />
        <span>Loading world graph…</span>
      </div>
    );
  }

  if (doc === null) {
    return (
      <div className="flex flex-1 flex-col gap-[var(--space-2)] p-[var(--space-3)]">
        <div className="rounded-[var(--radius-sm)] border border-amber-500/40 bg-amber-500/8 p-[var(--space-2)] text-[11px] text-amber-500">
          <strong className="text-[12px]">world.json failed to parse.</strong>{' '}
          <span>{rawIssue ?? 'unknown error'}</span>
        </div>
      </div>
    );
  }

  return (
    <WorldGraphView
      doc={doc}
      levelArtifacts={levelArtifacts}
      saving={saving}
      onSelectLevel={(slug) => {
        // Hand off to the Levels tab. The LevelsTabView's own state
        // re-derives the selected slug from the artifact list.
        selectProjectTab('levels');
        useCodesignStore.setState({ toastMessage: `Open level "${slug}" in the Levels tab.` });
      }}
      onChange={(next) => {
        setDoc(next);
        writeDoc(next);
      }}
    />
  );
}

function WorldGraphView({
  doc,
  levelArtifacts,
  saving,
  onSelectLevel,
  onChange,
}: {
  doc: WorldDoc;
  levelArtifacts: GameArtifact[];
  saving: boolean;
  onSelectLevel: (slug: string) => void;
  onChange: (next: WorldDoc) => void;
}) {
  const [layoutMode, setLayoutMode] = useState<'sequence' | 'force'>('sequence');
  const layout = useMemo(() => layoutWorld(doc, layoutMode), [doc, layoutMode]);
  const [pendingFrom, setPendingFrom] = useState<string>('');
  const [pendingTo, setPendingTo] = useState<string>('');
  const [pendingTrigger, setPendingTrigger] =
    useState<WorldDoc['transitions'][number]['triggerType']>('exit');
  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)] p-[var(--space-3)]">
      <div className="flex flex-wrap items-center gap-[var(--space-2)] text-[11px] text-[var(--color-text-muted)]">
        <span>{doc.levels.length} levels</span>
        <span className="opacity-50">·</span>
        <span>{doc.transitions.length} transitions</span>
        {saving ? (
          <span className="inline-flex items-center gap-[4px]">
            <Loader2 className="h-3 w-3 codesign-spin-once" aria-hidden="true" />
            Saving…
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-[var(--space-2)]">
          <div className="inline-flex items-center gap-[2px]">
            <span className="text-[var(--color-text-muted)]">Layout</span>
            {(['sequence', 'force'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={layoutMode === m}
                onClick={() => setLayoutMode(m)}
                className={`rounded-[var(--radius-sm)] px-[var(--space-2)] py-[2px] capitalize ${
                  layoutMode === m
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <span className="opacity-50">·</span>
          <button
            type="button"
            onClick={() => downloadStringAsFile(JSON.stringify(doc, null, 2), 'world.json')}
            aria-label="Export world graph"
            title="Export world.json as a standalone file"
            className="rounded-[var(--radius-sm)] p-[4px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span className="opacity-50">·</span>
          <span>Start level</span>
          <select
            value={doc.startLevelSlug ?? ''}
            onChange={(e) =>
              onChange({ ...doc, startLevelSlug: e.target.value === '' ? null : e.target.value })
            }
            className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-1)] py-[2px] text-[11px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          >
            <option value="">—</option>
            {doc.levels.map((l) => (
              <option key={l.slug} value={l.slug}>
                {l.displayName ?? l.slug}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] p-[var(--space-2)]">
        <svg
          viewBox={`${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.w} ${layout.viewBox.h}`}
          className="h-full w-full"
          preserveAspectRatio="xMidYMid meet"
          aria-label="World graph preview"
        >
          <defs>
            <marker
              id="world-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.7)" />
            </marker>
          </defs>
          {doc.transitions.map((t) => {
            const from = layout.byId.get(t.from);
            const to = layout.byId.get(t.to);
            if (from === undefined || to === undefined) return null;
            return (
              <line
                key={t.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={
                  t.triggerType === 'death'
                    ? 'rgba(255,122,122,0.65)'
                    : t.triggerType === 'objective'
                      ? 'rgba(125,255,177,0.65)'
                      : 'rgba(255,255,255,0.5)'
                }
                strokeWidth={layout.strokeWidth}
                markerEnd="url(#world-arrow)"
              />
            );
          })}
          {doc.levels.map((lvl) => {
            const pt = layout.byId.get(lvl.slug);
            if (pt === undefined) return null;
            const isStart = doc.startLevelSlug === lvl.slug;
            return (
              <g
                key={lvl.slug}
                onClick={() => onSelectLevel(lvl.slug)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={layout.nodeRadius}
                  fill={isStart ? '#22e1ff' : 'rgba(125,249,255,0.18)'}
                  stroke={isStart ? '#bff8ff' : 'rgba(125,249,255,0.55)'}
                  strokeWidth={layout.strokeWidth}
                />
                <text
                  x={pt.x}
                  y={pt.y}
                  fontSize={layout.labelSize}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="rgba(255,255,255,0.95)"
                  pointerEvents="none"
                >
                  {(lvl.displayName ?? lvl.slug).slice(0, 16)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] p-[var(--space-2)] text-[11px]">
        <div className="grid grid-cols-4 items-end gap-[var(--space-2)]">
          <label className="flex flex-col gap-[2px]">
            <span className="text-[var(--color-text-muted)]">From</span>
            <select
              value={pendingFrom}
              onChange={(e) => setPendingFrom(e.target.value)}
              className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            >
              <option value="">—</option>
              {doc.levels.map((l) => (
                <option key={l.slug} value={l.slug}>
                  {l.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-[2px]">
            <span className="text-[var(--color-text-muted)]">To</span>
            <select
              value={pendingTo}
              onChange={(e) => setPendingTo(e.target.value)}
              className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            >
              <option value="">—</option>
              {doc.levels.map((l) => (
                <option key={l.slug} value={l.slug}>
                  {l.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-[2px]">
            <span className="text-[var(--color-text-muted)]">Trigger</span>
            <select
              value={pendingTrigger}
              onChange={(e) =>
                setPendingTrigger(e.target.value as WorldDoc['transitions'][number]['triggerType'])
              }
              className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            >
              <option value="exit">exit</option>
              <option value="death">death</option>
              <option value="objective">objective</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <button
            type="button"
            disabled={pendingFrom === '' || pendingTo === '' || pendingFrom === pendingTo}
            onClick={() => {
              const id = `t-${pendingFrom}-${pendingTo}-${doc.transitions.length}`;
              const next: WorldDoc = {
                ...doc,
                transitions: [
                  ...doc.transitions,
                  { id, from: pendingFrom, to: pendingTo, triggerType: pendingTrigger },
                ],
              };
              onChange(next);
              setPendingFrom('');
              setPendingTo('');
            }}
            className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-[var(--space-2)] py-[var(--space-1)] text-[12px] text-white hover:opacity-90 disabled:opacity-40 disabled:pointer-events-none"
          >
            Add transition
          </button>
        </div>
        <p className="mt-[var(--space-2)] text-[10px] text-[var(--color-text-muted)]">
          {levelArtifacts.length} levels registered ·{' '}
          {levelArtifacts.length !== doc.levels.length ? (
            <span className="text-amber-500">
              Drift: world.json lists {doc.levels.length} but registry has {levelArtifacts.length}.
              Re-run "Generate world graph" to reconcile.
            </span>
          ) : (
            <span>Registry + world.json in sync.</span>
          )}
        </p>
      </div>
    </div>
  );
}

/** Same browser-side download helper used by LevelDetail. Phase 8.7. */
function downloadStringAsFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function layoutWorld(
  doc: WorldDoc,
  mode: 'sequence' | 'force',
): {
  byId: Map<string, { x: number; y: number }>;
  viewBox: { x: number; y: number; w: number; h: number };
  nodeRadius: number;
  strokeWidth: number;
  labelSize: number;
} {
  if (doc.levels.length === 0) {
    return {
      byId: new Map(),
      viewBox: { x: 0, y: 0, w: 100, h: 100 },
      nodeRadius: 6,
      strokeWidth: 0.6,
      labelSize: 4,
    };
  }
  const W = 1000;
  const H = 600;
  const byId = new Map<string, { x: number; y: number }>();
  if (mode === 'force') {
    const positioned = computeForceLayout(
      doc.levels.map((l) => ({ id: l.slug, x: 0, y: 0 })),
      doc.transitions.map((t) => ({ from: t.from, to: t.to })),
      { size: Math.max(W, H), springLen: 200, repulsion: 22000, iterations: 240 },
    );
    for (const [slug, p] of positioned.entries()) byId.set(slug, p);
    return {
      byId,
      viewBox: { x: 0, y: 0, w: W, h: H },
      nodeRadius: 36,
      strokeWidth: 2,
      labelSize: 14,
    };
  }
  // Sort by sequencePosition (declared) then alphabetically (stable
  // tiebreak). Layout: simple chain across the X axis with a slight
  // staggered Y so longer chains read top-down.
  const sorted = [...doc.levels].sort((a, b) => {
    const ap = a.sequencePosition ?? Number.POSITIVE_INFINITY;
    const bp = b.sequencePosition ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return a.slug.localeCompare(b.slug);
  });
  const margin = 80;
  const span = Math.max(1, sorted.length - 1);
  for (let i = 0; i < sorted.length; i += 1) {
    const x = margin + ((W - margin * 2) * i) / span;
    // 4-row stagger to avoid label overlap on big graphs.
    const y = margin + ((i % 4) * (H - margin * 2)) / 4;
    const lvl = sorted[i];
    if (lvl !== undefined) byId.set(lvl.slug, { x, y });
  }
  return {
    byId,
    viewBox: { x: 0, y: 0, w: W, h: H },
    nodeRadius: 36,
    strokeWidth: 2,
    labelSize: 14,
  };
}

function WorldEmptyState({
  hasLevels,
  onGenerate,
}: {
  hasLevels: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[var(--space-2)] p-[var(--space-3)] text-center text-[12px] text-[var(--color-text-muted)]">
      <p>No world graph yet.</p>
      <p className="text-[11px]">
        The world.json singleton at <code>assets/world/world.json</code> describes the graph linking
        your levels.
      </p>
      {hasLevels ? (
        <button
          type="button"
          onClick={onGenerate}
          className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-[var(--space-3)] py-[var(--space-1)] text-[12px] text-white hover:opacity-90"
        >
          Generate world graph from levels
        </button>
      ) : (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Add at least one level via the Levels tab first.
        </p>
      )}
    </div>
  );
}

// GENERATE_WORLD_GRAPH_BRIEF lives in ./game-briefs.ts so the unified
// Decompose orchestrator can sequence it after the level extraction.
