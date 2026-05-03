/**
 * gameplan §A7 — `game-html` exporter.
 *
 * Produces a single offline-runnable HTML file that bundles:
 *   - the entry index.html
 *   - every `src/**` JS module inlined as data: URLs (rewriting the import
 *     map so bare specifiers + relative paths resolve to those data URLs)
 *   - the engine library (Three.js or Phaser) fetched once at export
 *     time from `cdn.jsdelivr.net` and inlined as a data: URL
 *   - every binary asset (PNG / WAV / etc.) base64-encoded into data: URLs
 *
 * Result: opens in Chrome from `file://` with no network access. Suitable
 * for itch.io single-file uploads, email attachments, sharing offline.
 *
 * Limitations (Phase A scope):
 *   - JS / Three / Phaser only. Pygame and Godot have separate exporters.
 *   - Asset references are rewritten via path-string match. The agent's
 *     guide instructs it to use stable relative paths (`assets/foo.png`),
 *     which the rewriter handles. Unusual constructs (string concat for
 *     paths) won't be caught — fall back to game-zip when in doubt.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type { ExportResult } from './index';
import type { ZipAsset } from './zip';

export interface ExportGameHtmlOptions {
  files: ZipAsset[];
  /** Engine pinned for the project. Drives engine-library fetch. */
  engine: 'three' | 'phaser';
  /** Pinned engine version. Defaults: three@0.170.0, phaser@3.88.0. */
  engineVersion?: string;
}

const DEFAULT_VERSIONS = { three: '0.170.0', phaser: '3.88.0' } as const;

const ENGINE_CDN_URLS = {
  three: (v: string) => `https://cdn.jsdelivr.net/npm/three@${v}/build/three.module.js`,
  phaser: (v: string) => `https://cdn.jsdelivr.net/npm/phaser@${v}/dist/phaser.esm.js`,
} as const;

function bytesToBase64(bytes: Uint8Array | Buffer): string {
  return Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function exportGameHtml(
  destinationPath: string,
  opts: ExportGameHtmlOptions,
): Promise<ExportResult> {
  if (opts.engine !== 'three' && opts.engine !== 'phaser') {
    throw new CodesignError(
      `game-html exporter does not support engine "${opts.engine}". Use game-py for pygame, game-godot-project for godot.`,
      ERROR_CODES.EXPORTER_FORMAT_REJECTED,
    );
  }
  const indexEntry = opts.files.find((f) => f.path === 'index.html');
  if (indexEntry === undefined) {
    throw new CodesignError(
      'game-html export requires an index.html entry point in the file bundle.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  let html =
    typeof indexEntry.content === 'string'
      ? indexEntry.content
      : indexEntry.content.toString('utf8');

  const version = opts.engineVersion ?? DEFAULT_VERSIONS[opts.engine];
  const engineUrl = ENGINE_CDN_URLS[opts.engine](version);

  // 1. Fetch the engine library + inline as a data: URL. The importmap in
  //    the agent's index.html points at the CDN URL — we rewrite it to the
  //    inlined data: URL so the page loads with zero network requests.
  let engineSource: string;
  try {
    const resp = await fetch(engineUrl);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${engineUrl}`);
    }
    engineSource = await resp.text();
  } catch (err) {
    throw new CodesignError(
      `Failed to fetch the ${opts.engine} library at export time. game-html needs network access to vendor the engine. Use game-zip for an export that keeps the CDN reference. (${err instanceof Error ? err.message : String(err)})`,
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  const engineDataUrl = `data:text/javascript;base64,${Buffer.from(engineSource, 'utf8').toString('base64')}`;
  // Global replacement — the URL appears in the importmap; if a future
  // starter shape mentions it elsewhere we still want every occurrence
  // swapped to the inlined data: URL.
  html = html.replace(new RegExp(escapeRegExp(engineUrl), 'g'), engineDataUrl);

  // 2. Inline every `src/**` JS module. Build a map of (originalPath →
  //    data: URL) and rewrite static `import 'src/...'` / `import './...'`
  //    references. The starter `index.html` ships a `<script type="module"
  //    src="src/main.js">` — we inline it as `<script type="module">` body.
  const jsFiles = opts.files.filter((f) => /\.[jt]sx?$/.test(f.path) && f.path !== 'index.html');
  const jsDataUrlByPath = new Map<string, string>();
  for (const f of jsFiles) {
    const content = typeof f.content === 'string' ? f.content : f.content.toString('utf8');
    jsDataUrlByPath.set(
      f.path,
      `data:text/javascript;base64,${Buffer.from(content, 'utf8').toString('base64')}`,
    );
  }
  // Rewrite the entry script tag. Common shape:
  //   <script type="module" src="src/main.js"></script>
  for (const [path, dataUrl] of jsDataUrlByPath) {
    const tagRegex = new RegExp(
      `<script\\s+type=["']module["']\\s+src=["']${escapeRegExp(path)}["']\\s*>\\s*</script>`,
      'g',
    );
    html = html.replace(tagRegex, `<script type="module" src="${dataUrl}"></script>`);
  }
  // Rewrite static import strings inside ALREADY-INLINED scripts. We
  // crudely walk known JS files and replace cross-file `import` paths
  // with the data: URLs. For Phase A this catches the common pattern of
  // `import { Player } from './entities/player.js'`. Edge cases (template
  // string imports, dynamic imports) fall back to the original path —
  // user gets game-zip if their project is unusual.
  for (const f of jsFiles) {
    const content = typeof f.content === 'string' ? f.content : f.content.toString('utf8');
    let rewritten = content;
    for (const [otherPath, otherDataUrl] of jsDataUrlByPath) {
      if (otherPath === f.path) continue;
      // Match relative imports in either `./` form or full project-root
      // form (the engine guides recommend the latter).
      const projectRel = new RegExp(`(['"\`])${escapeRegExp(otherPath)}\\1`, 'g');
      rewritten = rewritten.replace(projectRel, `$1${otherDataUrl}$1`);
    }
    const updatedDataUrl = `data:text/javascript;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`;
    jsDataUrlByPath.set(f.path, updatedDataUrl);
  }
  // Re-rewrite tags now that we have the recursively-inlined values.
  // (The first pass used the original-content data URLs; this pass swaps
  // them for the recursively-rewritten ones so transitively-imported
  // modules also inline.)
  for (const [path, dataUrl] of jsDataUrlByPath) {
    const tagRegex = new RegExp(
      `<script\\s+type=["']module["']\\s+src=["'][^"']*${escapeRegExp(path)}[^"']*["']\\s*>`,
      'g',
    );
    html = html.replace(tagRegex, `<script type="module" src="${dataUrl}">`);
  }

  // 3. Base64 every binary asset and rewrite path references.
  const assetFiles = opts.files.filter((f) => !f.path.endsWith('.js') && f.path !== 'index.html');
  for (const f of assetFiles) {
    if (!(f.content instanceof Buffer)) continue; // text non-JS asset (.json, .md) — leave inline
    const ext = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.') + 1) : '';
    const dataUrl = `data:${mimeForExt(ext)};base64,${bytesToBase64(f.content)}`;
    const pathRegex = new RegExp(`(['"\`])${escapeRegExp(f.path)}\\1`, 'g');
    html = html.replace(pathRegex, `$1${dataUrl}$1`);
  }

  // The <base href="game-files://..."> line in the starter no longer
  // applies once everything is inlined — strip it so the file: URL
  // doesn't try to resolve relatives against the protocol.
  html = html.replace(/<base\s+href=["'][^"']*["']\s*\/?\s*>\s*/i, '');

  const { writeFile, stat } = await import('node:fs/promises');
  await writeFile(destinationPath, html, 'utf8');
  const s = await stat(destinationPath);
  return { bytes: s.size, path: destinationPath };
}
