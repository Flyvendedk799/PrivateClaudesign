/**
 * level-and-world-designer §Phase 8.6 — pure-JS force-directed layout
 * for graph-shaped views (NodeGraphRenderer + WorldDesignerTabView).
 *
 * Avoids pulling cytoscape (~100 KB minified) into the renderer
 * bundle — graphs in this app are typically <50 nodes, so a simple
 * spring + repulsion simulation runs to convergence in <100 iterations
 * without breaking a sweat. Deterministic seeding (jitter is derived
 * from node id hash) so repeated layouts produce the same picture.
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface ForceLayoutOptions {
  iterations?: number;
  /** Spring constant for connected node pairs. Higher = tighter. */
  springK?: number;
  /** Resting length of edges. */
  springLen?: number;
  /** Coulomb-style repulsion constant. Higher = nodes repel more. */
  repulsion?: number;
  /** Damping factor applied to velocity each step. */
  damping?: number;
  /** Output bounding-box size (the layout fits inside [0, size]²). */
  size?: number;
}

/**
 * Run a Fruchterman-Reingold-ish layout on the given graph and return
 * a Map<id, {x, y}>. Pure: no DOM, no requestAnimationFrame — call
 * once, render the result. Re-run when node/edge counts change.
 */
export function computeForceLayout(
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  options: ForceLayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const iterations = options.iterations ?? 200;
  const springK = options.springK ?? 0.08;
  const springLen = options.springLen ?? 120;
  const repulsion = options.repulsion ?? 8000;
  const damping = options.damping ?? 0.85;
  const size = options.size ?? 800;

  if (nodes.length === 0) return new Map();
  if (nodes.length === 1) {
    const single = nodes[0];
    if (!single) return new Map();
    return new Map([[single.id, { x: size / 2, y: size / 2 }]]);
  }

  // Seed positions: existing x/y if non-zero, else jittered grid based
  // on a stable hash of the id so re-runs reproduce.
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (!n) continue;
    const seed = hashStr(n.id);
    const initX = n.x !== 0 ? n.x : ((seed % 1000) / 1000) * size;
    const initY = n.y !== 0 ? n.y : (((seed >>> 10) % 1000) / 1000) * size;
    positions.set(n.id, { x: initX, y: initY, vx: 0, vy: 0 });
  }

  for (let it = 0; it < iterations; it += 1) {
    // Repulsion (n²)
    for (const a of positions.values()) {
      let fx = 0;
      let fy = 0;
      for (const b of positions.values()) {
        if (a === b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 0.01) continue;
        const d = Math.sqrt(d2);
        const f = repulsion / d2;
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }
      a.vx = (a.vx + fx) * damping;
      a.vy = (a.vy + fy) * damping;
    }
    // Springs (edges)
    for (const e of edges) {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (a === undefined || b === undefined) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.01) continue;
      const f = springK * (d - springLen);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    // Integrate
    for (const p of positions.values()) {
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  // Recenter into [0, size]²
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of positions.values()) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const scaleX = (size * 0.85) / w;
  const scaleY = (size * 0.85) / h;
  const scale = Math.min(scaleX, scaleY);
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of positions.entries()) {
    out.set(id, {
      x: (p.x - minX) * scale + size * 0.075,
      y: (p.y - minY) * scale + size * 0.075,
    });
  }
  return out;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
