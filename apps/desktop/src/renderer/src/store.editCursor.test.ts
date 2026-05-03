/**
 * Verifies the editCursor slice that drives the follow-the-edit overlay.
 *
 * The slice is keyed by `key`, which the overlay component watches to
 * re-trigger CSS animations when consecutive edits land on the same DOM
 * element. The expiresAt clock means a stalled run (no further edits) doesn't
 * leave a stale halo on the preview.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useCodesignStore } from './store';

const initial = useCodesignStore.getState();

beforeEach(() => {
  useCodesignStore.setState({ ...initial, editCursor: null });
});

describe('editCursor slice', () => {
  it('starts null and is unset by default', () => {
    expect(useCodesignStore.getState().editCursor).toBeNull();
  });

  it('setEditCursor populates the slice with line range, label, and a fresh key', () => {
    useCodesignStore.getState().setEditCursor({
      toolLabel: 'Editing line 42',
      startLine: 42,
      endLine: 42,
    });
    const cursor = useCodesignStore.getState().editCursor;
    expect(cursor).not.toBeNull();
    expect(cursor?.toolLabel).toBe('Editing line 42');
    expect(cursor?.startLine).toBe(42);
    expect(cursor?.endLine).toBe(42);
    expect(cursor?.key).toBeGreaterThan(0);
    // expiresAt is in the future relative to performance.now() at call time.
    expect(cursor?.expiresAt).toBeGreaterThan(performance.now());
  });

  it('bumps key on each subsequent set so the overlay can retrigger animation', () => {
    const { setEditCursor } = useCodesignStore.getState();
    setEditCursor({ toolLabel: 'a', startLine: 1, endLine: 5 });
    const firstKey = useCodesignStore.getState().editCursor?.key;
    setEditCursor({ toolLabel: 'b', startLine: 1, endLine: 5 });
    const secondKey = useCodesignStore.getState().editCursor?.key;
    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    expect(secondKey).toBeGreaterThan(firstKey ?? 0);
  });

  it('clearEditCursor resets the slice to null', () => {
    useCodesignStore.getState().setEditCursor({
      toolLabel: 'x',
      startLine: 10,
      endLine: 20,
    });
    expect(useCodesignStore.getState().editCursor).not.toBeNull();
    useCodesignStore.getState().clearEditCursor();
    expect(useCodesignStore.getState().editCursor).toBeNull();
  });

  it('clearEditCursor on already-null slice is a no-op (does not trigger a new state object)', () => {
    expect(useCodesignStore.getState().editCursor).toBeNull();
    const before = useCodesignStore.getState();
    useCodesignStore.getState().clearEditCursor();
    const after = useCodesignStore.getState();
    // editCursor stays null; the action's early-return guard avoids a redundant set.
    expect(after.editCursor).toBeNull();
    expect(after).toBe(before);
  });

  it('formats range labels for multi-line edits', () => {
    // The label is formatted by the caller (useAgentStream), but the slice
    // happily holds whatever string is passed — verify both shapes survive.
    useCodesignStore.getState().setEditCursor({
      toolLabel: 'Editing lines 412-419',
      startLine: 412,
      endLine: 419,
    });
    const cursor = useCodesignStore.getState().editCursor;
    expect(cursor?.toolLabel).toBe('Editing lines 412-419');
    expect(cursor?.startLine).toBe(412);
    expect(cursor?.endLine).toBe(419);
  });
});
