/**
 * gameplan §3 + §7.1 — Three.js engine adapter (Phase A).
 *
 * Pinned to three@0.170.0 ESM from cdn.jsdelivr.net. The bootstrap returns
 * a starter index.html with:
 *   - <base href="game-files://designs/{id}/"> so the agent's relative
 *     imports + asset URLs resolve through the privileged protocol
 *   - <script type="importmap"> mapping the bare specifier `three` to the
 *     pinned CDN ESM URL
 *   - the cross-engine `__game` global shim (postMessage tweak bridge)
 *   - a placeholder <canvas id="game"> mount target
 *   - a `<script type="module" src="src/main.js">` slot the agent fills in
 *
 * Validator checks the §7.6 heuristics: WebGLRenderer + RAF loop + dispose
 * pattern + at least one input listener + pinned CDN URL + no eval.
 */

import {
  type BootstrapOptions,
  type GameEngineAdapter,
  type InputFile,
  type ValidationIssue,
  type ValidationResult,
  gameGlobalSetupSnippet,
} from './types';

const THREE_DEFAULT_VERSION = '0.170.0';

function threeImportMap(version: string): string {
  return `<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@${version}/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@${version}/examples/jsm/"
  }
}
</script>`;
}

function threeBootstrap(opts: BootstrapOptions): string {
  const version = opts.pinnedVersion ?? THREE_DEFAULT_VERSION;
  const globalSnippet = gameGlobalSetupSnippet({
    engine: 'three',
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
  canvas#game { display: block; width: 100%; height: 100%; }
</style>
${threeImportMap(version)}
${globalSnippet}
</head>
<body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body>
</html>`;
}

function threeValidate(files: ReadonlyArray<InputFile>): ValidationResult {
  const issues: ValidationIssue[] = [];
  // Three.js entry expectations live in JS files (the index.html only carries
  // the import-map + canvas mount target). Aggregate all .js / .ts content.
  const jsFiles = files.filter((f) => /\.[jt]sx?$/.test(f.path));
  const allJs = jsFiles.map((f) => f.content).join('\n\n');
  const indexHtml = files.find((f) => f.path === 'index.html');

  if (indexHtml === undefined) {
    issues.push({
      path: 'index.html',
      message: 'index.html is missing — the canonical entry point for Three.js games.',
      severity: 'error',
    });
  } else {
    if (!indexHtml.content.includes('importmap')) {
      issues.push({
        path: 'index.html',
        message:
          'index.html does not declare an importmap. Add <script type="importmap"> mapping `three` to the pinned cdn.jsdelivr.net URL.',
        severity: 'error',
      });
    } else if (!/three@0\.170(\.\d+)?\//.test(indexHtml.content)) {
      issues.push({
        path: 'index.html',
        message:
          'Three.js import URL must pin to three@0.170.x (gameplan Appendix). Found a different version or no version pin.',
        severity: 'warn',
      });
    }
    if (!indexHtml.content.includes('<canvas')) {
      issues.push({
        path: 'index.html',
        message: 'No <canvas> element found in index.html — Three.js needs a canvas mount target.',
        severity: 'warn',
      });
    }
  }

  if (jsFiles.length === 0) {
    issues.push({
      path: 'src/',
      message:
        'No .js / .ts files found. Three.js games author their scene + render loop in JavaScript modules.',
      severity: 'error',
    });
  } else {
    if (!/\bWebGLRenderer\b/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'No `WebGLRenderer` reference found. Three.js games construct one (`new THREE.WebGLRenderer({...})`) and attach it to the <canvas>.',
        severity: 'error',
      });
    }
    if (!/\brequestAnimationFrame\b/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'No requestAnimationFrame loop detected. Games need a per-frame update via `requestAnimationFrame(render)`.',
        severity: 'error',
      });
    }
    if (!/(\.dispose\(\)|scene\.clear\(\))/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'No disposal pattern detected (`renderer.dispose()` / `scene.clear()`). Long-running iframes leak GPU resources without one.',
        severity: 'warn',
      });
    }
    if (
      !/addEventListener\(\s*['"`](resize|keydown|keyup|click|mousedown|mouseup|pointerdown|pointermove)/.test(
        allJs,
      )
    ) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'No input or resize listener registered. Add at least one (e.g. window.addEventListener("keydown", …) or window.addEventListener("resize", …)).',
        severity: 'warn',
      });
    }
    if (/\beval\s*\(|new\s+Function\s*\(/.test(allJs)) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message: 'eval / new Function detected. Forbidden — sandbox CSP would reject these anyway.',
        severity: 'error',
      });
    }
    // may9 Phase 8 follow-up #27 (Three.js portion) — trigger-zone
    // contract lint. The static-analysis equivalent of the Phaser
    // Tiled walk: when the JS references __game.world.triggers, it
    // must also expose colliders so a runtime point-in-volume test
    // can validate reachability. Catches the FPS Wave Defense
    // regression class where a "go through the door" trigger zone
    // was numerically outside the walkable area.
    const referencesTriggers = /__game\.world\.triggers\b/.test(allJs);
    const referencesColliders = /__game\.world\.colliders\b/.test(allJs);
    if (referencesTriggers && !referencesColliders) {
      issues.push({
        path: jsFiles[0]?.path ?? 'src/',
        message:
          'geometry.unreachable_trigger: code references `__game.world.triggers` but never sets `__game.world.colliders`. The host playtest path uses both to assert each trigger centroid lies inside the walkable polygon — without colliders the check is dormant. Expose `__game.world.colliders = [...]` (an array of bounding boxes / meshes) alongside triggers.',
        severity: 'warn',
      });
    }
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

export const threeAdapter: GameEngineAdapter = {
  id: 'three',
  label: 'Three.js',
  defaultVersion: THREE_DEFAULT_VERSION,
  canonicalEntry: 'index.html',
  fileExtensions: ['html', 'js', 'mjs', 'json', 'png', 'jpg', 'webp', 'wav', 'mp3', 'ogg'],
  bootstrap: threeBootstrap,
  supportsLivePreview: () => true,
  validate: threeValidate,
};
