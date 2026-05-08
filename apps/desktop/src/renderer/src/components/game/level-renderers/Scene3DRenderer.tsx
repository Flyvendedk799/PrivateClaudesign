import type { Scene3DLevelDoc } from '@open-codesign/shared';
import { useMemo, useState } from 'react';
import { useCodesignStore } from '../../../store';
import { SANDBOX_GAME_3D } from '../../sandbox-tokens';

/**
 * level-and-world-designer §Phase 5 — `scene-3d` renderer.
 *
 * Top-down orthographic projection of the scene's nodes + spawns onto
 * a 2D SVG. Avoids pulling three.js into the renderer bundle (the
 * agent-generated game already loads three.js from a CDN inline; the
 * IDE itself stays lean). User picks the projection plane (XZ default
 * for FPS-style maps, XY for side-scrollers, YZ for vertical games).
 *
 * Schema-form panel below lets primitive bound + spawn fields edit
 * inline. Per-node transforms use the JSON fallback for now;
 * gizmo-driven editing lands in Phase 8 polish.
 */
export function Scene3DRenderer({
  doc,
  onChange,
}: {
  doc: Scene3DLevelDoc;
  onChange: (next: Scene3DLevelDoc) => void;
}) {
  const [plane, setPlane] = useState<'xz' | 'xy' | 'yz'>('xz');
  const [showLivePreview, setShowLivePreview] = useState(true);
  const projection = useMemo(() => projectScene(doc, plane), [doc, plane]);
  const previewHtml = useCodesignStore((s) => s.previewHtml);
  const previewUpdatedAt = useCodesignStore((s) => s.previewUpdatedAt);

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)] overflow-hidden">
      <div className="flex items-center gap-[var(--space-2)] text-[11px] text-[var(--color-text-muted)]">
        <span>{doc.nodes.length} nodes</span>
        <span className="opacity-50">·</span>
        <span>{doc.spawns.length} spawns</span>
        <div className="ml-auto flex items-center gap-[var(--space-2)]">
          <label className="inline-flex items-center gap-[4px] text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={showLivePreview}
              onChange={(e) => setShowLivePreview(e.target.checked)}
              aria-label="Show live preview"
            />
            <span>Live preview</span>
          </label>
          <span className="opacity-50">·</span>
          <span>Plane</span>
          {(['xz', 'xy', 'yz'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={plane === p}
              onClick={() => setPlane(p)}
              className={`rounded-[var(--radius-sm)] px-[var(--space-2)] py-[2px] uppercase ${
                plane === p
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div
        className={`flex flex-1 gap-[var(--space-2)] overflow-hidden ${
          showLivePreview && previewHtml !== null ? '' : ''
        }`}
      >
        <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] p-[var(--space-2)]">
          <svg
            viewBox={`${projection.viewBox.x} ${projection.viewBox.y} ${projection.viewBox.w} ${projection.viewBox.h}`}
            className="h-full w-full"
            preserveAspectRatio="xMidYMid meet"
            aria-label="Scene preview"
          >
            {/* Bounds rectangle */}
            <rect
              x={projection.boundsRect.x}
              y={projection.boundsRect.y}
              width={projection.boundsRect.w}
              height={projection.boundsRect.h}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeDasharray="4 4"
            />
            {/* Origin axes */}
            <line
              x1={projection.viewBox.x}
              y1={0}
              x2={projection.viewBox.x + projection.viewBox.w}
              y2={0}
              stroke="rgba(34,225,255,0.18)"
            />
            <line
              x1={0}
              y1={projection.viewBox.y}
              x2={0}
              y2={projection.viewBox.y + projection.viewBox.h}
              stroke="rgba(34,225,255,0.18)"
            />
            {projection.nodes.map((n) => (
              <g key={n.id}>
                <rect
                  x={n.x - n.size / 2}
                  y={n.y - n.size / 2}
                  width={n.size}
                  height={n.size}
                  fill={colorForNodeType(n.type)}
                  fillOpacity={0.65}
                  stroke="rgba(0,0,0,0.45)"
                  strokeWidth={projection.strokeWidth}
                />
                <text
                  x={n.x}
                  y={n.y}
                  fontSize={projection.labelSize}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="rgba(255,255,255,0.85)"
                >
                  {n.type.slice(0, 8)}
                </text>
              </g>
            ))}
            {projection.spawns.map((s, i) => (
              <circle
                key={`spawn-${i.toString()}`}
                cx={s.x}
                cy={s.y}
                r={projection.spawnSize}
                fill={
                  s.role === 'player'
                    ? '#7dffb1'
                    : s.role === 'enemy'
                      ? '#ff7a7a'
                      : s.role === 'exit'
                        ? '#22e1ff'
                        : s.role === 'checkpoint'
                          ? '#ffce42'
                          : '#bff8ff'
                }
                stroke="rgba(0,0,0,0.6)"
                strokeWidth={projection.strokeWidth}
              />
            ))}
          </svg>
        </div>
        {showLivePreview && previewHtml !== null ? (
          <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)]">
            <iframe
              key={`live-${previewUpdatedAt?.ts ?? 0}`}
              srcDoc={previewHtml}
              title="Live game preview"
              sandbox={SANDBOX_GAME_3D}
              className="h-full w-full border-0"
            />
            <div className="pointer-events-none absolute top-1 right-1 rounded-[var(--radius-sm)] bg-[var(--color-background-secondary)]/85 px-[6px] py-[1px] text-[10px] text-[var(--color-text-muted)]">
              Live preview · {previewUpdatedAt !== null ? 'fresh' : 'cached'}
            </div>
          </div>
        ) : null}
      </div>
      <Scene3DPrimitiveForm doc={doc} onChange={onChange} />
    </div>
  );
}

function colorForNodeType(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('wall')) return '#5a4a30';
  if (t.includes('floor') || t.includes('ground')) return '#2a382a';
  if (t.includes('prop')) return '#3a4a3a';
  if (t.includes('trigger')) return 'rgba(34,225,255,0.55)';
  if (t.includes('door') || t.includes('exit')) return '#22e1ff';
  if (t.includes('enemy') || t.includes('foe')) return '#ff7a7a';
  // Stable hash fallback.
  let h = 0;
  for (let i = 0; i < type.length; i += 1) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 35% 45%)`;
}

interface Projection {
  nodes: Array<{ id: string; x: number; y: number; size: number; type: string }>;
  spawns: Array<{ x: number; y: number; role: string }>;
  boundsRect: { x: number; y: number; w: number; h: number };
  viewBox: { x: number; y: number; w: number; h: number };
  strokeWidth: number;
  labelSize: number;
  spawnSize: number;
}

function projectScene(doc: Scene3DLevelDoc, plane: 'xz' | 'xy' | 'yz'): Projection {
  const pickXY = (p: [number, number, number]): [number, number] => {
    if (plane === 'xz') return [p[0], p[2]];
    if (plane === 'xy') return [p[0], -p[1]]; // flip Y so up renders up
    return [p[1], -p[2]];
  };
  const projectedNodes = doc.nodes.map((n) => {
    const [x, y] = pickXY(n.transform.position);
    const size = Math.max(0.3, Math.max(...n.transform.scale));
    return { id: n.id, x, y, size, type: n.type };
  });
  const projectedSpawns = doc.spawns.map((s) => {
    const [x, y] = pickXY(s.position);
    return { x, y, role: s.role };
  });
  const [bMinX, bMinY] = pickXY(doc.bounds.min);
  const [bMaxX, bMaxY] = pickXY(doc.bounds.max);
  const minX = Math.min(bMinX, bMaxX);
  const maxX = Math.max(bMinX, bMaxX);
  const minY = Math.min(bMinY, bMaxY);
  const maxY = Math.max(bMinY, bMaxY);
  const padX = Math.max(2, (maxX - minX) * 0.05);
  const padY = Math.max(2, (maxY - minY) * 0.05);
  const w = Math.max(8, maxX - minX + padX * 2);
  const h = Math.max(8, maxY - minY + padY * 2);
  const stroke = Math.max(0.05, Math.min(w, h) * 0.005);
  const labelSize = Math.max(1.5, Math.min(w, h) * 0.025);
  const spawnSize = Math.max(0.5, Math.min(w, h) * 0.012);
  return {
    nodes: projectedNodes,
    spawns: projectedSpawns,
    boundsRect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    viewBox: { x: minX - padX, y: minY - padY, w, h },
    strokeWidth: stroke,
    labelSize,
    spawnSize,
  };
}

function Scene3DPrimitiveForm({
  doc,
  onChange,
}: {
  doc: Scene3DLevelDoc;
  onChange: (next: Scene3DLevelDoc) => void;
}) {
  const setBounds = (axis: 'min' | 'max', idx: 0 | 1 | 2, value: number) => {
    const next: Scene3DLevelDoc = {
      ...doc,
      bounds: {
        ...doc.bounds,
        [axis]: doc.bounds[axis].map((v, i) => (i === idx ? value : v)) as [number, number, number],
      },
    };
    onChange(next);
  };
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] p-[var(--space-2)] text-[11px]">
      <div className="grid grid-cols-3 gap-[var(--space-2)]">
        {(['x', 'y', 'z'] as const).map((axis, idx) => (
          <BoundField
            key={`min-${axis}`}
            label={`min.${axis}`}
            value={doc.bounds.min[idx] ?? 0}
            onChange={(v) => setBounds('min', idx as 0 | 1 | 2, v)}
          />
        ))}
        {(['x', 'y', 'z'] as const).map((axis, idx) => (
          <BoundField
            key={`max-${axis}`}
            label={`max.${axis}`}
            value={doc.bounds.max[idx] ?? 0}
            onChange={(v) => setBounds('max', idx as 0 | 1 | 2, v)}
          />
        ))}
      </div>
      <div className="mt-[var(--space-2)] text-[10px] text-[var(--color-text-muted)]">
        Per-node transform editing via gizmo lands in Phase 8 polish. Edit nodes[] via the JSON
        fallback for now.
      </div>
    </div>
  );
}

function BoundField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-[2px]">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <input
        type="number"
        step="0.1"
        value={value}
        onChange={(e) => {
          const n = Number.parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
      />
    </label>
  );
}
