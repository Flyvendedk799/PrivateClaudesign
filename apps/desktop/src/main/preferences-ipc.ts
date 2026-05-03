/**
 * User preferences IPC handlers (main process).
 *
 * Persists non-provider, non-locale preferences to
 * `~/.config/open-codesign/preferences.json`.  Kept separate from config.toml
 * so it can be read quickly at boot before the TOML loader finishes.
 *
 * Schema: { schemaVersion: 1, updateChannel: 'stable'|'beta', generationTimeoutSec: number }
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import { ipcMain } from 'electron';
import { configDir } from './config';
import { getLogger } from './logger';

const logger = getLogger('preferences-ipc');

const SCHEMA_VERSION = 6;
// v1 → v2: raise the abandoned 120s timeout default (which aborted real
// agentic runs mid-loop) to 600s. Values that happen to equal the old
// default are treated as unmigrated defaults, not user intent.
const V1_DEFAULT_TIMEOUT_SEC = 120;
// v2 -> v3: 600s still clips slower long-form multi-turn runs, so the default
// moves to 1200s.
const V2_DEFAULT_TIMEOUT_SEC = 600;
// v5 -> v6: now that we've switched to single-session execution
// (apps/desktop/src/main/index.ts MAX_AUTO_CONTINUE=1), the entire
// design generation runs inside one outer timeout. 1200s clipped real
// reasoning-on multi-section designs mid-flight (production trace
// 2026-04-27 mogvfm77 needed ~25 min to land 2 str_replaces with
// reasoning='medium'). Default to 2700s (45 min) — generous enough for
// big briefs with reasoning, still finite. Users on fast endpoints can
// lower it in Settings → Advanced.
const V5_DEFAULT_TIMEOUT_SEC = 1200;
/** v6 default — kept as a named constant so the migration check below
 *  reads symbolically and the DEFAULTS literal stays the source of truth. */
const V6_DEFAULT_TIMEOUT_SEC = 2700;

function prefsFile(): string {
  return join(configDir(), 'preferences.json');
}

export type UpdateChannel = 'stable' | 'beta';

export interface Preferences {
  updateChannel: UpdateChannel;
  generationTimeoutSec: number;
  checkForUpdatesOnStartup: boolean;
  dismissedUpdateVersion: string;
  /** Epoch ms of the last time the user opened the Diagnostics panel.
   *  Persisted so the unread-error badge doesn't flash every historical
   *  error after a restart. */
  diagnosticsLastReadTs: number;
  /** gameplan §A6 / Q2 — the last mode picked in the New-design dialog.
   *  The dialog opens to this tab on next launch. Defaults to 'design'. */
  lastPickedMode: 'design' | 'game';
}

interface PreferencesFile extends Preferences {
  schemaVersion: number;
}

const DEFAULTS: Preferences = {
  updateChannel: 'stable',
  // Single-session default (post-2026-04-27 framework simplification):
  // the whole design generation runs inside ONE outer timeout — no more
  // chunked re-planning. 2700s = 45 min is generous enough for big
  // reasoning-on briefs without being unbounded. Lower in Settings →
  // Advanced for fast endpoints.
  generationTimeoutSec: V6_DEFAULT_TIMEOUT_SEC,
  checkForUpdatesOnStartup: true,
  dismissedUpdateVersion: '',
  diagnosticsLastReadTs: 0,
  lastPickedMode: 'design',
};

/** Deterministic parse of the on-disk preferences file. No clock reads: the
 *  diagnosticsLastReadTs seed for migrating installs is applied by the caller
 *  in `readPersisted` so a missing field doesn't slide forward on every get. */
function parsePersistedFile(parsed: Partial<PreferencesFile>): Preferences {
  const persistedSchema = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1;
  const rawTimeout =
    typeof parsed.generationTimeoutSec === 'number' && parsed.generationTimeoutSec > 0
      ? parsed.generationTimeoutSec
      : DEFAULTS.generationTimeoutSec;
  const migratedTimeout =
    persistedSchema < 2 && rawTimeout === V1_DEFAULT_TIMEOUT_SEC
      ? DEFAULTS.generationTimeoutSec
      : persistedSchema < 3 && rawTimeout === V2_DEFAULT_TIMEOUT_SEC
        ? DEFAULTS.generationTimeoutSec
        : persistedSchema < 6 && rawTimeout === V5_DEFAULT_TIMEOUT_SEC
          ? DEFAULTS.generationTimeoutSec
          : rawTimeout;
  return {
    updateChannel:
      parsed.updateChannel === 'stable' || parsed.updateChannel === 'beta'
        ? parsed.updateChannel
        : DEFAULTS.updateChannel,
    generationTimeoutSec: migratedTimeout,
    checkForUpdatesOnStartup:
      typeof parsed.checkForUpdatesOnStartup === 'boolean'
        ? parsed.checkForUpdatesOnStartup
        : DEFAULTS.checkForUpdatesOnStartup,
    dismissedUpdateVersion:
      typeof parsed.dismissedUpdateVersion === 'string'
        ? parsed.dismissedUpdateVersion
        : DEFAULTS.dismissedUpdateVersion,
    diagnosticsLastReadTs:
      typeof parsed.diagnosticsLastReadTs === 'number' && parsed.diagnosticsLastReadTs >= 0
        ? parsed.diagnosticsLastReadTs
        : DEFAULTS.diagnosticsLastReadTs,
    lastPickedMode:
      parsed.lastPickedMode === 'design' || parsed.lastPickedMode === 'game'
        ? parsed.lastPickedMode
        : DEFAULTS.lastPickedMode,
  };
}

export async function readPersisted(): Promise<Preferences> {
  const file = prefsFile();
  let rawJson: unknown;
  try {
    const text = await readFile(file, 'utf8');
    rawJson = JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw new CodesignError(
      `Failed to read preferences at ${file}: ${err instanceof Error ? err.message : String(err)}`,
      'PREFERENCES_READ_FAILED',
    );
  }
  const parsed = parsePersistedFile((rawJson ?? {}) as Partial<PreferencesFile>);
  if (typeof rawJson === 'object' && rawJson !== null) {
    const r = rawJson as Record<string, unknown>;
    const persistedSchema = typeof r['schemaVersion'] === 'number' ? r['schemaVersion'] : 1;
    // One-time migration seed: users upgrading from schema < 5 have no record
    // of when they last read Diagnostics. Without a persisted seed, every
    // readPersisted call would mint a fresh Date.now(), sliding the "last
    // read" baseline forward and masking newer errors before the user ever
    // opens the panel. Seed once and write back synchronously so subsequent
    // reads return the same ts. Fresh installs (ENOENT above) skip this
    // branch and stay at 0 — their diagnostics DB is empty anyway.
    const wasMissingDiagnosticsField = r['diagnosticsLastReadTs'] === undefined;
    // The v5→v6 generationTimeoutSec migration in parsePersistedFile rewrites
    // the in-memory value but, before this commit, only persisted on the
    // diagnostics-seed path above — so a v5 install with a persisted
    // diagnosticsLastReadTs would never write the bumped schemaVersion / new
    // timeout to disk and would re-apply the migration on every read. Detect
    // an applied timeout migration and write back so the file matches what
    // the runtime actually uses.
    const persistedRawTimeout =
      typeof r['generationTimeoutSec'] === 'number' && r['generationTimeoutSec'] > 0
        ? r['generationTimeoutSec']
        : undefined;
    const timeoutMigrationApplied =
      persistedRawTimeout !== undefined && persistedRawTimeout !== parsed.generationTimeoutSec;
    const schemaBumpNeeded = persistedSchema < SCHEMA_VERSION;
    if (schemaBumpNeeded && (wasMissingDiagnosticsField || timeoutMigrationApplied)) {
      const seeded: Preferences = wasMissingDiagnosticsField
        ? { ...parsed, diagnosticsLastReadTs: Date.now() }
        : parsed;
      try {
        await writePersisted(seeded);
      } catch (err) {
        logger.warn('preferences.migration.persistSeed.fail', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return seeded;
    }
  }
  return parsed;
}

async function writePersisted(prefs: Preferences): Promise<void> {
  const file = prefsFile();
  await mkdir(dirname(file), { recursive: true });
  const payload: PreferencesFile = { schemaVersion: SCHEMA_VERSION, ...prefs };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parsePreferences(raw: unknown): Partial<Preferences> {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('preferences:update expects an object', ERROR_CODES.IPC_BAD_INPUT);
  }
  const r = raw as Record<string, unknown>;
  const out: Partial<Preferences> = {};
  if (r['updateChannel'] !== undefined) {
    if (r['updateChannel'] !== 'stable' && r['updateChannel'] !== 'beta') {
      throw new CodesignError(
        'updateChannel must be "stable" or "beta"',
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    out.updateChannel = r['updateChannel'] as UpdateChannel;
  }
  if (r['generationTimeoutSec'] !== undefined) {
    if (typeof r['generationTimeoutSec'] !== 'number' || r['generationTimeoutSec'] <= 0) {
      throw new CodesignError(
        'generationTimeoutSec must be a positive number',
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    out.generationTimeoutSec = r['generationTimeoutSec'];
  }
  if (r['checkForUpdatesOnStartup'] !== undefined) {
    if (typeof r['checkForUpdatesOnStartup'] !== 'boolean') {
      throw new CodesignError(
        'checkForUpdatesOnStartup must be a boolean',
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    out.checkForUpdatesOnStartup = r['checkForUpdatesOnStartup'];
  }
  if (r['dismissedUpdateVersion'] !== undefined) {
    if (typeof r['dismissedUpdateVersion'] !== 'string') {
      throw new CodesignError('dismissedUpdateVersion must be a string', ERROR_CODES.IPC_BAD_INPUT);
    }
    out.dismissedUpdateVersion = r['dismissedUpdateVersion'];
  }
  if (r['diagnosticsLastReadTs'] !== undefined) {
    if (typeof r['diagnosticsLastReadTs'] !== 'number' || r['diagnosticsLastReadTs'] < 0) {
      throw new CodesignError(
        'diagnosticsLastReadTs must be a non-negative number',
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    out.diagnosticsLastReadTs = r['diagnosticsLastReadTs'];
  }
  return out;
}

export function registerPreferencesIpc(): void {
  // ── Preferences v1 channels ─────────────────────────────────────────────────

  ipcMain.handle('preferences:v1:get', async (): Promise<Preferences> => {
    return readPersisted();
  });

  ipcMain.handle('preferences:v1:update', async (_e, raw: unknown): Promise<Preferences> => {
    const patch = parsePreferences(raw);
    const current = await readPersisted();
    const next: Preferences = { ...current, ...patch };
    await writePersisted(next);
    return next;
  });

  // ── Preferences legacy shims (schedule removal next minor) ──────────────────

  ipcMain.handle('preferences:get', async (): Promise<Preferences> => {
    logger.warn('legacy preferences:get channel used, schedule removal next minor');
    return readPersisted();
  });

  ipcMain.handle('preferences:update', async (_e, raw: unknown): Promise<Preferences> => {
    logger.warn('legacy preferences:update channel used, schedule removal next minor');
    const patch = parsePreferences(raw);
    const current = await readPersisted();
    const next: Preferences = { ...current, ...patch };
    await writePersisted(next);
    return next;
  });
}
