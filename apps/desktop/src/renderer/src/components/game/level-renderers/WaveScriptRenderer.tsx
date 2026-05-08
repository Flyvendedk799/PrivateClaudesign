import type { WaveScriptLevelDoc } from '@open-codesign/shared';
import { useMemo } from 'react';

/**
 * level-and-world-designer §Phase 5 — `wave-script` renderer.
 *
 * Horizontal timeline with one lane per spawn point (or per enemyType
 * if no spawn point ids are declared) and waves drawn as colored
 * blocks at their startMs offsets. Useful for the user's three.js
 * Wave Defense FPS — the game logic carries the timing implicitly;
 * this view makes it visible.
 */
export function WaveScriptRenderer({
  doc,
  onChange,
}: {
  doc: WaveScriptLevelDoc;
  onChange: (next: WaveScriptLevelDoc) => void;
}) {
  const view = useMemo(() => buildTimeline(doc), [doc]);

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)] overflow-hidden">
      <div className="flex items-center gap-[var(--space-2)] text-[11px] text-[var(--color-text-muted)]">
        <span>{doc.waves.length} waves</span>
        <span className="opacity-50">·</span>
        <span>{view.lanes.length} lanes</span>
        <span className="opacity-50">·</span>
        <span>
          duration: {view.totalMs.toLocaleString()}
          ms ≈ {(view.totalMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="flex flex-1 flex-col overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] p-[var(--space-2)]">
        <div className="flex items-stretch gap-[var(--space-2)]">
          <div className="flex w-[120px] shrink-0 flex-col gap-[2px]">
            <div className="h-5 text-[10px] text-[var(--color-text-muted)]">Lane</div>
            {view.lanes.map((lane) => (
              <div
                key={lane.id}
                className="flex h-7 items-center truncate text-[11px] text-[var(--color-text-secondary)]"
                title={lane.id}
              >
                {lane.label}
              </div>
            ))}
          </div>
          <div className="relative flex-1">
            <div className="relative h-5 border-b border-[var(--color-border-muted)] text-[10px] text-[var(--color-text-muted)]">
              {view.tickMs.map((t) => (
                <div
                  key={`tick-${t}`}
                  className="absolute top-0 h-5 border-l border-[var(--color-border-muted)] pl-[2px]"
                  style={{ left: `${(t / view.totalMs) * 100}%` }}
                >
                  {(t / 1000).toFixed(0)}s
                </div>
              ))}
            </div>
            {view.lanes.map((lane) => (
              <div
                key={lane.id}
                className="relative h-7 border-b border-[var(--color-border-muted)]/40"
              >
                {lane.blocks.map((block, i) => (
                  <div
                    key={`b-${lane.id}-${i.toString()}`}
                    className="absolute top-1 bottom-1 rounded-[var(--radius-sm)] bg-[var(--color-accent)]/35 px-[var(--space-1)] text-[10px] tabular-nums text-[var(--color-text-primary)] hover:bg-[var(--color-accent)]/55"
                    style={{
                      left: `${(block.startMs / view.totalMs) * 100}%`,
                      width: `${Math.max(0.5, ((block.endMs - block.startMs) / view.totalMs) * 100)}%`,
                    }}
                    title={`${block.label} @ ${block.startMs}ms (count=${block.count})`}
                  >
                    {block.label}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <WaveScriptPrimitiveForm doc={doc} onChange={onChange} />
    </div>
  );
}

function buildTimeline(doc: WaveScriptLevelDoc): {
  lanes: Array<{
    id: string;
    label: string;
    blocks: Array<{ startMs: number; endMs: number; label: string; count: number }>;
  }>;
  totalMs: number;
  tickMs: number[];
} {
  const laneMap = new Map<
    string,
    {
      label: string;
      blocks: Array<{ startMs: number; endMs: number; label: string; count: number }>;
    }
  >();
  let endByImplicit = 0;
  for (const wave of doc.waves) {
    const waveEnd = wave.startMs + (wave.spawns.reduce((acc, s) => acc + s.delayMs, 0) || 1000);
    if (waveEnd > endByImplicit) endByImplicit = waveEnd;
    for (const spawn of wave.spawns) {
      const laneId = spawn.spawnPointId ?? `type:${spawn.enemyType}`;
      const laneLabel = spawn.spawnPointId ?? spawn.enemyType;
      if (!laneMap.has(laneId)) laneMap.set(laneId, { label: laneLabel, blocks: [] });
      const startMs = wave.startMs + spawn.delayMs;
      laneMap.get(laneId)?.blocks.push({
        startMs,
        endMs: startMs + 500,
        label: `${spawn.enemyType}×${spawn.count}`,
        count: spawn.count,
      });
    }
  }
  const totalMs = doc.durationMs ?? endByImplicit + 1000;
  const lanes = Array.from(laneMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, lane]) => ({ id, label: lane.label, blocks: lane.blocks }));
  // Round tick spacing to a sensible interval based on totalMs.
  const tickInterval = totalMs > 60_000 ? 10_000 : totalMs > 10_000 ? 5000 : 1000;
  const tickMs: number[] = [];
  for (let t = 0; t <= totalMs; t += tickInterval) tickMs.push(t);
  return { lanes, totalMs: Math.max(1, totalMs), tickMs };
}

function WaveScriptPrimitiveForm({
  doc,
  onChange,
}: {
  doc: WaveScriptLevelDoc;
  onChange: (next: WaveScriptLevelDoc) => void;
}) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] p-[var(--space-2)] text-[11px]">
      <label className="flex flex-col gap-[2px]">
        <span className="text-[var(--color-text-muted)]">Total duration (ms, null = inferred)</span>
        <input
          type="number"
          value={doc.durationMs ?? ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange({ ...doc, durationMs: null });
              return;
            }
            const n = Number.parseInt(raw, 10);
            if (!Number.isNaN(n)) onChange({ ...doc, durationMs: Math.max(0, n) });
          }}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </label>
      <div className="mt-[var(--space-2)] text-[10px] text-[var(--color-text-muted)]">
        Wave reordering + per-spawn editing land in Phase 8 polish. Edit waves[] via the JSON
        fallback for now.
      </div>
    </div>
  );
}
