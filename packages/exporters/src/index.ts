/**
 * Exporter entry point. Each format lives in its own subpath export and is
 * loaded lazily so the cold-start bundle stays lean (PRINCIPLES §1).
 *
 * Tier 1 ships HTML, PDF, PPTX, and ZIP — all four lazy-loaded so the heavy
 * runtime deps (`puppeteer-core`, `pptxgenjs`, `zip-lib`) only enter the
 * module graph the first time a user actually exports.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';

export const EXPORTER_FORMATS = [
  'html',
  'pdf',
  'pptx',
  'zip',
  'markdown',
  // gameplan §A7 / §B2 — game-mode exporters. Take a different input shape
  // (multi-file bundle), so they bypass `exportArtifact` and have their
  // own `exportGameArtifact` entry point below.
  'game-html',
  'game-zip',
  'game-godot-project',
  'game-godot-web',
  'game-py',
  'game-pyodide-html',
  'game-unity-project',
] as const;
export type ExporterFormat = (typeof EXPORTER_FORMATS)[number];

/** Format groups by intended artifact type. The renderer's export menu
 *  uses these to hide non-applicable formats (e.g. PDF on a game). */
export const DESIGN_EXPORTER_FORMATS = ['html', 'pdf', 'pptx', 'zip', 'markdown'] as const;
export const GAME_EXPORTER_FORMATS = [
  'game-html',
  'game-zip',
  'game-godot-project',
  'game-godot-web',
  'game-py',
  'game-pyodide-html',
  'game-unity-project',
  'markdown',
] as const;
export type DesignExporterFormat = (typeof DESIGN_EXPORTER_FORMATS)[number];
export type GameExporterFormat = (typeof GAME_EXPORTER_FORMATS)[number];

export interface ExportOptions {
  artifactId: string;
  destinationPath: string;
}

export interface ExportResult {
  bytes: number;
  path: string;
}

export function isExporterReady(_format: ExporterFormat): boolean {
  return true;
}

export type { ExportHtmlOptions } from './html';
export type { ExportPdfOptions } from './pdf';
export type { ExportPptxOptions } from './pptx';
export type { ExportZipOptions, ZipAsset } from './zip';
export type { ExportMarkdownOptions, MarkdownMeta } from './markdown';
export type { ExportGameZipOptions } from './game-zip';
export type { ExportGameHtmlOptions } from './game-html';
export type { ExportGameGodotProjectOptions } from './game-godot-project';
export type { ExportGameGodotWebOptions } from './game-godot-web';
export type { ExportGamePyOptions } from './game-py';
export type { ExportGamePyodideHtmlOptions } from './game-pyodide-html';
export type { ExportGameUnityProjectOptions } from './game-unity-project';
export { htmlToMarkdown } from './markdown';

export async function exportHtml(
  htmlContent: string,
  destinationPath: string,
  opts?: import('./html').ExportHtmlOptions,
): Promise<ExportResult> {
  const mod = await import('./html');
  return mod.exportHtml(htmlContent, destinationPath, opts);
}

/** Optional per-format extras passed through to the underlying exporter.
 *  Only `zipAssets` is consumed today; other fields exist as forward
 *  compatibility for future formats (e.g. PDF page-break hints). */
export interface ExportArtifactOptions {
  /** Sidecar files bundled alongside `index.html` when exporting to ZIP.
   *  Used by the multi-source-file (vanilla) artifact pattern so the
   *  exported zip mirrors what Claude Design produces (HTML + CSS + JS +
   *  assets/). Ignored for non-ZIP formats. */
  zipAssets?: import('./zip').ZipAsset[];
  /** Override the README banner inside the ZIP. */
  zipReadmeTitle?: string;
}

export async function exportArtifact(
  format: ExporterFormat,
  htmlContent: string,
  destinationPath: string,
  opts: ExportArtifactOptions = {},
): Promise<ExportResult> {
  if (format === 'html') {
    return exportHtml(htmlContent, destinationPath);
  }
  if (format === 'pdf') {
    const mod = await import('./pdf');
    return mod.exportPdf(htmlContent, destinationPath);
  }
  if (format === 'pptx') {
    const mod = await import('./pptx');
    return mod.exportPptx(htmlContent, destinationPath);
  }
  if (format === 'zip') {
    const mod = await import('./zip');
    const zipOpts: import('./zip').ExportZipOptions = {};
    if (opts.zipAssets && opts.zipAssets.length > 0) zipOpts.assets = opts.zipAssets;
    if (opts.zipReadmeTitle !== undefined) zipOpts.readmeTitle = opts.zipReadmeTitle;
    return mod.exportZip(htmlContent, destinationPath, zipOpts);
  }
  if (format === 'markdown') {
    const mod = await import('./markdown');
    return mod.exportMarkdown(htmlContent, destinationPath);
  }
  if (
    format === 'game-html' ||
    format === 'game-zip' ||
    format === 'game-godot-project' ||
    format === 'game-godot-web' ||
    format === 'game-py' ||
    format === 'game-pyodide-html' ||
    format === 'game-unity-project'
  ) {
    throw new CodesignError(
      `Format "${format}" is a game-mode exporter — call exportGameArtifact() with the multi-file bundle instead of exportArtifact() with one HTML string.`,
      ERROR_CODES.EXPORTER_FORMAT_REJECTED,
    );
  }
  throw new CodesignError(
    `Unknown exporter format: ${format as string}`,
    ERROR_CODES.EXPORTER_UNKNOWN,
  );
}

/** gameplan §A7 — game-mode export entry point. Takes the design's full
 *  multi-file bundle (read from `design_files` rows by the host) and
 *  dispatches to game-html (single offline file) or game-zip (directory
 *  archive). 'markdown' is allowed too — produces a README of the game's
 *  controls + mechanics from the agent's `done` summary. */
export async function exportGameArtifact(
  format: GameExporterFormat,
  destinationPath: string,
  opts: {
    files: import('./zip').ZipAsset[];
    designName?: string;
    engine?: 'three' | 'phaser' | 'pygame' | 'godot' | 'unity';
    engineVersion?: string;
    /** Required for game-html (engine bundle inlining target). Ignored
     *  for game-zip / markdown. */
    htmlForMarkdown?: string;
  },
): Promise<ExportResult> {
  if (format === 'game-zip') {
    const mod = await import('./game-zip');
    const zipOpts: import('./game-zip').ExportGameZipOptions = { files: opts.files };
    if (opts.designName !== undefined) zipOpts.designName = opts.designName;
    if (opts.engine !== undefined) zipOpts.engine = opts.engine;
    if (opts.engineVersion !== undefined) zipOpts.engineVersion = opts.engineVersion;
    return mod.exportGameZip(destinationPath, zipOpts);
  }
  if (format === 'game-html') {
    if (opts.engine !== 'three' && opts.engine !== 'phaser') {
      throw new CodesignError(
        `game-html is browser-engine-only (Three.js / Phaser). For ${opts.engine ?? 'this engine'}, use game-zip / game-py / game-godot-project.`,
        ERROR_CODES.EXPORTER_FORMAT_REJECTED,
      );
    }
    const mod = await import('./game-html');
    return mod.exportGameHtml(destinationPath, {
      files: opts.files,
      engine: opts.engine,
      ...(opts.engineVersion !== undefined ? { engineVersion: opts.engineVersion } : {}),
    });
  }
  if (format === 'game-godot-project') {
    if (opts.engine !== 'godot' && opts.engine !== undefined) {
      throw new CodesignError(
        `game-godot-project requires engine='godot' (got "${opts.engine}"). Use game-html / game-zip for the JS engines.`,
        ERROR_CODES.EXPORTER_FORMAT_REJECTED,
      );
    }
    const mod = await import('./game-godot-project');
    const godotOpts: import('./game-godot-project').ExportGameGodotProjectOptions = {
      files: opts.files,
    };
    if (opts.designName !== undefined) godotOpts.designName = opts.designName;
    if (opts.engineVersion !== undefined) godotOpts.engineVersion = opts.engineVersion;
    return mod.exportGameGodotProject(destinationPath, godotOpts);
  }
  if (format === 'game-godot-web') {
    if (opts.engine !== 'godot' && opts.engine !== undefined) {
      throw new CodesignError(
        `game-godot-web requires engine='godot' (got "${opts.engine}"). Use game-html / game-zip for the JS engines, game-py for pygame.`,
        ERROR_CODES.EXPORTER_FORMAT_REJECTED,
      );
    }
    const mod = await import('./game-godot-web');
    const webOpts: import('./game-godot-web').ExportGameGodotWebOptions = { files: opts.files };
    if (opts.designName !== undefined) webOpts.designName = opts.designName;
    if (opts.engineVersion !== undefined) webOpts.engineVersion = opts.engineVersion;
    return mod.exportGameGodotWeb(destinationPath, webOpts);
  }
  if (format === 'game-py') {
    if (opts.engine !== 'pygame' && opts.engine !== undefined) {
      throw new CodesignError(
        `game-py requires engine='pygame' (got "${opts.engine}"). Use game-html / game-zip for the JS engines, game-godot-project for godot.`,
        ERROR_CODES.EXPORTER_FORMAT_REJECTED,
      );
    }
    const mod = await import('./game-py');
    const pyOpts: import('./game-py').ExportGamePyOptions = { files: opts.files };
    if (opts.designName !== undefined) pyOpts.designName = opts.designName;
    if (opts.engineVersion !== undefined) pyOpts.engineVersion = opts.engineVersion;
    return mod.exportGamePy(destinationPath, pyOpts);
  }
  if (format === 'game-unity-project') {
    if (opts.engine !== 'unity' && opts.engine !== undefined) {
      throw new CodesignError(
        `game-unity-project requires engine='unity' (got "${opts.engine}"). Use game-html / game-zip for the JS engines.`,
        ERROR_CODES.EXPORTER_FORMAT_REJECTED,
      );
    }
    const mod = await import('./game-unity-project');
    const unityOpts: import('./game-unity-project').ExportGameUnityProjectOptions = {
      files: opts.files,
    };
    if (opts.designName !== undefined) unityOpts.designName = opts.designName;
    if (opts.engineVersion !== undefined) unityOpts.engineVersion = opts.engineVersion;
    return mod.exportGameUnityProject(destinationPath, unityOpts);
  }
  if (format === 'game-pyodide-html') {
    if (opts.engine !== 'pygame' && opts.engine !== undefined) {
      throw new CodesignError(
        `game-pyodide-html requires engine='pygame' (got "${opts.engine}"). Use game-html for the JS engines, game-godot-project for godot.`,
        ERROR_CODES.EXPORTER_FORMAT_REJECTED,
      );
    }
    const mod = await import('./game-pyodide-html');
    const phOpts: import('./game-pyodide-html').ExportGamePyodideHtmlOptions = {
      files: opts.files,
    };
    if (opts.designName !== undefined) phOpts.designName = opts.designName;
    if (opts.engineVersion !== undefined) phOpts.engineVersion = opts.engineVersion;
    return mod.exportGamePyodideHtml(destinationPath, phOpts);
  }
  if (format === 'markdown') {
    const mod = await import('./markdown');
    // For game-mode markdown export we use the index.html (or any HTML the
    // bundle carries) as the source. Falls back to a stub if no HTML is
    // present so the call doesn't throw.
    const indexEntry = opts.files.find((f) => f.path === 'index.html');
    const html =
      opts.htmlForMarkdown ??
      (indexEntry !== undefined
        ? typeof indexEntry.content === 'string'
          ? indexEntry.content
          : indexEntry.content.toString('utf8')
        : `<html><body><h1>${opts.designName ?? 'Game'}</h1></body></html>`);
    return mod.exportMarkdown(html, destinationPath);
  }
  throw new CodesignError(
    `Unknown game exporter format: ${format as string}`,
    ERROR_CODES.EXPORTER_UNKNOWN,
  );
}
