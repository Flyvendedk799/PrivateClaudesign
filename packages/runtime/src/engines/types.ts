/**
 * gameplan §7.1 — engine adapter types.
 *
 * Kept in a separate file so adapters can `import type` from here without
 * pulling in the registry side-effects in the entry module.
 */

export type GameEngineId = 'three' | 'phaser' | 'pygame' | 'godot' | 'unity';

export interface BootstrapOptions {
  /** UUID of the design row this game belongs to. Used to build the
   *  game-files:// base URL the iframe resolves relative imports against. */
  designId: string;
  /** Fully-qualified base URL — `game-files://designs/{designId}/`. The
   *  starter template injects this as `<base href>`. */
  gameBaseUrl: string;
  /** Optional engine version override. Falls back to `adapter.defaultVersion`. */
  pinnedVersion?: string | undefined;
  /** When true, the bootstrap injects `window.__game.config.startMuted = true`
   *  so engines can avoid the autoplay-policy warning on first preview. */
  startMuted?: boolean | undefined;
  /** Initial values for `window.__game.params`. Subsequent live tweaks
   *  arrive via postMessage `{ type: 'game:setParams', params }`. */
  initialParams?: Record<string, unknown> | undefined;
}

export interface ValidationIssue {
  path: string;
  line?: number | undefined;
  message: string;
  severity: 'error' | 'warn';
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export interface InputFile {
  path: string;
  content: string;
}

export interface GameEngineAdapter {
  /** Identifier matching design_snapshots.engine. */
  readonly id: GameEngineId;
  /** Human-readable label for UI surfaces. */
  readonly label: string;
  /** Pinned default engine version (gameplan §1, Appendix). */
  readonly defaultVersion: string;
  /** The single entry-point file the runtime expects when previewing or
   *  exporting. `index.html` for the JS engines, `main.py` for Pygame,
   *  `project.godot` for Godot. */
  readonly canonicalEntry: string;
  /** Lowercase file extensions (no leading dot) the engine guide tells the
   *  agent to author. Used by validators + the path-aware byte-cap helper. */
  readonly fileExtensions: readonly string[];

  /** Returns the starter HTML/scaffolding the agent should `text_editor.create`
   *  as the project's `canonicalEntry`. For the JS engines this is a full
   *  index.html with the engine ESM import-map and the `__game` global shim;
   *  for Pygame this is a `main.py` template; for Godot a `project.godot`
   *  + `main.tscn` template. The agent may then iterate via str_replace. */
  bootstrap(opts: BootstrapOptions): string;

  /** True when the engine produces a runnable iframe preview today. Phase A:
   *  three + phaser are true; pygame is false until C; godot is false until D. */
  supportsLivePreview(): boolean;

  /** Engine-specific lint over the current file bundle. Called by the
   *  `validate_game_scene` tool before `done`. Implementation may be regex-
   *  level for v1 — no AST dep — and is upgraded later as needed. */
  validate(files: ReadonlyArray<InputFile>): ValidationResult;
}

/** Snippet shared by all JS-engine bootstraps — sets up `window.__game` with
 *  the cross-engine tweak bridge described in gameplan §7.3 and the playtest
 *  debug contract used by `playtest_game`. Receives encoded JSON of the
 *  engine id + initial params + startMuted hint.
 *
 *  The `__game.debug.snapshot()` default returns `null`; agents are expected
 *  to override with a small getter that exposes whatever fields the
 *  playtest scenario asserts on (player position, angle, hp, score, …).
 *  Keeping the default in the bootstrap means `playtest_game` never throws
 *  on missing-symbol — it surfaces a `no_debug_contract` outcome instead. */
export function gameGlobalSetupSnippet(opts: {
  engine: GameEngineId;
  initialParams: Record<string, unknown>;
  startMuted: boolean;
}): string {
  const params = JSON.stringify(opts.initialParams);
  const config = JSON.stringify({ startMuted: opts.startMuted, initialAspect: '16:9' });
  return `<script>
window.__game = window.__game || {};
window.__game.engine = ${JSON.stringify(opts.engine)};
window.__game.params = ${params};
window.__game.config = ${config};
window.__game.debug = window.__game.debug || { snapshot: function () { return null; } };
window.addEventListener('message', function (e) {
  if (e && e.data && e.data.type === 'game:setParams' && e.data.params) {
    Object.assign(window.__game.params, e.data.params);
    window.dispatchEvent(new CustomEvent('game:params-changed', { detail: e.data.params }));
  }
});
</script>`;
}
