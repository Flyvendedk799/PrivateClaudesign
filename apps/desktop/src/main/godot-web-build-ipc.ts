/**
 * gameplan §D — IPC wrapper for the Godot web-build pipeline.
 *
 * Channel `codesign:v1:godot-web-build` runs a single build. Progress
 * lines stream out on `codesign:v1:godot-web-build:progress`. On success,
 * the result is registered with `setGodotWebBuildDir` so the
 * `game-files://` protocol handler can serve `_build/{path}` requests.
 *
 * Channel `codesign:v1:godot-cli-status` returns the cached CLI status —
 * the Settings panel reads it.
 */

import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { app } from './electron-runtime';
import { ipcMain } from './electron-runtime';
import { type GodotCliStatus, detectGodotCli } from './godot-cli-detect';
import {
  type DesignFile,
  type GodotBuildProgress,
  type GodotBuildResult,
  runGodotWebBuild,
} from './godot-web-build';
import { setGodotWebBuildDir } from './godot-web-build-registry';
import { listDesignFiles } from './snapshots-db';

const BUILD_CHANNEL = 'codesign:v1:godot-web-build';
const PROGRESS_CHANNEL = 'codesign:v1:godot-web-build:progress';
const STATUS_CHANNEL = 'codesign:v1:godot-cli-status';
const STATUS_REFRESH_CHANNEL = 'codesign:v1:godot-cli-status:refresh';

interface BuildRequest {
  designId: string;
}

export interface BuildResponse {
  ok: boolean;
  buildDir?: string;
  files?: string[];
  reason?: string;
  detail?: string;
}

function parseRequest(raw: unknown): BuildRequest {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('godot-web-build expects { designId }');
  }
  const r = raw as Record<string, unknown>;
  const designId = r['designId'];
  if (typeof designId !== 'string' || designId.length === 0) {
    throw new Error('godot-web-build requires a non-empty designId');
  }
  return { designId };
}

/** Cached so Settings doesn't re-spawn `godot --version` on every read.
 *  Invalidated when the user clicks "Re-detect" in Settings (TODO Phase
 *  D5 — for now first-call wins for the session). */
let cachedCliStatus: GodotCliStatus | null = null;

async function getCliStatus(): Promise<GodotCliStatus> {
  if (cachedCliStatus === null) cachedCliStatus = await detectGodotCli();
  return cachedCliStatus;
}

/** Public for Settings IPC to trigger a re-probe (Phase D5 wiring). */
export async function refreshGodotCliStatus(): Promise<GodotCliStatus> {
  cachedCliStatus = await detectGodotCli();
  return cachedCliStatus;
}

function resultToResponse(result: GodotBuildResult): BuildResponse {
  if (result.ok) {
    return { ok: true, buildDir: result.buildDir, files: result.files };
  }
  return { ok: false, reason: result.reason, detail: result.detail };
}

export function registerGodotWebBuildIpc(
  getWindow: () => BrowserWindow | null,
  getDb: () => BetterSqlite3.Database | null,
): void {
  ipcMain.handle(STATUS_CHANNEL, async (): Promise<GodotCliStatus> => getCliStatus());
  ipcMain.handle(
    STATUS_REFRESH_CHANNEL,
    async (): Promise<GodotCliStatus> => refreshGodotCliStatus(),
  );

  ipcMain.handle(BUILD_CHANNEL, async (_evt, raw: unknown): Promise<BuildResponse> => {
    const req = parseRequest(raw);
    const cli = await getCliStatus();
    if (!cli.ok) {
      return {
        ok: false,
        reason: cli.reason,
        detail:
          cli.reason === 'wrong-version'
            ? `Godot 4.3+ required. Found ${cli.version} at ${cli.path}.`
            : 'Godot CLI not detected on PATH. Install Godot 4.3+ and add it to PATH, then re-detect from Settings.',
      };
    }
    const db = getDb();
    if (db === null) {
      return {
        ok: false,
        reason: 'no-db',
        detail: 'Snapshots database is not available — design files cannot be read.',
      };
    }

    const buildRoot = join(app.getPath('temp'), 'codesign-godot-web');
    const win = getWindow();
    const result = await runGodotWebBuild(req.designId, {
      godotBin: cli.path,
      buildRoot,
      listFiles: (designId): DesignFile[] => {
        const rows = listDesignFiles(db, designId);
        return rows.map((r) => ({ path: r.path, content: r.content }));
      },
      onProgress: (progress: GodotBuildProgress) => {
        try {
          win?.webContents.send(PROGRESS_CHANNEL, { designId: req.designId, ...progress });
        } catch {
          // Window closed mid-build — keep the build going so the user
          // can re-open and pick up the cache. Drop the event silently.
        }
      },
    });

    if (result.ok) setGodotWebBuildDir(req.designId, result.buildDir);
    return resultToResponse(result);
  });
}

export const GODOT_WEB_BUILD_CHANNEL = BUILD_CHANNEL;
export const GODOT_WEB_BUILD_PROGRESS_CHANNEL = PROGRESS_CHANNEL;
export const GODOT_CLI_STATUS_CHANNEL = STATUS_CHANNEL;
export const GODOT_CLI_STATUS_REFRESH_CHANNEL = STATUS_REFRESH_CHANNEL;
