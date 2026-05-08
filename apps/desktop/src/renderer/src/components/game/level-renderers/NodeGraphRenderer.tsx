import type { NodeGraphLevelDoc } from '@open-codesign/shared';
import { useMemo, useState } from 'react';
import { computeForceLayout } from './forceLayout';

/**
 * level-and-world-designer §Phase 5 — `node-graph` renderer.
 *
 * SVG-based graph view. Nodes are positioned by their declared
 * `position` field; edges drawn as bezier curves between them. Avoids
 * pulling cytoscape into the renderer bundle (it's heavy and the
 * graph layouts here are typically authored, not auto-laid-out).
 *
 * Read-first; edge drawing + node moving land in Phase 8 polish (or
 * earlier if a user pushes for it). Editing today: the JSON fallback
 * via the schema-mismatch banner if needed, plus the start-node
 * picker below.
 */
export function NodeGraphRenderer({
  doc,
  onChange,
}: {
  doc: NodeGraphLevelDoc;
  onChange: (next: NodeGraphLevelDoc) => void;
}) {
  const [layoutMode, setLayoutMode] = useState<'declared' | 'force'>('declared');
  const layout = useMemo(() => layoutGraph(doc, layoutMode), [doc, layoutMode]);

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)] overflow-hidden">
      <div className="flex items-center gap-[var(--space-2)] text-[11px] text-[var(--color-text-muted)]">
        <span>{doc.nodes.length} nodes</span>
        <span className="opacity-50">·</span>
        <span>{doc.edges.length} edges</span>
        {doc.startNodeId !== null ? (
          <>
            <span className="opacity-50">·</span>
            <span>start: {doc.startNodeId}</span>
          </>
        ) : null}
        <div className="ml-auto inline-flex items-center gap-[2px]">
          <span className="text-[var(--color-text-muted)]">Layout</span>
          {(['declared', 'force'] as const).map((m) => (
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
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] p-[var(--space-2)]">
        <svg
          viewBox={`${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.w} ${layout.viewBox.h}`}
          className="h-full w-full"
          preserveAspectRatio="xMidYMid meet"
          aria-label="Node graph preview"
        >
          <defs>
            <marker
              id="arrow"
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
          {doc.edges.map((edge) => {
            const from = layout.nodeIndex.get(edge.from);
            const to = layout.nodeIndex.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const len = Math.max(1, Math.hypot(dx, dy));
            const nx = -dy / len;
            const ny = dx / len;
            const cx = (from.x + to.x) / 2 + nx * len * 0.18;
            const cy = (from.y + to.y) / 2 + ny * len * 0.18;
            return (
              <g key={edge.id}>
                <path
                  d={`M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`}
                  fill="none"
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth={layout.strokeWidth}
                  markerEnd="url(#arrow)"
                />
                {edge.label !== undefined && edge.label.length > 0 ? (
                  <text
                    x={cx}
                    y={cy - layout.labelSize * 0.5}
                    fontSize={layout.labelSize}
                    textAnchor="middle"
                    fill="rgba(255,255,255,0.6)"
                  >
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          {doc.nodes.map((node) => {
            const pt = layout.nodeIndex.get(node.id);
            if (pt === undefined) return null;
            const isStart = doc.startNodeId === node.id;
            return (
              <g key={node.id}>
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
                >
                  {(node.label ?? node.type).slice(0, 14)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <NodeGraphPrimitiveForm doc={doc} onChange={onChange} />
    </div>
  );
}

function layoutGraph(
  doc: NodeGraphLevelDoc,
  mode: 'declared' | 'force',
): {
  nodeIndex: Map<string, { x: number; y: number }>;
  viewBox: { x: number; y: number; w: number; h: number };
  nodeRadius: number;
  strokeWidth: number;
  labelSize: number;
} {
  if (doc.nodes.length === 0) {
    return {
      nodeIndex: new Map(),
      viewBox: { x: 0, y: 0, w: 100, h: 100 },
      nodeRadius: 4,
      strokeWidth: 0.4,
      labelSize: 4,
    };
  }
  let positions: Array<{ id: string; x: number; y: number }>;
  if (mode === 'force') {
    const computed = computeForceLayout(
      doc.nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      doc.edges.map((e) => ({ from: e.from, to: e.to })),
      { size: 800 },
    );
    positions = doc.nodes.map((n) => {
      const p = computed.get(n.id) ?? { x: 0, y: 0 };
      return { id: n.id, x: p.x, y: p.y };
    });
  } else {
    positions = doc.nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
  }
  let minX = positions[0]?.x ?? 0;
  let maxX = minX;
  let minY = positions[0]?.y ?? 0;
  let maxY = minY;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(40, maxX - minX);
  const h = Math.max(40, maxY - minY);
  const padX = Math.max(20, w * 0.15);
  const padY = Math.max(20, h * 0.15);
  const nodeRadius = Math.max(6, Math.min(w, h) * 0.04);
  const strokeWidth = Math.max(0.5, nodeRadius * 0.12);
  const labelSize = Math.max(6, nodeRadius * 0.55);
  const idx = new Map(positions.map((p) => [p.id, { x: p.x, y: p.y }] as const));
  return {
    nodeIndex: idx,
    viewBox: { x: minX - padX, y: minY - padY, w: w + padX * 2, h: h + padY * 2 },
    nodeRadius,
    strokeWidth,
    labelSize,
  };
}

function NodeGraphPrimitiveForm({
  doc,
  onChange,
}: {
  doc: NodeGraphLevelDoc;
  onChange: (next: NodeGraphLevelDoc) => void;
}) {
  const setStart = (id: string) => {
    onChange({ ...doc, startNodeId: id === '' ? null : id });
  };
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] p-[var(--space-2)] text-[11px]">
      <label className="flex flex-col gap-[2px]">
        <span className="text-[var(--color-text-muted)]">Start node</span>
        <select
          value={doc.startNodeId ?? ''}
          onChange={(e) => setStart(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          <option value="">—</option>
          {doc.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label ?? n.id}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-[var(--space-2)] text-[10px] text-[var(--color-text-muted)]">
        Drag-to-move + edge-draw land in Phase 8 polish. Edit nodes[] / edges[] via the JSON
        fallback for now.
      </div>
    </div>
  );
}
