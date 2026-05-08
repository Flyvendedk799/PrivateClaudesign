import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * level-and-world-designer §Phase 8.3 — undo/redo ring buffer hook
 * shared across the five level renderers + the world designer.
 *
 * Pattern: each renderer is a controlled component receiving a `doc`
 * and an `onChange(next)` callback. Wrap that flow with this hook so
 * cmd-z rewinds the doc to the previous snapshot, cmd-shift-z replays
 * forward. The hook owns its own "live" copy of the document; the
 * outer save-debounced onChange is invoked only when the user
 * actually mutates (push), not on undo/redo (which restore from the
 * ring without re-pushing).
 *
 * The ring buffer is bounded so a long editing session doesn't grow
 * memory unbounded — `maxEntries` defaults to 64 which is roughly
 * 5-10 minutes of active editing for a typical level doc.
 */
export interface DocHistory<T> {
  /** The currently-displayed value. Renderers bind their visual state
   *  to this — when the user hits cmd-z, this flips to the previous
   *  snapshot and the renderer re-paints. */
  value: T;
  /** True iff there is at least one snapshot before `value`. */
  canUndo: boolean;
  /** True iff there is at least one snapshot after `value`. */
  canRedo: boolean;
  /** Push a new snapshot. Truncates any redo tail. */
  push: (next: T) => void;
  /** Replace the value WITHOUT pushing a snapshot. Used when the
   *  outer doc changes for non-edit reasons (e.g. another tab wrote
   *  the file, or the user switched levels). */
  replace: (next: T) => void;
  /** Move one step backward in history. No-op when canUndo is false. */
  undo: () => void;
  /** Move one step forward in history. No-op when canRedo is false. */
  redo: () => void;
}

export function useDocHistory<T>(initial: T, maxEntries = 64): DocHistory<T> {
  const [stack, setStack] = useState<T[]>(() => [initial]);
  const [index, setIndex] = useState(0);
  const initialRef = useRef(initial);

  // When the upstream doc changes (e.g. file reload after the agent
  // edited it), reset history. Use referential identity rather than
  // deep equality so we don't accidentally clobber an in-progress
  // edit just because someone re-rendered the parent.
  useEffect(() => {
    if (Object.is(initialRef.current, initial)) return;
    initialRef.current = initial;
    setStack([initial]);
    setIndex(0);
  }, [initial]);

  const value = stack[index] ?? initial;
  const canUndo = index > 0;
  const canRedo = index < stack.length - 1;

  const push = useCallback(
    (next: T) => {
      setStack((prev) => {
        const prefix = prev.slice(0, index + 1);
        const trimmed =
          prefix.length >= maxEntries ? prefix.slice(prefix.length - maxEntries + 1) : prefix;
        return [...trimmed, next];
      });
      setIndex((i) => Math.min(i + 1, maxEntries - 1));
    },
    [index, maxEntries],
  );

  const replace = useCallback((next: T) => {
    setStack([next]);
    setIndex(0);
    initialRef.current = next;
  }, []);

  const undo = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const redo = useCallback(() => {
    setIndex((i) => Math.min(stack.length - 1, i + 1));
  }, [stack.length]);

  // cmd-z / cmd-shift-z keybindings while the renderer is mounted.
  // Confined to the active focus ring (we listen on document but skip
  // events inside <input> / <textarea> / <select> / contentEditable
  // so renderer's own form inputs keep native browser undo).
  useEffect(() => {
    function isFormElement(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent): void {
      if (isFormElement(e.target)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return useMemo(
    () => ({
      value,
      canUndo,
      canRedo,
      push,
      replace,
      undo,
      redo,
    }),
    [value, canUndo, canRedo, push, replace, undo, redo],
  );
}
