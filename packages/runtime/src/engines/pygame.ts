/**
 * gameplan §3 + §7.1 + §7.6 — Pygame engine adapter (Phase C).
 *
 * Pinned to pygame-ce 2.5.5 via Pyodide 0.26.4. The bootstrap returns an
 * index.html that:
 *   - loads Pyodide from cdn.jsdelivr.net
 *   - loads pygame-ce==2.5.5 as a Pyodide package
 *   - mounts the design's project files into Pyodide's MEMFS via the
 *     game-files:// protocol (one fetch per file, written into /home/pyodide)
 *   - shows a "Loading Pygame runtime…" spinner while ~13 MB downloads
 *   - gates audio context until first user gesture (autoplay policy)
 *   - imports + runs main.py (asyncio-aware loop)
 *
 * pygame-ce on Pyodide handles the canvas integration internally — calling
 * `pygame.display.set_mode((w, h))` creates a real <canvas> in the document
 * and routes draw calls to it. Our bootstrap supplies the DOM mount target
 * + input wiring + a sane #pygame-canvas id so styling targets a stable
 * selector.
 *
 * Validator (§7.6): main.py present, `pygame.init()`, an event loop with
 * `pygame.event.get()` + a QUIT handler, `pygame.display.flip()` reachable,
 * `import pygame` (or `pygame_ce` alias), no `import requests`/`urllib`
 * (the iframe sandbox blocks network anyway and they're large), no
 * `pygame.mixer.music.load(...)` streaming (Pyodide unsupported — must use
 * `pygame.mixer.Sound`).
 */

import {
  type BootstrapOptions,
  type GameEngineAdapter,
  type InputFile,
  type ValidationIssue,
  type ValidationResult,
  gameGlobalSetupSnippet,
} from './types';

const PYGAME_DEFAULT_VERSION = '2.5.5';
const PYODIDE_VERSION = '0.26.4';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`;

function pygameBootstrap(opts: BootstrapOptions): string {
  const version = opts.pinnedVersion ?? PYGAME_DEFAULT_VERSION;
  const globalSnippet = gameGlobalSetupSnippet({
    engine: 'pygame',
    initialParams: opts.initialParams ?? {},
    startMuted: opts.startMuted ?? false,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${opts.gameBaseUrl}" />
<title>Pygame</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0e; color: #e6e6e6;
    font: 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #pygame-mount { position: fixed; inset: 0; display: flex;
    align-items: center; justify-content: center; }
  /* pygame-ce on Pyodide injects its own <canvas> into the body. Style by
   * tag selector since the engine doesn't add an id to it. */
  body > canvas { display: block; image-rendering: pixelated; max-width: 100%;
    max-height: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
  .loader { text-align: center; color: #d1d5db; }
  .loader .spinner { width: 32px; height: 32px; border: 3px solid #2a2a30;
    border-top-color: #d1d5db; border-radius: 50%; margin: 0 auto 1rem;
    animation: spin 1s linear infinite; }
  .loader .label { font-size: 13px; }
  .loader .sub { font-size: 11px; color: #9ca3af; margin-top: 0.25rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { padding: 1rem; border-radius: 6px; background: #2a1418;
    color: #fca5a5; max-width: 480px; font: 12px ui-monospace, Menlo, monospace;
    white-space: pre-wrap; word-wrap: break-word; }
</style>
${globalSnippet}
</head>
<body>
  <div id="pygame-mount">
    <div class="loader" id="pygame-loader">
      <div class="spinner"></div>
      <div class="label">Loading Pygame runtime…</div>
      <div class="sub">One-time setup, ~13 MB cached after this</div>
    </div>
  </div>
  <script src="${PYODIDE_CDN}/pyodide.js"></script>
  <script>
(async () => {
  const loader = document.getElementById('pygame-loader');
  const setLabel = (text, sub) => {
    if (!loader) return;
    const labelEl = loader.querySelector('.label');
    const subEl = loader.querySelector('.sub');
    if (labelEl) labelEl.textContent = text;
    if (subEl && sub !== undefined) subEl.textContent = sub;
  };
  const showError = (message) => {
    if (!loader) return;
    loader.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = message;
    loader.appendChild(err);
  };
  try {
    setLabel('Loading Pyodide…', '~10 MB');
    // @ts-expect-error — loadPyodide is injected by the script tag above
    const py = await loadPyodide({ indexURL: '${PYODIDE_CDN}/' });
    setLabel('Loading pygame-ce ${version}…', '~3 MB');
    await py.loadPackage(['pygame-ce==${version}']);

    // Mount every project file into Pyodide MEMFS at /home/pyodide so
    // pygame.image.load('assets/x.png') resolves against the same paths
    // the agent authored.
    setLabel('Mounting project files…');
    const baseUrl = '${opts.gameBaseUrl}';
    const fileList = await fetchFileManifest(baseUrl);
    for (const path of fileList) {
      const resp = await fetch(baseUrl + path);
      if (!resp.ok) continue;
      const buf = new Uint8Array(await resp.arrayBuffer());
      // Create parent dirs.
      const parts = path.split('/');
      let dir = '';
      for (let i = 0; i < parts.length - 1; i++) {
        dir = dir ? dir + '/' + parts[i] : parts[i];
        try { py.FS.mkdir('/home/pyodide/' + dir); } catch (e) { /* exists */ }
      }
      py.FS.writeFile('/home/pyodide/' + path, buf);
    }
    py.FS.chdir('/home/pyodide');

    // Hide the loader before main.py grabs the screen so Pygame's canvas
    // can mount cleanly without a flash of the spinner under it.
    if (loader && loader.parentElement) loader.parentElement.removeChild(loader);

    // Run the user's main.py. Wrap with asyncio so blocking event loops
    // can yield to the browser via \`await asyncio.sleep(0)\` — see the
    // pygame engine guide. If the script doesn't itself await, we still
    // run it via runPythonAsync so any top-level await inside Pyodide's
    // executor works.
    const main = await fetch(baseUrl + 'main.py').then((r) => r.text());
    await py.runPythonAsync(main);
  } catch (err) {
    showError('Pygame runtime failed to load:\\n\\n' + (err && err.message ? err.message : String(err)));
    /* eslint-disable no-console */
    if (window.console && console.error) console.error(err);
  }
})();

// game-files:// has no built-in directory listing, so the bootstrap pulls
// a manifest the host writes alongside the project: 'manifest.json' is a
// list of relative paths. When absent (older designs / hand-authored
// uploads) we fall back to a minimum-viable single-file mount of main.py.
async function fetchFileManifest(baseUrl) {
  try {
    const resp = await fetch(baseUrl + 'manifest.json');
    if (!resp.ok) return ['main.py'];
    const json = await resp.json();
    if (Array.isArray(json) && json.every((p) => typeof p === 'string')) return json;
  } catch { /* ignore */ }
  return ['main.py'];
}
  </script>
</body>
</html>`;
}

interface ValidationContext {
  hasMainPy: boolean;
  pythonContent: string;
  pythonFiles: ReadonlyArray<InputFile>;
}

function buildContext(files: ReadonlyArray<InputFile>): ValidationContext {
  const pythonFiles = files.filter((f) => f.path.endsWith('.py'));
  return {
    hasMainPy: files.some((f) => f.path === 'main.py'),
    pythonContent: pythonFiles.map((f) => f.content).join('\n\n'),
    pythonFiles,
  };
}

function pygameValidate(files: ReadonlyArray<InputFile>): ValidationResult {
  const issues: ValidationIssue[] = [];
  const ctx = buildContext(files);

  if (!ctx.hasMainPy) {
    issues.push({
      path: 'main.py',
      message:
        'main.py is missing — the canonical entry point Pyodide runs at boot. Even a 5-line stub belongs at the project root.',
      severity: 'error',
    });
  }

  if (ctx.pythonFiles.length === 0) {
    issues.push({
      path: '',
      message: 'No .py files found. Pygame projects author their game in Python modules.',
      severity: 'error',
    });
    return { ok: false, issues };
  }

  // import pygame — accept either `pygame` or `pygame_ce` alias. Without
  // an import the rest of the file is dead code.
  if (!/(^|\n)\s*import\s+pygame(\s|$|\.|_ce)/m.test(ctx.pythonContent)) {
    issues.push({
      path: ctx.pythonFiles[0]?.path ?? 'main.py',
      message:
        'No `import pygame` found across the project. Every Pygame entry needs `import pygame` (or `import pygame_ce as pygame` on Pyodide).',
      severity: 'error',
    });
  }

  // pygame.init() must be called somewhere — the engine errors hard
  // without it ("video system not initialized").
  if (!/\bpygame\.init\s*\(/.test(ctx.pythonContent)) {
    issues.push({
      path: ctx.pythonFiles[0]?.path ?? 'main.py',
      message:
        'No `pygame.init()` call found. Pygame requires explicit initialisation — call it once at the top of main.py.',
      severity: 'error',
    });
  }

  // Event loop: at least one pygame.event.get() (or pygame.event.pump()).
  if (!/\bpygame\.event\.(get|pump|poll)\s*\(/.test(ctx.pythonContent)) {
    issues.push({
      path: ctx.pythonFiles[0]?.path ?? 'main.py',
      message:
        'No `pygame.event.get()` / `event.pump()` call. Without an event-loop drain, the OS thinks the window is unresponsive and the QUIT event never fires.',
      severity: 'error',
    });
  }

  // QUIT handler: any reference to pygame.QUIT shows the model thought
  // about graceful exit. Without it Ctrl+C is the only way out.
  if (!/\bpygame\.QUIT\b/.test(ctx.pythonContent)) {
    issues.push({
      path: ctx.pythonFiles[0]?.path ?? 'main.py',
      message:
        'No `pygame.QUIT` reference. Add `if event.type == pygame.QUIT: running = False` so the close button works.',
      severity: 'warn',
    });
  }

  // Display flip: without flip()/update(), the canvas never repaints.
  if (!/\bpygame\.display\.(flip|update)\s*\(/.test(ctx.pythonContent)) {
    issues.push({
      path: ctx.pythonFiles[0]?.path ?? 'main.py',
      message:
        'No `pygame.display.flip()` (or `pygame.display.update()`) call. Without it the canvas never repaints; the player sees a frozen first frame.',
      severity: 'error',
    });
  }

  // Pyodide-specific: pygame.mixer.music streaming is not supported on
  // Pyodide. The model should use pygame.mixer.Sound instead.
  if (/\bpygame\.mixer\.music\.load\s*\(/.test(ctx.pythonContent)) {
    issues.push({
      path: ctx.pythonFiles[0]?.path ?? 'main.py',
      message:
        '`pygame.mixer.music.load()` is unsupported on Pyodide. Use `pygame.mixer.Sound("path.wav")` for SFX + short loops; long-form streamed music is not available in this runtime.',
      severity: 'error',
    });
  }

  // Network libs forbidden — they don't work in the iframe sandbox and
  // pull MB of WASM via Pyodide's package loader.
  for (const banned of ['requests', 'urllib3', 'aiohttp', 'httpx']) {
    const re = new RegExp(`(^|\\n)\\s*import\\s+${banned}\\b|from\\s+${banned}\\s+import`, 'm');
    if (re.test(ctx.pythonContent)) {
      issues.push({
        path: ctx.pythonFiles[0]?.path ?? 'main.py',
        message: `\`import ${banned}\` is forbidden in Pygame projects — the iframe sandbox blocks network, and Pyodide loading ${banned} adds megabytes for no benefit. Use only the bundled stdlib + pygame-ce.`,
        severity: 'error',
      });
    }
  }

  // may9 Phase 8 follow-up #27 (Pygame portion) — trigger-zone
  // structural lint. Pygame doesn't have a canonical level-format like
  // Tiled, so the static check is conservative: when code references
  // an `exit_zone` / `trigger_zone` / `goal` rect by name, it should
  // also reference walkable bounds (a `walkable_rect`, `bounds`, a
  // tile collision lookup, or a sprite group like `walls`). Without
  // any of those, the trigger may be unreachable.
  const refsExitZone = /\b(exit_zone|trigger_zone|goal_zone|level_exit)\b/.test(ctx.pythonContent);
  const refsWalkable = /\b(walkable|walls|collidable|solid_tiles|collision_layer|bounds)\b/.test(
    ctx.pythonContent,
  );
  if (refsExitZone && !refsWalkable) {
    issues.push({
      path: ctx.pythonFiles[0]?.path ?? 'main.py',
      message:
        'geometry.unreachable_trigger: code references an exit/trigger/goal zone but no walkable bounds (walls, bounds, collision_layer, walkable rect). Reachability cannot be verified. Either remove the trigger or expose the walkable polygon so `assert_game_invariants` can check it.',
      severity: 'warn',
    });
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

export const pygameAdapter: GameEngineAdapter = {
  id: 'pygame',
  label: 'Pygame',
  defaultVersion: PYGAME_DEFAULT_VERSION,
  canonicalEntry: 'main.py',
  fileExtensions: ['py', 'png', 'jpg', 'webp', 'wav', 'ogg', 'json', 'txt', 'md'],
  bootstrap: pygameBootstrap,
  // Live preview through Pyodide loaded into the iframe. First run takes
  // ~10 s while ~13 MB downloads + caches; subsequent runs are sub-second.
  supportsLivePreview: () => true,
  validate: pygameValidate,
};
