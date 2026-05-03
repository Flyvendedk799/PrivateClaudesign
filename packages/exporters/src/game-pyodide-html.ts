/**
 * gameplan §C2 — `game-pyodide-html` exporter.
 *
 * Produces a single shareable HTML file that boots Pyodide, mounts the
 * project's .py + asset files into MEMFS from inline base64 strings, then
 * runs `main.py`. Suitable for itch.io single-file uploads, sharing a
 * Pygame project as one file users can open without `python3 -m http.server`.
 *
 * Trade-off vs. `game-html` (Three / Phaser): Pyodide is multi-file (loader
 * + many .wasm + per-package data) totalling ~30 MB. Vendoring all of it
 * into the HTML is impractical. So this exporter:
 *   - inlines every project file (.py + assets) as base64 strings the
 *     bootstrap decodes into Pyodide MEMFS at boot
 *   - keeps Pyodide + pygame-ce on cdn.jsdelivr.net (browser caches both
 *     after first run)
 *
 * Result: one HTML file the user can host anywhere or open via file://
 * (Pyodide loads the engine over HTTPS on first run; no project-side
 * fetches needed because every authored file is inline).
 *
 * The bootstrap shape mirrors `runtime/engines/pygame.ts` but reads from
 * the inline manifest instead of `game-files://` so the file is
 * self-contained.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type { ExportResult } from './index';
import type { ZipAsset } from './zip';

export interface ExportGamePyodideHtmlOptions {
  files: ZipAsset[];
  /** Pygame-CE version pin. Defaults to '2.5.5'. */
  engineVersion?: string;
  /** Pyodide version pin. Defaults to '0.26.4' (matches the in-app preview). */
  pyodideVersion?: string;
  /** UI-friendly page title; falls back to "Pygame". */
  designName?: string;
}

const DEFAULT_PYGAME_VERSION = '2.5.5';
const DEFAULT_PYODIDE_VERSION = '0.26.4';

function bytesToBase64(bytes: Uint8Array | Buffer | string): string {
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8').toString('base64');
  return Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

export async function exportGamePyodideHtml(
  destinationPath: string,
  opts: ExportGamePyodideHtmlOptions,
): Promise<ExportResult> {
  if (opts.files.length === 0) {
    throw new CodesignError(
      'game-pyodide-html export called with an empty file list',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  const hasMainPy = opts.files.some((f) => f.path === 'main.py');
  if (!hasMainPy) {
    throw new CodesignError(
      'game-pyodide-html export requires a main.py entry point in the file bundle.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }

  const pygameVersion = opts.engineVersion ?? DEFAULT_PYGAME_VERSION;
  const pyodideVersion = opts.pyodideVersion ?? DEFAULT_PYODIDE_VERSION;
  const pyodideCdn = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full`;
  const title = opts.designName ?? 'Pygame';

  // Build the manifest: each entry is { path, b64 }. Bootstrap decodes
  // base64 → Uint8Array → py.FS.writeFile at boot. We exclude the
  // self-referential index.html if the bundle happens to include one
  // (this exporter generates its own).
  const manifest = opts.files
    .filter((f) => f.path !== 'index.html')
    .map((f) => ({
      path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''),
      b64: bytesToBase64(f.content),
    }));

  // Encode the manifest as a JSON-string literal embedded into the script.
  // JSON.stringify handles all escaping and is guaranteed to produce
  // valid JS string content. We then JSON.parse at boot.
  const manifestJson = JSON.stringify(manifest);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${htmlEscape(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0e; color: #e6e6e6;
    font: 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #pygame-mount { position: fixed; inset: 0; display: flex;
    align-items: center; justify-content: center; }
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
<script>
  // Default __game shim — exported HTML has no host postMessage bridge.
  // Skills that read window.__game.config.startMuted / params still work.
  window.__game = window.__game || { engine: 'pygame', config: { startMuted: false }, params: {} };
</script>
</head>
<body>
  <div id="pygame-mount">
    <div class="loader" id="pygame-loader">
      <div class="spinner"></div>
      <div class="label">Loading Pygame runtime…</div>
      <div class="sub">One-time setup, ~13 MB cached after this</div>
    </div>
  </div>
  <script src="${pyodideCdn}/pyodide.js"></script>
  <script id="pygame-manifest" type="application/json">${manifestJson}</script>
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
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  try {
    setLabel('Loading Pyodide…', '~10 MB');
    const py = await loadPyodide({ indexURL: '${pyodideCdn}/' });
    setLabel('Loading pygame-ce ${pygameVersion}…', '~3 MB');
    await py.loadPackage(['pygame-ce==${pygameVersion}']);

    setLabel('Mounting project files…');
    const manifestEl = document.getElementById('pygame-manifest');
    const manifest = JSON.parse(manifestEl.textContent || '[]');
    let mainSource = null;
    for (const entry of manifest) {
      const bytes = b64ToBytes(entry.b64);
      const parts = entry.path.split('/');
      let dir = '';
      for (let i = 0; i < parts.length - 1; i++) {
        dir = dir ? dir + '/' + parts[i] : parts[i];
        try { py.FS.mkdir('/home/pyodide/' + dir); } catch (e) { /* exists */ }
      }
      py.FS.writeFile('/home/pyodide/' + entry.path, bytes);
      if (entry.path === 'main.py') {
        mainSource = new TextDecoder('utf-8').decode(bytes);
      }
    }
    py.FS.chdir('/home/pyodide');

    if (loader && loader.parentElement) loader.parentElement.removeChild(loader);

    if (mainSource === null) throw new Error('main.py not present in the inline manifest');
    await py.runPythonAsync(mainSource);
  } catch (err) {
    showError('Pygame runtime failed to load:\\n\\n' + (err && err.message ? err.message : String(err)));
    if (window.console && console.error) console.error(err);
  }
})();
  </script>
</body>
</html>`;

  const { writeFile, stat } = await import('node:fs/promises');
  await writeFile(destinationPath, html, 'utf8');
  const s = await stat(destinationPath);
  return { bytes: s.size, path: destinationPath };
}
