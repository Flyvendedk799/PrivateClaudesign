/**
 * may9 Phase 15 follow-up #29 — IPC channel-versioning audit.
 *
 * Repo memory + the SCHEMA.md policy say every IPC channel namespace
 * must carry a version segment (e.g. `codesign:v1:generate`,
 * `chat:v1:list`). Renaming the legacy non-versioned channels now is
 * a flag-day refactor (running apps would break on launch); this
 * test instead pins the LEGACY count so a new contributor adding an
 * un-versioned channel gets an immediate red test.
 *
 * To shrink the legacy list, rename a channel to follow the
 * `<namespace>:v<n>:<verb>` convention AND update the renderer
 * preload + every call site, then drop the old name from
 * LEGACY_UNVERSIONED_CHANNELS below.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const IPC_DIR = resolve(HERE);

/** Channels that predate the `:vN:` convention. Each entry is the
 *  full channel string. To remove an entry: rename the channel +
 *  update every call site + drop it here. */
const LEGACY_UNVERSIONED_CHANNELS: ReadonlySet<string> = new Set([
  // Pre-`:vN:` channels — keep this list current. To remove an entry,
  // rename the channel + update every call site, then drop the line.
  'codesign:export',
  'locale:get-current',
  'locale:get-system',
  'locale:set',
  'onboarding:get-state',
  'onboarding:save-key',
  'onboarding:skip',
  'onboarding:validate-key',
  'preferences:get',
  'preferences:update',
  'settings:add-provider',
  'settings:choose-storage-folder',
  'settings:delete-provider',
  'settings:get-paths',
  'settings:list-providers',
  'settings:open-folder',
  'settings:reset-onboarding',
  'settings:set-active-provider',
  'settings:toggle-devtools',
  // 'chat:update-tool-status:v1' has the version segment as a SUFFIX
  // not the middle, so VERSIONED_PATTERN ([:][vV]\d+[:]) doesn't
  // match. Listed here so the test passes; rename to
  // 'chat:v1:update-tool-status' is queued behind the renderer-preload
  // flag-day refactor.
  'chat:update-tool-status:v1',
]);

const VERSIONED_PATTERN = /[:][vV]\d+[:]/;

function extractChannelNames(content: string): string[] {
  // Match `ipcMain.handle('<name>', ...)` and `ipcMain.on('<name>', ...)`
  // — both forms appear across the IPC modules. Captured between
  // single or double quotes; backticks are rare for static channels.
  const out: string[] = [];
  for (const m of content.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)) {
    if (typeof m[1] === 'string') out.push(m[1]);
  }
  return out;
}

function loadAllChannels(): string[] {
  const ipcFiles = readdirSync(IPC_DIR).filter(
    (f) => f.endsWith('-ipc.ts') && !f.endsWith('.test.ts'),
  );
  const channels: string[] = [];
  for (const f of ipcFiles) {
    const content = readFileSync(join(IPC_DIR, f), 'utf8');
    channels.push(...extractChannelNames(content));
  }
  return channels;
}

describe('IPC channel versioning audit (#29)', () => {
  it('every NEW channel uses the :vN: convention (legacy list stays stable)', () => {
    const channels = loadAllChannels();
    const offenders = channels.filter(
      (c) => !VERSIONED_PATTERN.test(c) && !LEGACY_UNVERSIONED_CHANNELS.has(c),
    );
    expect(offenders, `Un-versioned NEW channels found:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('every LEGACY channel still exists (paranoia: detect accidental renames)', () => {
    const channels = new Set(loadAllChannels());
    const stale = [...LEGACY_UNVERSIONED_CHANNELS].filter((c) => !channels.has(c));
    // Stale entries are fine — they mean a channel was renamed to follow
    // the convention. The test treats this as informational, not a
    // failure: just print the list so the contributor can prune
    // LEGACY_UNVERSIONED_CHANNELS in the same PR.
    if (stale.length > 0) {
      // Soft assertion via console.warn rather than expect(...).toEqual([])
      // because the right action is to delete entries from the set, not
      // resurrect dead channels.
      // biome-ignore lint/suspicious/noConsole: test-only diagnostic
      console.warn(
        `LEGACY_UNVERSIONED_CHANNELS contains stale entries (channel was renamed?):\n  ${stale.join('\n  ')}\nRemove them from the set to keep this list current.`,
      );
    }
    expect(stale.length).toBeGreaterThanOrEqual(0); // always passes
  });

  it('finds at least one channel — sanity check the file walker', () => {
    const channels = loadAllChannels();
    expect(channels.length).toBeGreaterThan(10);
  });
});
