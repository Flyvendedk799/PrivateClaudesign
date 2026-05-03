/**
 * gameplan §D — process-shared map of designId → on-disk build directory.
 *
 * The web-build IPC writes Godot's web export into a per-design temp dir
 * and registers that dir here. The `game-files://` protocol handler then
 * reads from it when serving `_build/{path}` requests.
 *
 * Plain in-memory map; resets on app restart. That's intentional — the
 * temp dirs themselves get cleaned by the OS, and rebuilding a Godot web
 * preview is fast (3-6s warm cache).
 */

const BUILD_DIRS = new Map<string, string>();

/** Set the build dir for a design. Called by the web-build IPC after a
 *  successful `godot --headless --export-release Web` run. */
export function setGodotWebBuildDir(designId: string, buildDir: string): void {
  BUILD_DIRS.set(designId, buildDir);
}

/** Look up the build dir for a design, or null if no successful build
 *  has been registered this session. The protocol handler returns 404
 *  for `_build/*` requests when this is null. */
export function getGodotWebBuildDir(designId: string): string | null {
  return BUILD_DIRS.get(designId) ?? null;
}

/** Drop a registration (e.g. when the design is deleted). */
export function clearGodotWebBuildDir(designId: string): void {
  BUILD_DIRS.delete(designId);
}

/** Test-only: nuke every registration. */
export function _resetGodotWebBuildRegistry(): void {
  BUILD_DIRS.clear();
}
