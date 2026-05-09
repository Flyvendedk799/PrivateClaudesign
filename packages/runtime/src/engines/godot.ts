/**
 * gameplan §3 + §7.1 + §7.6 — Godot engine adapter (Phase B).
 *
 * Pinned to Godot 4.3. v1 ships PROJECT-DOWNLOAD ONLY — `supportsLivePreview()`
 * returns false until Phase D wires the `godot --headless --export-release`
 * shell-out. The bootstrap returns a static project-shell HTML the
 * iframe shows in place of a real game preview: file tree + project
 * metadata + an "Open in Godot" call-to-action.
 *
 * Validator checks the §7.6 heuristics: project.godot parses with
 * [application] section + every [ext_resource path=…] resolves + every
 * [node script=…] resolves + every *.gd extends some node class + no
 * print() inside _process (perf hit + log spam).
 */

import type {
  BootstrapOptions,
  GameEngineAdapter,
  InputFile,
  ValidationIssue,
  ValidationResult,
} from './types';

const GODOT_DEFAULT_VERSION = '4.3';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Project-shell preview — the iframe shows this static page instead of a
 *  real Godot runtime. Phase D replaces this with the web-export build
 *  output served from `_build/`. */
function godotBootstrap(opts: BootstrapOptions): string {
  const version = opts.pinnedVersion ?? GODOT_DEFAULT_VERSION;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${escapeHtml(opts.gameBaseUrl)}" />
<title>Godot project</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0e; color: #e6e6e6;
    font: 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 720px; margin: 4rem auto; padding: 0 2rem; }
  h1 { margin: 0 0 0.5rem; font-size: 1.5rem; font-weight: 600; }
  .sub { color: #9ca3af; margin-bottom: 2rem; }
  .panel { border: 1px solid #2a2a30; border-radius: 8px; padding: 1.25rem;
    background: #15151a; }
  .row { display: flex; justify-content: space-between; gap: 1rem;
    padding: 0.4rem 0; border-bottom: 1px solid #2a2a30; }
  .row:last-child { border-bottom: 0; }
  .row .k { color: #9ca3af; }
  .row .v { color: #e6e6e6; font-family: ui-monospace, Menlo, monospace; }
  .cta { margin-top: 1.5rem; padding: 1rem; border-radius: 6px;
    background: #1f1f25; color: #d1d5db; }
  .cta strong { color: #fff; }
  .cta code { background: #0b0b0e; padding: 1px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Godot ${escapeHtml(version)} project</h1>
    <p class="sub">Phase B ships project download only. Live web preview lands in Phase D once <code>godot</code> is detected on PATH.</p>
    <div class="panel">
      <div class="row"><span class="k">Engine</span><span class="v">Godot ${escapeHtml(version)}</span></div>
      <div class="row"><span class="k">Entry</span><span class="v">main.tscn</span></div>
      <div class="row"><span class="k">Live preview</span><span class="v">deferred to Phase D</span></div>
    </div>
    <div class="cta">
      <strong>To run this project</strong>:<br/>
      Export the bundle (<code>game-godot-project</code>), unzip it, then open
      <code>project.godot</code> in Godot ${escapeHtml(version)}+ and press F5.
    </div>
  </div>
</body>
</html>`;
}

interface ParsedTscn {
  extResourcePaths: string[];
}

function parseTscn(content: string): ParsedTscn {
  const extResourcePaths: string[] = [];
  // [ext_resource path="res://scripts/player.gd" type="Script" id=1]
  // Use matchAll so we don't trip biome's noAssignInExpressions on the
  // exec-loop pattern. matchAll is iterator-friendly + idiomatic.
  for (const match of content.matchAll(/\[ext_resource\s+[^\]]*?path\s*=\s*"([^"]+)"/g)) {
    if (typeof match[1] === 'string') extResourcePaths.push(match[1]);
  }
  // [node name="..." parent="..." instance=ExtResource("...")] is already
  // captured because the `instance=ExtResource(...)` IDs all reference
  // [ext_resource path] entries earlier in the file. Phase B doesn't try
  // to deeply lint node trees.
  return { extResourcePaths };
}

/** Resolve a `res://` path to a project-relative path string. Returns
 *  null when the path doesn't start with the `res://` scheme. */
function stripResScheme(path: string): string | null {
  if (path.startsWith('res://')) return path.slice('res://'.length);
  return null;
}

function godotValidate(files: ReadonlyArray<InputFile>): ValidationResult {
  const issues: ValidationIssue[] = [];
  const projectGodot = files.find((f) => f.path === 'project.godot');
  const filePathSet = new Set(files.map((f) => f.path));

  if (projectGodot === undefined) {
    issues.push({
      path: 'project.godot',
      message:
        'project.godot is missing — every Godot project needs a top-level project.godot manifest with at least an [application] section.',
      severity: 'error',
    });
  } else {
    if (!/^\s*\[application\]/m.test(projectGodot.content)) {
      issues.push({
        path: 'project.godot',
        message:
          'project.godot has no [application] section. The minimum file needs `[application]\\nconfig/name="…"\\nrun/main_scene="res://main.tscn"`.',
        severity: 'error',
      });
    }
    // Warn if the run/main_scene reference does not resolve.
    const mainSceneMatch = projectGodot.content.match(/run\/main_scene\s*=\s*"res:\/\/([^"]+)"/);
    if (mainSceneMatch !== null && typeof mainSceneMatch[1] === 'string') {
      const target = mainSceneMatch[1];
      if (!filePathSet.has(target)) {
        issues.push({
          path: 'project.godot',
          message: `run/main_scene references "res://${target}" but no such file exists in the bundle.`,
          severity: 'error',
        });
      }
    }
  }

  // Walk every .tscn for ext_resource path references
  for (const file of files) {
    if (!file.path.endsWith('.tscn')) continue;
    const parsed = parseTscn(file.content);
    for (const ref of parsed.extResourcePaths) {
      const rel = stripResScheme(ref);
      if (rel === null) {
        issues.push({
          path: file.path,
          message: `ext_resource path "${ref}" must use the res:// scheme.`,
          severity: 'warn',
        });
        continue;
      }
      if (!filePathSet.has(rel)) {
        issues.push({
          path: file.path,
          message: `ext_resource references "res://${rel}" but no such file exists in the bundle.`,
          severity: 'error',
        });
      }
    }
  }

  // Every .gd should declare an `extends` line at the top.
  for (const file of files) {
    if (!file.path.endsWith('.gd')) continue;
    if (!/^\s*extends\s+\w/m.test(file.content)) {
      issues.push({
        path: file.path,
        message:
          'GDScript files must start with an `extends` line declaring the parent node type (e.g. `extends Node2D`).',
        severity: 'error',
      });
    }
    // Performance smell: print() inside _process is the canonical
    // log-spam-and-frame-stutter foot-gun. Bound the _process body by
    // the next `func ` declaration so print() in a sibling fn doesn't
    // false-positive.
    const procIdx = file.content.search(/func\s+_process\b/);
    if (procIdx !== -1) {
      const nextFunc = file.content.indexOf('\nfunc ', procIdx + 1);
      const procEnd = nextFunc === -1 ? file.content.length : nextFunc;
      const procBody = file.content.slice(procIdx, procEnd);
      if (/\bprint\s*\(/.test(procBody)) {
        issues.push({
          path: file.path,
          message:
            'print() inside _process logs every frame at 60 fps — drop it once verified, or move to `if Engine.get_process_frames() % 60 == 0`.',
          severity: 'warn',
        });
      }
    }
  }

  // Engine version drift — Phase B locks Godot 4.3.
  // [gd_scene format=3] is Godot 4.x; format=2 is 3.x. Reject 3.x.
  for (const file of files) {
    if (!file.path.endsWith('.tscn')) continue;
    if (/^\s*\[gd_scene[\s\S]*?format\s*=\s*"?2"?/m.test(file.content)) {
      issues.push({
        path: file.path,
        message:
          'Scene format=2 detected (Godot 3.x). gameplan pins Godot 4.3 — re-export from a 4.x editor or rewrite by hand.',
        severity: 'error',
      });
    }
  }

  // may9 Phase 8 follow-up #27 (Godot portion) — trigger-zone
  // structural lint. .tscn scenes reference Area2D/Area3D for trigger
  // zones; the lint flags scenes that declare an Area* node but lack
  // a CollisionShape/CollisionPolygon child OR any StaticBody/Tileset
  // that defines the walkable polygon. Catches "go through the door"
  // triggers placed without any wall geometry to bound them.
  for (const file of files) {
    if (!file.path.endsWith('.tscn')) continue;
    const hasAreaTrigger = /\[node[^\]]*type="Area[23]D"/.test(file.content);
    if (!hasAreaTrigger) continue;
    const hasCollisionShape = /\[node[^\]]*type="CollisionShape[23]D"/.test(file.content);
    const hasWalkableBounds =
      /\[node[^\]]*type="(StaticBody[23]D|TileMap|GridMap|RigidBody[23]D)"/.test(file.content);
    if (!hasCollisionShape) {
      issues.push({
        path: file.path,
        message:
          'geometry.unreachable_trigger: scene declares an Area* trigger node but no CollisionShape* child. Trigger zones need a shape to be reachable.',
        severity: 'warn',
      });
    } else if (!hasWalkableBounds) {
      issues.push({
        path: file.path,
        message:
          'geometry.unreachable_trigger: scene declares Area* triggers but no walkable bounds (StaticBody, TileMap, RigidBody). The reachability check is dormant; add at least one bounding body.',
        severity: 'warn',
      });
    }
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

export const godotAdapter: GameEngineAdapter = {
  id: 'godot',
  label: 'Godot',
  defaultVersion: GODOT_DEFAULT_VERSION,
  canonicalEntry: 'project.godot',
  fileExtensions: [
    'godot',
    'tscn',
    'tres',
    'gd',
    'import',
    'cfg',
    'png',
    'jpg',
    'webp',
    'wav',
    'ogg',
  ],
  bootstrap: godotBootstrap,
  // Phase B: project-download only. Phase D will toggle this to true
  // once godot --headless --export-release Web is wired up.
  supportsLivePreview: () => false,
  validate: godotValidate,
};
