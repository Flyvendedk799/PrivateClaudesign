/**
 * may9 Phase 5 — pointer-lock acquire helper with browser-cooldown
 * compliance.
 *
 * Chromium throws `SecurityError: Pointer lock cannot be acquired
 * immediately after the user has exited the lock` if you call
 * requestPointerLock() within ~1.25 s of an Escape-driven exit. The
 * FPS Wave Defense run on 2026-05-08 hit this at snapshot c71d437c
 * (defect D4 in docs/may9.md §0b) — the model's auto-reacquire on
 * pointermove crashed the page.
 *
 * This helper:
 *  - debounces re-acquire attempts by 1.25 s after a pointerlockchange
 *    that exited the lock
 *  - swallows synthesised errors with a console.warn the model can
 *    read on its next run
 *  - exposes a single `acquirePointerLock(canvas)` for engine
 *    bootstraps to import — keeps the model from re-deriving the
 *    timing rule incorrectly
 *
 * Engine guides reference this helper by URL (the agent loads the
 * `game-skills/<engine>/pointer-lock.md` snippet which embeds the call
 * site).
 */

const COOLDOWN_MS = 1250;

let lastExitAt = 0;
let inFlight = false;

function isLocked(target: Element): boolean {
  const doc = target.ownerDocument;
  return doc !== null && doc.pointerLockElement === target;
}

function trackExits(target: Element): void {
  const doc = target.ownerDocument;
  if (doc === null) return;
  const handler = () => {
    if (doc.pointerLockElement === null) {
      lastExitAt = Date.now();
    }
  };
  doc.addEventListener('pointerlockchange', handler);
}

let exitsTracked = false;

/**
 * Request pointer lock on `target` if the browser cooldown allows it.
 * Returns:
 *   - 'acquired' — lock requested successfully (the actual lock fires
 *     async via pointerlockchange; check document.pointerLockElement)
 *   - 'cooldown' — within the 1.25 s post-exit window; caller should
 *     retry on the next user gesture
 *   - 'already_locked' — target is the current lock target; nothing to
 *     do
 *   - 'rejected' — browser denied (sandbox, user cancel, focus lost);
 *     caller falls back to pointermove deltas
 */
export function acquirePointerLock(
  target: Element,
): 'acquired' | 'cooldown' | 'already_locked' | 'rejected' {
  if (!exitsTracked) {
    trackExits(target);
    exitsTracked = true;
  }
  if (isLocked(target)) return 'already_locked';
  const sinceExit = Date.now() - lastExitAt;
  if (sinceExit < COOLDOWN_MS) return 'cooldown';
  if (inFlight) return 'cooldown';
  inFlight = true;
  try {
    type LockableElement = Element & { requestPointerLock?: () => Promise<void> | void };
    const fn = (target as LockableElement).requestPointerLock;
    if (typeof fn !== 'function') {
      inFlight = false;
      return 'rejected';
    }
    const maybePromise = fn.call(target);
    if (maybePromise instanceof Promise) {
      maybePromise
        .catch(() => {
          // swallow — caller already informed by return state, and the
          // sandbox_probe handler picks this up via pointerlockchange
          // not firing.
        })
        .finally(() => {
          inFlight = false;
        });
    } else {
      inFlight = false;
    }
    return 'acquired';
  } catch {
    inFlight = false;
    return 'rejected';
  }
}

/** Reset the module's internal state. Test-only. */
export function __resetPointerLockState(): void {
  lastExitAt = 0;
  inFlight = false;
  exitsTracked = false;
}
