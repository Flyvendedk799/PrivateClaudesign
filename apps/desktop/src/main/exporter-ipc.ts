import { type ExporterFormat, type ZipAsset, exportArtifact } from '@open-codesign/exporters';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type BetterSqlite3 from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { dialog, ipcMain } from './electron-runtime';
import { listDesignFiles } from './snapshots-db';

const FORMAT_FILTERS: Record<ExporterFormat, Electron.FileFilter[]> = {
  html: [{ name: 'HTML', extensions: ['html'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  pptx: [{ name: 'PowerPoint', extensions: ['pptx'] }],
  zip: [{ name: 'ZIP archive', extensions: ['zip'] }],
  markdown: [{ name: 'Markdown', extensions: ['md'] }],
  // gameplan game-mode exporters. Game-html / game-pyodide-html ship a
  // single shareable HTML file; the others zip a project tree.
  'game-html': [{ name: 'HTML (single file)', extensions: ['html'] }],
  'game-pyodide-html': [{ name: 'HTML (single file)', extensions: ['html'] }],
  'game-zip': [{ name: 'ZIP archive', extensions: ['zip'] }],
  'game-godot-project': [{ name: 'Godot project (zip)', extensions: ['zip'] }],
  'game-godot-web': [{ name: 'Godot web build (zip)', extensions: ['zip'] }],
  'game-py': [{ name: 'Pygame project (zip)', extensions: ['zip'] }],
  'game-unity-project': [{ name: 'Unity project (zip)', extensions: ['zip'] }],
};

export interface ExportRequest {
  format: ExporterFormat;
  htmlContent: string;
  defaultFilename?: string;
  /** When supplied AND format='zip', the IPC handler reads the design's
   *  full virtual FS from SQLite and bundles every sibling file (CSS,
   *  JS, assets/*) alongside index.html. Required for vanilla-pattern
   *  exports to match Claude Design's multi-file zip layout. */
  designId?: string;
}

export interface ExportResponse {
  status: 'saved' | 'cancelled';
  path?: string;
  bytes?: number;
}

export function parseRequest(raw: unknown): ExportRequest {
  if (raw === null || typeof raw !== 'object') {
    throw new CodesignError('export expects an object payload', ERROR_CODES.IPC_BAD_INPUT);
  }
  const r = raw as Record<string, unknown>;
  const format = r['format'];
  const html = r['htmlContent'];
  const defaultFilename = r['defaultFilename'];
  const designId = r['designId'];
  if (
    format !== 'html' &&
    format !== 'pdf' &&
    format !== 'pptx' &&
    format !== 'zip' &&
    format !== 'markdown'
  ) {
    throw new CodesignError(
      `Unknown export format: ${String(format)}`,
      ERROR_CODES.EXPORTER_UNKNOWN,
    );
  }
  if (typeof html !== 'string' || html.length === 0) {
    throw new CodesignError('export requires non-empty htmlContent', ERROR_CODES.IPC_BAD_INPUT);
  }
  const out: ExportRequest = { format, htmlContent: html };
  if (typeof defaultFilename === 'string' && defaultFilename.length > 0) {
    out.defaultFilename = defaultFilename;
  }
  if (typeof designId === 'string' && designId.length > 0) {
    out.designId = designId;
  }
  return out;
}

/**
 * Convert the design's virtual-FS rows into ZipAssets for the zip
 * exporter. `index.html` is excluded — it ships separately via
 * `htmlContent`. Data: URLs (the form image-asset gen produces) are
 * decoded back to raw bytes so the zipped image is a real PNG, not a
 * text file containing a base64 string.
 */
function designFilesToZipAssets(db: BetterSqlite3.Database, designId: string): ZipAsset[] {
  const files = listDesignFiles(db, designId);
  const out: ZipAsset[] = [];
  for (const f of files) {
    if (f.path === 'index.html') continue;
    if (f.content.startsWith('data:')) {
      // data:image/png;base64,XXX → raw bytes
      const comma = f.content.indexOf(',');
      if (comma < 0) continue;
      const meta = f.content.slice(5, comma); // e.g. "image/png;base64"
      const payload = f.content.slice(comma + 1);
      if (meta.includes(';base64')) {
        out.push({ path: f.path, content: Buffer.from(payload, 'base64') });
      } else {
        // URL-encoded form (rare); decode via decodeURIComponent
        out.push({ path: f.path, content: Buffer.from(decodeURIComponent(payload), 'utf8') });
      }
    } else {
      out.push({ path: f.path, content: f.content });
    }
  }
  return out;
}

export function registerExporterIpc(
  getWindow: () => BrowserWindow | null,
  getDb: () => BetterSqlite3.Database | null = () => null,
): void {
  ipcMain.handle('codesign:export', async (_evt, raw: unknown): Promise<ExportResponse> => {
    const req = parseRequest(raw);
    const win = getWindow();
    const defaultExt = req.format === 'markdown' ? 'md' : req.format;
    const opts: Electron.SaveDialogOptions = {
      title: `Export design as ${req.format.toUpperCase()}`,
      defaultPath: req.defaultFilename ?? `design.${defaultExt}`,
      filters: FORMAT_FILTERS[req.format],
    };
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) {
      return { status: 'cancelled' };
    }

    // For zip + a known designId, pull every sibling file from SQLite so
    // the exported archive mirrors Claude Design's multi-file shape
    // (index.html + styles.css + *.js + assets/). For other formats or
    // when designId is missing, behavior is unchanged from the
    // single-file pipeline.
    const exportOpts: Parameters<typeof exportArtifact>[3] = {};
    if (req.format === 'zip' && req.designId) {
      const db = getDb();
      if (db) {
        const assets = designFilesToZipAssets(db, req.designId);
        if (assets.length > 0) exportOpts.zipAssets = assets;
      }
    }

    // All five formats ship in tier 1; the heavy deps load lazily inside
    // exportArtifact. Errors propagate to the renderer as toasts (PRINCIPLES §10).
    const result = await exportArtifact(req.format, req.htmlContent, picked.filePath, exportOpts);
    return { status: 'saved', path: result.path, bytes: result.bytes };
  });
}
