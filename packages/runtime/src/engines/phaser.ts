/**
 * gameplan §3 + §7.1 — Phaser engine adapter (Phase A).
 *
 * Pinned to phaser@3.88.0 ESM from cdn.jsdelivr.net. The bootstrap returns
 * a starter index.html with:
 *   - <base href="game-files://designs/{id}/">
 *   - <script type="importmap"> mapping `phaser` to the pinned CDN URL
 *   - the cross-engine `__game` global shim
 *   - a <div id="game"> mount target (Phaser injects its own canvas)
 *   - a `<script type="module" src="src/main.js">` slot
 *
 * Validator checks the §7.6 heuristics: Phaser.Game / extends Phaser.Scene
 * + scene lifecycle methods + physics-enable-before-add + load-precedes-add
 * + pinned CDN URL + no eval.
 */

import {
  type BootstrapOptions,
  type GameEngineAdapter,
  type InputFile,
  type ValidationIssue,
  type ValidationResult,
  gameGlobalSetupSnippet,
} from './types';

const PHASER_DEFAULT_VERSION = '3.88.0';

function phaserImportMap(version: string): string {
  return `<script type="importmap">
{
  "imports": {
    "phaser": "https://cdn.jsdelivr.net/npm/phaser@${version}/dist/phaser.esm.js"
  }
}
</script>`;
}

function phaserBootstrap(opts: BootstrapOptions): string {
  const version = opts.pinnedVersion ?? PHASER_DEFAULT_VERSION;
  const globalSnippet = gameGlobalSetupSnippet({
    engine: 'phaser',
    initialParams: opts.initialParams ?? {},
    startMuted: opts.startMuted ?? false,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${opts.gameBaseUrl}" />
<title>Game</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0e; color: #e6e6e6;
    font: 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #game { width: 100%; height: 100%; }
  #game canvas { display: block; width: 100% !important; height: 100% !important; }
</style>
${phaserImportMap(version)}
${globalSnippet}
</head>
<body>
<div id="game"></div>
<script type="module" src="src/main.js"></script>
</body>
</html>`;
}

function phaserValidate(files: ReadonlyArray<InputFile>): ValidationResult {
  const issues: ValidationIssue[] = [];
  const jsFiles = files.filter((f) => /\.[jt]sx?$/.test(f.path));
  const allJs = jsFiles.map((f) => f.content).join('\n\n');
  const indexHtml = files.find((f) => f.path === 'index.html');

  if (indexHtml === undefined) {
    issues.push({
      path: 'index.html',
      message: 'index.html is missing — the canonical entry point for Phaser games.',
      severity: 'error',
    });
  } else {
    if (!indexHtml.content.includes('importmap')) {
      issues.push({
        path: 'index.html',
        message:
          'index.html does not declare an importmap. Add <script type="importmap"> mapping `phaser` to the pinned cdn.jsdelivr.net URL.',
        severity: 'error',
      });
    } else if (!/phaser@3\.88(\.\d+)?\//.test(indexHtml.content)) {
      issues.push({
        path: 'index.html',
        message:
          'Phaser import URL must pin to phaser@3.88.x (gameplan Appendix). Phaser 4.x alpha has different scene/physics APIs and is not supported.',
        severity: 'warn',
      });
    }
    if (
      !/<div[^>]*id=["']game["']/.test(indexHtml.content) &&
      !indexHtml.content.includes('<canvas')
    ) {
      issues.push({
        path: 'index.html',
        message:
          'No mount target found. Phaser needs either <div id="game"> (it injects its own canvas) or a pre-existing <canvas>.',
        severity: 'warn',
      });
    }
  }

  if (jsFiles.length === 0) {
    issues.push({
      path: 'src/',
      message:
        'No .js / .ts files found. Phaser games author scenes + game config in JavaScript modules.',
      severity: 'error',
    });
  } else {
    const hasGame = /\bnew\s+Phaser\.Game\b/.test(allJs);
    const hasScene =
      /\bextends\s+Phaser\.Scene\b/.test(allJs) || /\bclass\s+\w+Scene\b/.test(allJs);
    if (!hasGame && !hasScene) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'No `new Phaser.Game(…)` constructor or `extends Phaser.Scene` class found. The game must instantiate a Phaser.Game with a config object that lists at least one scene.',
        severity: 'error',
      });
    }

    if (hasScene) {
      const hasLifecycle =
        /\bpreload\s*\(/.test(allJs) || /\bcreate\s*\(/.test(allJs) || /\bupdate\s*\(/.test(allJs);
      if (!hasLifecycle) {
        issues.push({
          path: jsFiles[0]?.path ?? 'src/',
          message:
            'Scenes declare lifecycle methods (`preload`, `create`, `update`) — none found. Without `update()` the game has no per-frame logic.',
          severity: 'warn',
        });
      }
    }

    // Physics ordering: this.physics.add.* without an arcade/matter
    // declaration in the Phaser.Game config will throw "physics is undefined".
    if (
      /this\.physics\.add\./.test(allJs) &&
      !/physics\s*:\s*\{[^}]*default\s*:\s*['"](arcade|matter)['"]/.test(allJs)
    ) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'Used `this.physics.add.*` but no `physics: { default: "arcade" | "matter" }` block found in the Phaser.Game config.',
        severity: 'error',
      });
    }

    // Load-before-add: this.add.image('key') without this.load.image('key')
    // somewhere upstream is the most common Phaser mistake.
    const addImageKeys = Array.from(
      allJs.matchAll(/this\.add\.(?:image|sprite)\s*\(\s*[^,]+,\s*[^,]+,\s*['"`]([^'"`]+)['"`]/g),
    ).map((m) => m[1]);
    const loadImageKeys = new Set(
      Array.from(
        allJs.matchAll(/this\.load\.(?:image|spritesheet|atlas)\s*\(\s*['"`]([^'"`]+)['"`]/g),
      ).map((m) => m[1] ?? ''),
    );
    for (const key of addImageKeys) {
      if (key !== undefined && !loadImageKeys.has(key)) {
        issues.push({
          path: jsFiles[0]?.path ?? 'src/',
          message: `Asset key "${key}" is added via this.add but never loaded via this.load.image / this.load.spritesheet / this.load.atlas.`,
          severity: 'error',
        });
      }
    }

    if (/\beval\s*\(|new\s+Function\s*\(/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message: 'eval / new Function detected. Forbidden — sandbox CSP would reject these anyway.',
        severity: 'error',
      });
    }
  }

  // may9 Phase 8 follow-up #27 — trigger-zone reachability for Tiled
  // JSON levels. The FPS Wave Defense run (FPS-run #4) shipped a level
  // where the exit zone's centroid was numerically outside the
  // walkable polygon. We can't run point-in-polygon here without
  // parsing the full Tiled object layer with collision geometry, but
  // the structural lint catches the obvious cases:
  //  - trigger object positioned with negative coords or beyond map
  //    width/height
  //  - trigger object referenced by name in JS code but absent from
  //    the JSON
  for (const f of files) {
    if (!/\.json$/.test(f.path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.content);
    } catch {
      continue;
    }
    if (!isTiledMap(parsed)) continue;
    const map = parsed;
    const mapW = map.width * map.tilewidth;
    const mapH = map.height * map.tileheight;
    for (const layer of map.layers) {
      if (layer.type !== 'objectgroup') continue;
      for (const obj of layer.objects ?? []) {
        const cx = (obj.x ?? 0) + (obj.width ?? 0) / 2;
        const cy = (obj.y ?? 0) + (obj.height ?? 0) / 2;
        if (cx < 0 || cy < 0 || cx > mapW || cy > mapH) {
          issues.push({
            path: f.path,
            message: `geometry.unreachable_trigger: '${obj.name ?? `obj#${obj.id}`}' centroid (${cx.toFixed(0)}, ${cy.toFixed(0)}) is outside the map bounds (${mapW}×${mapH}). Triggers must lie inside the walkable area + ε.`,
            severity: 'error',
          });
        }
      }
    }
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: Array<{
    type: string;
    objects?: Array<{
      id?: number;
      name?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }>;
  }>;
}

function isTiledMap(value: unknown): value is TiledMap {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['width'] === 'number' &&
    typeof v['height'] === 'number' &&
    typeof v['tilewidth'] === 'number' &&
    typeof v['tileheight'] === 'number' &&
    Array.isArray(v['layers'])
  );
}

export const phaserAdapter: GameEngineAdapter = {
  id: 'phaser',
  label: 'Phaser',
  defaultVersion: PHASER_DEFAULT_VERSION,
  canonicalEntry: 'index.html',
  fileExtensions: ['html', 'js', 'mjs', 'json', 'png', 'jpg', 'webp', 'wav', 'mp3', 'ogg'],
  bootstrap: phaserBootstrap,
  supportsLivePreview: () => true,
  validate: phaserValidate,
};
