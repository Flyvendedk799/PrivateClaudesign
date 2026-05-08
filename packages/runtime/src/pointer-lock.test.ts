/**
 * may9 Phase 5 — pointer-lock cooldown unit tests.
 *
 * Covers the FPS Wave Defense regression: rapid re-acquire after Esc
 * must not throw a SecurityError (we simulate by checking the helper
 * returns 'cooldown' instead of attempting the request).
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPointerLockState, acquirePointerLock } from './pointer-lock';

describe('acquirePointerLock', () => {
  beforeEach(() => {
    __resetPointerLockState();
    document.body.innerHTML = '<canvas id="game" tabindex="0"></canvas>';
  });
  afterEach(() => {
    __resetPointerLockState();
  });

  it("returns 'rejected' when the element has no requestPointerLock", () => {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    // jsdom does not implement requestPointerLock — it should be undefined.
    type LockableCanvas = HTMLCanvasElement & { requestPointerLock?: () => void };
    expect((canvas as LockableCanvas).requestPointerLock).toBeUndefined();
    expect(acquirePointerLock(canvas)).toBe('rejected');
  });

  it("returns 'acquired' when the element exposes requestPointerLock", () => {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const stub = vi.fn(() => Promise.resolve());
    (canvas as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = stub;
    expect(acquirePointerLock(canvas)).toBe('acquired');
    expect(stub).toHaveBeenCalledOnce();
  });

  it("returns 'cooldown' if called within 1.25s of an exit", () => {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const stub = vi.fn(() => Promise.resolve());
    (canvas as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = stub;
    // First call subscribes to pointerlockchange.
    acquirePointerLock(canvas);
    stub.mockClear();
    // Simulate an exit (Esc): pointerLockElement -> null + dispatch event.
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: null });
    document.dispatchEvent(new Event('pointerlockchange'));
    // Second call within cooldown must NOT request the lock.
    expect(acquirePointerLock(canvas)).toBe('cooldown');
    expect(stub).not.toHaveBeenCalled();
  });

  it("returns 'already_locked' when pointerLockElement is the target", () => {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const stub = vi.fn(() => Promise.resolve());
    (canvas as unknown as { requestPointerLock: () => Promise<void> }).requestPointerLock = stub;
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: canvas });
    expect(acquirePointerLock(canvas)).toBe('already_locked');
    expect(stub).not.toHaveBeenCalled();
  });
});
