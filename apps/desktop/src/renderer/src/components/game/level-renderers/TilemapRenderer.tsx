import type { Tilemap2DLevelDoc } from '@open-codesign/shared';
import { Eraser, MousePointer2, Paintbrush } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * level-and-world-designer §Phase 5 — `tilemap-2d` renderer.
 *
 * Canvas-based grid view: draws layer tiles as colored cells (palette
 * derived from tile IDs deterministically), overlays entity/spawn
 * positions as glyphs. Fits the largest dimension to viewport with a
 * pixel-perfect zoom step. Read-first; tile-edit brushes are deferred
 * to Phase 8 polish.
 *
 * Schema-form panel below the canvas (Phase 3 SchemaForm) lets primitive
 * fields (size.cols/rows, tileSize, layer visibility/opacity, spawn
 * coordinates) be edited inline.
 */
type Tool = 'select' | 'paint' | 'erase';

export function TilemapRenderer({
  doc,
  onChange,
}: {
  doc: Tilemap2DLevelDoc;
  onChange: (next: Tilemap2DLevelDoc) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const visibleLayers = useMemo(
    () => doc.layers.filter((l) => l.visible).map((_, i) => i),
    [doc.layers],
  );
  // Phase 8.4 — paint brush state. activeTileId selects the tile that
  // gets painted on left-click; right-click always erases (sets to -1).
  // activeLayerIdx scopes mutations to a single layer so painting on
  // foreground doesn't disturb the background. Drag mutations batch
  // into a single onChange call when the pointer comes up so undo/redo
  // sees one ring entry per stroke, not per-tile.
  const [tool, setTool] = useState<Tool>('paint');
  const [activeTileId, setActiveTileId] = useState(0);
  const [activeLayerIdx, setActiveLayerIdx] = useState(0);
  const drawingRef = useRef<{ docDuringStroke: Tilemap2DLevelDoc; layerIdx: number } | null>(null);
  const lastPaintCellRef = useRef<{ x: number; y: number } | null>(null);

  // Clamp activeLayerIdx if the layer list shrinks.
  useEffect(() => {
    if (activeLayerIdx >= doc.layers.length) {
      setActiveLayerIdx(Math.max(0, doc.layers.length - 1));
    }
  }, [doc.layers.length, activeLayerIdx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const cell = Math.max(2, Math.round(doc.tileSize * zoom));
    const W = doc.size.cols * cell;
    const H = doc.size.rows * cell;
    canvas.width = W;
    canvas.height = H;
    // Background grid
    ctx.fillStyle = '#0a0e16';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= doc.size.cols; x += 1) {
      ctx.beginPath();
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, H);
      ctx.stroke();
    }
    for (let y = 0; y <= doc.size.rows; y += 1) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(W, y * cell + 0.5);
      ctx.stroke();
    }
    // Layers
    for (const li of visibleLayers) {
      const layer = doc.layers[li];
      if (!layer) continue;
      ctx.globalAlpha = layer.opacity;
      for (let y = 0; y < layer.tiles.length; y += 1) {
        const row = layer.tiles[y];
        if (!row) continue;
        for (let x = 0; x < row.length; x += 1) {
          const tile = row[x];
          if (typeof tile !== 'number' || tile < 0) continue;
          ctx.fillStyle = colorForTile(tile, li);
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
      ctx.globalAlpha = 1;
    }
    // Entities
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `${Math.max(8, cell * 0.6)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const e of doc.entities) {
      ctx.fillText('E', e.x * cell + cell / 2, e.y * cell + cell / 2);
    }
    // Spawns
    for (const s of doc.spawns) {
      ctx.fillStyle =
        s.role === 'player'
          ? '#7dffb1'
          : s.role === 'enemy'
            ? '#ff7a7a'
            : s.role === 'exit'
              ? '#22e1ff'
              : s.role === 'checkpoint'
                ? '#ffce42'
                : '#bff8ff';
      ctx.beginPath();
      ctx.arc(s.x * cell + cell / 2, s.y * cell + cell / 2, cell * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [doc, zoom, visibleLayers]);

  const cellPx = Math.max(2, Math.round(doc.tileSize * zoom));

  const cellAtEvent = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (canvas === null) return null;
      const rect = canvas.getBoundingClientRect();
      const cx = Math.floor((e.clientX - rect.left) / cellPx);
      const cy = Math.floor((e.clientY - rect.top) / cellPx);
      if (cx < 0 || cy < 0 || cx >= doc.size.cols || cy >= doc.size.rows) return null;
      return { x: cx, y: cy };
    },
    [cellPx, doc.size.cols, doc.size.rows],
  );

  const paintCell = useCallback(
    (cellX: number, cellY: number, tileId: number) => {
      const draft = drawingRef.current;
      if (draft === null) return;
      const layer = draft.docDuringStroke.layers[draft.layerIdx];
      if (!layer) return;
      // Defensive: backfill missing rows / columns to the declared size.
      const rows = ensureRect(layer.tiles, doc.size.rows, doc.size.cols);
      const row = rows[cellY];
      if (!row) return;
      if (row[cellX] === tileId) return; // no-op when unchanged
      row[cellX] = tileId;
      drawingRef.current = {
        ...draft,
        docDuringStroke: {
          ...draft.docDuringStroke,
          layers: draft.docDuringStroke.layers.map((l, i) =>
            i === draft.layerIdx ? { ...l, tiles: rows } : l,
          ),
        },
      };
    },
    [doc.size.cols, doc.size.rows],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === 'select') return;
    const cell = cellAtEvent(e);
    if (cell === null) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = { docDuringStroke: doc, layerIdx: activeLayerIdx };
    const tileId = tool === 'erase' || e.button === 2 ? -1 : activeTileId;
    paintCell(cell.x, cell.y, tileId);
    lastPaintCellRef.current = cell;
    // Force a re-render with the in-progress doc so the user sees the
    // stroke materialise. We commit on pointerup.
    onChange(drawingRef.current.docDuringStroke);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current === null) return;
    const cell = cellAtEvent(e);
    if (cell === null) return;
    if (lastPaintCellRef.current?.x === cell.x && lastPaintCellRef.current?.y === cell.y) {
      return;
    }
    const isErase = tool === 'erase' || (e.buttons & 2) !== 0;
    paintCell(cell.x, cell.y, isErase ? -1 : activeTileId);
    lastPaintCellRef.current = cell;
    onChange(drawingRef.current.docDuringStroke);
  };

  const finishStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onChange(drawingRef.current.docDuringStroke);
    drawingRef.current = null;
    lastPaintCellRef.current = null;
  };

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)] overflow-hidden">
      <div className="flex items-center gap-[var(--space-2)] text-[11px] text-[var(--color-text-muted)]">
        <span>
          {doc.size.cols}×{doc.size.rows} @ {doc.tileSize}px
        </span>
        <span className="opacity-50">·</span>
        <span>{doc.layers.length} layers</span>
        <span className="opacity-50">·</span>
        <span>{doc.entities.length} entities</span>
        <span className="opacity-50">·</span>
        <span>{doc.spawns.length} spawns</span>
        <div className="ml-auto flex items-center gap-[var(--space-1)]">
          <span>Zoom</span>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.5}
            value={zoom}
            onChange={(e) => setZoom(Number.parseFloat(e.target.value))}
            className="w-24"
            aria-label="Zoom"
          />
          <span className="tabular-nums">{(zoom * 100).toFixed(0)}%</span>
        </div>
      </div>
      <TilemapBrushBar
        tool={tool}
        onToolChange={setTool}
        activeTileId={activeTileId}
        onTileIdChange={setActiveTileId}
        layers={doc.layers.map((l) => l.name)}
        activeLayerIdx={activeLayerIdx}
        onLayerChange={setActiveLayerIdx}
      />
      <div className="flex flex-1 items-start justify-center overflow-auto rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] p-[var(--space-2)]">
        <canvas
          ref={canvasRef}
          aria-label="Tilemap preview"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onContextMenu={(e) => e.preventDefault()}
          className="image-render-pixelated"
          style={{
            imageRendering: 'pixelated',
            cursor: tool === 'paint' ? 'crosshair' : tool === 'erase' ? 'cell' : 'default',
          }}
        />
      </div>
      <TilemapPrimitiveForm doc={doc} onChange={onChange} />
    </div>
  );
}

function TilemapBrushBar({
  tool,
  onToolChange,
  activeTileId,
  onTileIdChange,
  layers,
  activeLayerIdx,
  onLayerChange,
}: {
  tool: Tool;
  onToolChange: (next: Tool) => void;
  activeTileId: number;
  onTileIdChange: (next: number) => void;
  layers: string[];
  activeLayerIdx: number;
  onLayerChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] p-[var(--space-2)] text-[11px]">
      <div className="inline-flex items-center gap-[2px]">
        {(
          [
            { id: 'select' as Tool, icon: MousePointer2, label: 'Select (no-op)' },
            { id: 'paint' as Tool, icon: Paintbrush, label: 'Paint tile' },
            { id: 'erase' as Tool, icon: Eraser, label: 'Erase tile' },
          ] as const
        ).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tool === id}
            aria-label={label}
            title={label}
            onClick={() => onToolChange(id)}
            className={`inline-flex items-center justify-center rounded-[var(--radius-sm)] p-[4px] ${
              tool === id
                ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ))}
      </div>
      <span className="opacity-50">·</span>
      <label className="inline-flex items-center gap-[var(--space-1)]">
        <span className="text-[var(--color-text-muted)]">Layer</span>
        <select
          value={activeLayerIdx}
          onChange={(e) => onLayerChange(Number.parseInt(e.target.value, 10))}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          {layers.map((name, i) => (
            <option key={`${name}-${i.toString()}`} value={i}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <span className="opacity-50">·</span>
      <label className="inline-flex items-center gap-[var(--space-1)]">
        <span className="text-[var(--color-text-muted)]">Tile id</span>
        <input
          type="number"
          value={activeTileId}
          min={-1}
          step={1}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (!Number.isNaN(n)) onTileIdChange(n);
          }}
          className="w-16 rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </label>
      <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
        Right-click erases · -1 = empty cell
      </span>
    </div>
  );
}

/** Defensive helper — when level.json's tiles[][] doesn't span the
 *  declared size (agent wrote a sparse map), fill in -1 so the brush
 *  has something to mutate. Returns a deep-copied 2D array. */
function ensureRect(tiles: number[][], rows: number, cols: number): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < rows; y += 1) {
    const src = tiles[y];
    const row = new Array<number>(cols).fill(-1);
    if (src) {
      for (let x = 0; x < Math.min(cols, src.length); x += 1) {
        const v = src[x];
        if (typeof v === 'number') row[x] = v;
      }
    }
    out.push(row);
  }
  return out;
}

function colorForTile(id: number, layerIdx: number): string {
  // Stable hash of (id, layerIdx) → HSL. Keeps the same id consistent
  // across renders + layers without a tileset palette.
  const h = (id * 137 + layerIdx * 53) % 360;
  const s = 45 + ((id * 13) % 30);
  const l = 30 + ((id * 7) % 25);
  return `hsl(${h} ${s}% ${l}%)`;
}

function TilemapPrimitiveForm({
  doc,
  onChange,
}: {
  doc: Tilemap2DLevelDoc;
  onChange: (next: Tilemap2DLevelDoc) => void;
}) {
  const setSize = (cols: number, rows: number) => {
    const next: Tilemap2DLevelDoc = {
      ...doc,
      size: { cols: Math.max(1, cols), rows: Math.max(1, rows) },
    };
    onChange(next);
  };
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] p-[var(--space-2)] text-[11px]">
      <div className="grid grid-cols-3 gap-[var(--space-2)]">
        <NumberField
          label="Cols"
          value={doc.size.cols}
          onChange={(v) => setSize(v, doc.size.rows)}
        />
        <NumberField
          label="Rows"
          value={doc.size.rows}
          onChange={(v) => setSize(doc.size.cols, v)}
        />
        <NumberField
          label="Tile size (px)"
          value={doc.tileSize}
          onChange={(v) => onChange({ ...doc, tileSize: Math.max(1, v) })}
        />
      </div>
      <div className="mt-[var(--space-2)] text-[10px] text-[var(--color-text-muted)]">
        Tile painting + layer reorder land in Phase 8 polish. Edit `tiles[][]` arrays via the JSON
        fallback for now.
      </div>
    </div>
  );
}

function NumberField({
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
        value={value}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background)] px-[var(--space-1)] py-[2px] text-[12px] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
      />
    </label>
  );
}
