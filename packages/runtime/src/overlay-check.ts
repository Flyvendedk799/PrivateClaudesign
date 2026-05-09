/**
 * may9 Phase 8b follow-up #31 — DOM canvas-occlusion detector.
 *
 * Complement to the bytes-based destructive-edit advisory (which fires
 * on a 40%+ shrink). The HUD-eats-canvas regression class also
 * manifests STRUCTURALLY: a HUD div sits on top of the canvas with
 * inappropriate z-index / pointer-events / size such that the
 * `<canvas>` is mostly or fully occluded. Bytes-based check misses
 * this when the source size is comparable but the DOM structure
 * inverted.
 *
 * Engine bootstraps call `installOverlayCheck()` on first frame; the
 * helper walks the DOM, computes how much of the canvas is occluded
 * by absolutely-positioned overlays, and posts back to the host:
 *
 *     window.parent.postMessage({
 *       __codesign: true,
 *       type: 'overlay_warning',
 *       canvasArea: number,    // px²
 *       occludedArea: number,  // px²
 *       occludedRatio: number, // 0..1
 *       offenders: [{ selector, areaPx2, opacity }]
 *     }, '*');
 *
 * The host's verify_artifact path picks up the signal and surfaces it
 * to the agent. Threshold: ratio > 0.6 reads as "HUD ate the canvas".
 */

export interface OverlayCheckOffender {
  /** A best-effort CSS-selector-style identifier for the offending
   *  element. Tag + classList[0] is usually enough to spot the issue. */
  selector: string;
  /** Pixel² area the offender covers within the canvas's bounding box. */
  areaPx2: number;
  /** Computed opacity at check time. Pure 0 means fully transparent
   *  (false positive — visual elements with opacity:0 don't actually
   *  occlude even if they're absolutely positioned over the canvas). */
  opacity: number;
}

export interface OverlayCheckResult {
  canvasArea: number;
  occludedArea: number;
  occludedRatio: number;
  offenders: OverlayCheckOffender[];
}

const OCCLUDED_RATIO_THRESHOLD = 0.6;

/** Pure compute. Exposed for unit tests; production calls
 *  `installOverlayCheck` which reads the DOM + posts back. */
export function computeOverlay(
  canvasRect: { left: number; top: number; width: number; height: number },
  candidates: ReadonlyArray<{
    rect: { left: number; top: number; width: number; height: number };
    selector: string;
    opacity: number;
  }>,
): OverlayCheckResult {
  const canvasArea = Math.max(0, canvasRect.width * canvasRect.height);
  if (canvasArea <= 0) {
    return { canvasArea: 0, occludedArea: 0, occludedRatio: 0, offenders: [] };
  }
  const offenders: OverlayCheckOffender[] = [];
  let occludedArea = 0;
  for (const c of candidates) {
    if (c.opacity <= 0) continue; // Fully transparent — does not occlude.
    // Intersection of canvas + candidate rectangles.
    const ix0 = Math.max(canvasRect.left, c.rect.left);
    const iy0 = Math.max(canvasRect.top, c.rect.top);
    const ix1 = Math.min(canvasRect.left + canvasRect.width, c.rect.left + c.rect.width);
    const iy1 = Math.min(canvasRect.top + canvasRect.height, c.rect.top + c.rect.height);
    const w = ix1 - ix0;
    const h = iy1 - iy0;
    if (w <= 0 || h <= 0) continue;
    const areaPx2 = w * h;
    occludedArea += areaPx2;
    offenders.push({ selector: c.selector, areaPx2, opacity: c.opacity });
  }
  // Cap at canvasArea: overlapping offenders shouldn't push the ratio > 1.
  const cappedOccluded = Math.min(canvasArea, occludedArea);
  return {
    canvasArea,
    occludedArea: cappedOccluded,
    occludedRatio: cappedOccluded / canvasArea,
    offenders: offenders.sort((a, b) => b.areaPx2 - a.areaPx2),
  };
}

/** Return true when the result exceeds the documented "HUD ate the
 *  canvas" threshold. */
export function isOverlayTriggered(result: OverlayCheckResult): boolean {
  return result.occludedRatio > OCCLUDED_RATIO_THRESHOLD;
}

/** Walk the document and collect everything that's a candidate overlay:
 *  position fixed/absolute, non-zero size, NOT a descendant of the
 *  canvas itself. Engine bootstraps inside the iframe call this on
 *  first frame. */
function collectOverlayCandidates(canvas: Element): Array<{
  rect: { left: number; top: number; width: number; height: number };
  selector: string;
  opacity: number;
}> {
  const out: Array<{
    rect: { left: number; top: number; width: number; height: number };
    selector: string;
    opacity: number;
  }> = [];
  const all = document.querySelectorAll<HTMLElement>('body *');
  for (const el of all) {
    if (el === canvas) continue;
    if (canvas.contains(el)) continue;
    if (el.contains(canvas)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const tag = el.tagName.toLowerCase();
    const cls = el.classList[0] ?? '';
    out.push({
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      selector: cls ? `${tag}.${cls}` : tag,
      opacity: Number.parseFloat(cs.opacity || '1') || 1,
    });
  }
  return out;
}

/** Install the overlay check on the iframe's window. Engine bootstraps
 *  call this once after `__game.ready` fires. The check posts back to
 *  window.parent only when `isOverlayTriggered` returns true; silent
 *  in the happy path so the postMessage channel doesn't get noisy.
 *
 *  Returns the result so callers can also act locally (e.g. log to
 *  the iframe's console for debugging). */
export function runOverlayCheck(): OverlayCheckResult | null {
  const canvas = document.querySelector('canvas');
  if (canvas === null) return null;
  const cr = canvas.getBoundingClientRect();
  const candidates = collectOverlayCandidates(canvas);
  const result = computeOverlay(
    { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
    candidates,
  );
  if (isOverlayTriggered(result)) {
    try {
      window.parent.postMessage(
        {
          __codesign: true,
          type: 'overlay_warning',
          ...result,
        },
        '*',
      );
    } catch {
      // postMessage to a cross-origin parent can throw; skip silently.
    }
  }
  return result;
}

/** Convenience scheduler: run the check once after first frame, then
 *  again 1.5 s later (catches HUDs that mount asynchronously after
 *  initial render). Engines that mount HUDs lazily can call
 *  `runOverlayCheck()` directly instead. */
export function installOverlayCheck(): void {
  const fire = (): void => {
    runOverlayCheck();
  };
  if (document.readyState === 'complete') {
    requestAnimationFrame(fire);
  } else {
    window.addEventListener('load', () => requestAnimationFrame(fire), { once: true });
  }
  setTimeout(fire, 1500);
}
