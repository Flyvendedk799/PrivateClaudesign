/**
 * may9 Phase 8b follow-up #31 — overlay-check pure-compute tests.
 *
 * The DOM-walking path is exercised manually via pnpm dev (same
 * pattern as render-preview.ts / done-verify.ts) — vitest covers the
 * pure intersection math which is where the off-by-one risks live.
 */
import { describe, expect, it } from 'vitest';
import { computeOverlay, isOverlayTriggered } from './overlay-check';

const fullCanvas = { left: 0, top: 0, width: 1280, height: 720 };

describe('computeOverlay', () => {
  it('returns 0 occlusion when there are no candidates', () => {
    const r = computeOverlay(fullCanvas, []);
    expect(r.occludedArea).toBe(0);
    expect(r.occludedRatio).toBe(0);
    expect(r.offenders).toEqual([]);
  });

  it('returns 0 when canvas area is 0 (degenerate)', () => {
    const r = computeOverlay({ left: 0, top: 0, width: 0, height: 0 }, []);
    expect(r.canvasArea).toBe(0);
    expect(r.occludedRatio).toBe(0);
  });

  it('computes the FPS HUD-eats-canvas regression case', () => {
    // Replays the May-8 a3d4afd7 shape: a HUD div that covers ~80%
    // of the canvas. occludedRatio > threshold should flag.
    const r = computeOverlay(fullCanvas, [
      {
        rect: { left: 0, top: 0, width: 1280, height: 600 }, // 83% coverage
        selector: 'div.holo-hud',
        opacity: 1,
      },
    ]);
    expect(r.occludedRatio).toBeGreaterThan(0.6);
    expect(isOverlayTriggered(r)).toBe(true);
    expect(r.offenders[0]?.selector).toBe('div.holo-hud');
  });

  it('does not trigger on small overlays (score, FPS counter)', () => {
    const r = computeOverlay(fullCanvas, [
      {
        rect: { left: 1100, top: 10, width: 160, height: 40 }, // tiny corner badge
        selector: 'div.score',
        opacity: 1,
      },
      {
        rect: { left: 10, top: 10, width: 80, height: 24 }, // FPS counter
        selector: 'div.fps',
        opacity: 0.8,
      },
    ]);
    expect(r.occludedRatio).toBeLessThan(0.6);
    expect(isOverlayTriggered(r)).toBe(false);
  });

  it('skips opacity:0 elements (they do not occlude visually)', () => {
    const r = computeOverlay(fullCanvas, [
      {
        rect: { left: 0, top: 0, width: 1280, height: 720 },
        selector: 'div.invisible',
        opacity: 0,
      },
    ]);
    expect(r.occludedArea).toBe(0);
    expect(r.offenders).toEqual([]);
  });

  it('caps occluded ratio at 1.0 even when offenders overlap', () => {
    // Two divs each covering 100% of canvas - naive sum would be 200%
    const r = computeOverlay(fullCanvas, [
      {
        rect: { left: 0, top: 0, width: 1280, height: 720 },
        selector: 'div.a',
        opacity: 1,
      },
      {
        rect: { left: 0, top: 0, width: 1280, height: 720 },
        selector: 'div.b',
        opacity: 1,
      },
    ]);
    expect(r.occludedRatio).toBe(1);
  });

  it('clips offenders to the canvas bounds (off-screen overhang ignored)', () => {
    // Overlay extends past right + bottom of canvas; only the
    // intersection inside fullCanvas should count.
    const r = computeOverlay(fullCanvas, [
      {
        rect: { left: 1000, top: 500, width: 600, height: 400 },
        selector: 'div.hud',
        opacity: 1,
      },
    ]);
    // Intersection: left 1000..1280 (280) × top 500..720 (220) = 61_600
    expect(r.occludedArea).toBe(280 * 220);
  });
});
