/**
 * may9 Phase 4 — module-scope cache of the latest GameSpec a game run
 * declared (or amended), keyed by designId.
 *
 * Lives in its own file so both `index.ts` (writer) and `snapshots-ipc.ts`
 * (reader) can import it without `snapshots-ipc.ts` pulling the
 * Electron-bound side-effects in `index.ts` into vitest module-load.
 *
 * The agent's per-run mutable publishes here on declare_game_spec /
 * amend_game_spec; snapshots-ipc reads at createSnapshot time and forwards
 * `specJson` to the writer so the spec lives in
 * `design_snapshots.spec_json` across edits.
 *
 * Entries are not auto-pruned (a design's last-seen spec is cheap to
 * keep). A follow-up could LRU-evict on app idle.
 */
import type { GameSpec } from '@open-codesign/shared';

const lastSeenGameSpecByDesign = new Map<string, GameSpec>();

/** Publish the latest spec for a designId. The agent's gameMode IIFE
 *  calls this on declare_game_spec / amend_game_spec. */
export function setLastSeenGameSpec(designId: string, spec: GameSpec): void {
  lastSeenGameSpecByDesign.set(designId, spec);
}

/** Read the latest GameSpec for a designId, or null when none recorded.
 *  snapshots-ipc consults this to splice `specJson` into
 *  SnapshotCreateInput on every createSnapshot call. */
export function getLastSeenGameSpec(designId: string): GameSpec | null {
  return lastSeenGameSpecByDesign.get(designId) ?? null;
}

/** Test-only escape hatch: drop all cached specs. Production paths
 *  never call this (entries are cheap to keep across designs). */
export function _resetLastSeenGameSpecsForTests(): void {
  lastSeenGameSpecByDesign.clear();
}
