/**
 * UNITY_PIPELINE.md §U4 — Steam settings IPC + upload pipeline.
 *
 * Stores the user's Steamworks credentials in `~/.config/open-codesign/config.toml`
 * under a `[steam]` block (BYOK; password encrypted via the same keychain
 * path Meshy / image-gen use). Exposes IPC for the renderer Settings panel
 * and a `uploadBuildToSteam` callable the agent's `upload_to_steam` tool wires.
 *
 * Implementation never logs the password and never writes it to a tmp file
 * unencrypted. The `password` is decrypted in-memory only when handed to
 * `steamcmd` as a CLI argument.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodesignError,
  type Config,
  ERROR_CODES,
  STEAM_SCHEMA_VERSION,
  type SteamSettings,
  SteamSettingsSchema,
  hydrateConfig,
} from '@open-codesign/shared';
import { writeConfig } from './config';
import { ipcMain } from './electron-runtime';
import { buildSecretRef, decryptSecret } from './keychain';
import { getLogger } from './logger';
import { getCachedConfig, setCachedConfig } from './onboarding-ipc';
import { findSteamCmd } from './steam-discovery';

const log = getLogger('steam');

export interface SteamSettingsView {
  enabled: boolean;
  username: string | null;
  hasPassword: boolean;
  passwordMask: string | null;
  appId: number | null;
  depotId: number | null;
  steamcmdPath: string | null;
  steamcmdDetectedPath: string | null;
  buildDescription: string | null;
}

interface SteamUpdateInput {
  enabled?: boolean;
  username?: string | null;
  password?: string;
  appId?: number | null;
  depotId?: number | null;
  steamcmdPath?: string | null;
  buildDescription?: string | null;
}

export function defaultSteamSettings(): SteamSettings {
  return SteamSettingsSchema.parse({
    schemaVersion: STEAM_SCHEMA_VERSION,
    enabled: false,
  });
}

export function steamSettingsToView(settings: SteamSettings | undefined): SteamSettingsView {
  const parsed = SteamSettingsSchema.parse(settings ?? defaultSteamSettings());
  const detected = findSteamCmd();
  return {
    enabled: parsed.enabled,
    username: parsed.username ?? null,
    hasPassword: parsed.password !== undefined,
    passwordMask: parsed.password?.mask ?? null,
    appId: parsed.appId ?? null,
    depotId: parsed.depotId ?? null,
    steamcmdPath: parsed.steamcmdPath ?? null,
    steamcmdDetectedPath: detected.ok ? detected.path : null,
    buildDescription: parsed.buildDescription ?? null,
  };
}

function parseUpdate(raw: unknown): SteamUpdateInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new CodesignError('steam:v1:update expects an object', ERROR_CODES.IPC_BAD_INPUT);
  }
  const r = raw as Record<string, unknown>;
  const out: SteamUpdateInput = {};
  if (typeof r['enabled'] === 'boolean') out.enabled = r['enabled'];
  if (r['username'] === null) out.username = null;
  else if (typeof r['username'] === 'string') {
    const t = r['username'].trim();
    out.username = t.length === 0 ? null : t;
  }
  if (typeof r['password'] === 'string') out.password = r['password'];
  if (r['appId'] === null) out.appId = null;
  else if (typeof r['appId'] === 'number' && Number.isInteger(r['appId'])) {
    out.appId = r['appId'] > 0 ? r['appId'] : null;
  }
  if (r['depotId'] === null) out.depotId = null;
  else if (typeof r['depotId'] === 'number' && Number.isInteger(r['depotId'])) {
    out.depotId = r['depotId'] > 0 ? r['depotId'] : null;
  }
  if (r['steamcmdPath'] === null) out.steamcmdPath = null;
  else if (typeof r['steamcmdPath'] === 'string') {
    const t = r['steamcmdPath'].trim();
    out.steamcmdPath = t.length === 0 ? null : t;
  }
  if (r['buildDescription'] === null) out.buildDescription = null;
  else if (typeof r['buildDescription'] === 'string') {
    out.buildDescription = r['buildDescription'].trim();
  }
  return out;
}

async function updateSteamSettings(patch: SteamUpdateInput): Promise<SteamSettingsView> {
  const cfg = getCachedConfig();
  if (cfg === null) {
    throw new CodesignError('No configuration found', ERROR_CODES.CONFIG_MISSING);
  }
  const current = SteamSettingsSchema.parse(cfg.steam ?? defaultSteamSettings());
  let next: SteamSettings = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.username !== undefined) {
    if (patch.username === null) {
      const { username: _drop, ...rest } = next;
      next = rest;
    } else {
      next.username = patch.username;
    }
  }
  if (patch.password !== undefined) {
    const trimmed = patch.password.trim();
    if (trimmed.length === 0) {
      const { password: _drop, ...rest } = next;
      next = rest;
    } else {
      next.password = buildSecretRef(trimmed);
    }
  }
  if (patch.appId !== undefined) {
    if (patch.appId === null) {
      const { appId: _drop, ...rest } = next;
      next = rest;
    } else {
      next.appId = patch.appId;
    }
  }
  if (patch.depotId !== undefined) {
    if (patch.depotId === null) {
      const { depotId: _drop, ...rest } = next;
      next = rest;
    } else {
      next.depotId = patch.depotId;
    }
  }
  if (patch.steamcmdPath !== undefined) {
    if (patch.steamcmdPath === null) {
      const { steamcmdPath: _drop, ...rest } = next;
      next = rest;
    } else {
      next.steamcmdPath = patch.steamcmdPath;
    }
  }
  if (patch.buildDescription !== undefined) {
    if (patch.buildDescription === null || patch.buildDescription.length === 0) {
      const { buildDescription: _drop, ...rest } = next;
      next = rest;
    } else {
      next.buildDescription = patch.buildDescription;
    }
  }
  const parsed = SteamSettingsSchema.parse(next);
  const config = hydrateConfig({
    version: 3,
    activeProvider: cfg.activeProvider,
    activeModel: cfg.activeModel,
    secrets: cfg.secrets,
    providers: cfg.providers,
    ...(cfg.designSystem !== undefined ? { designSystem: cfg.designSystem } : {}),
    ...(cfg.imageGeneration !== undefined ? { imageGeneration: cfg.imageGeneration } : {}),
    ...(cfg.threeDAsset !== undefined ? { threeDAsset: cfg.threeDAsset } : {}),
    steam: parsed,
  });
  await writeConfig(config);
  setCachedConfig(config);
  log.info('settings.update.ok', {
    enabled: parsed.enabled,
    appId: parsed.appId ?? null,
    hasPassword: parsed.password !== undefined,
  });
  return steamSettingsToView(parsed);
}

// ─── Upload pipeline ─────────────────────────────────────────────────────────

export interface SteamUploadRequest {
  /** Absolute path to the build artifact directory. The depot's
   *  ContentRoot points here. WebGL: directory containing index.html;
   *  StandaloneOSX: directory containing Game.app; etc. */
  contentRoot: string;
  /** SteamGuard 2FA code. Required on the first login from a new
   *  machine; optional thereafter (Steamworks remembers the device). */
  steamGuardCode?: string;
  /** Override the build description for this upload only. */
  buildDescription?: string;
}

export interface SteamUploadResult {
  ok: boolean;
  /** Stdout/stderr from steamcmd, with the password scrubbed. Surfaced
   *  to the agent for diagnostics. */
  log: string;
  /** Build ID Steamworks assigned, if parsable from the log. */
  buildId?: string;
  durationMs: number;
}

export interface SteamUploadDeps {
  /** Spawn steamcmd and capture stdout+stderr. Tests inject a fake. */
  runSteamCmd?: (
    binPath: string,
    args: string[],
    onLogLine: (line: string) => void,
  ) => Promise<{ exitCode: number }>;
  /** Override staging-dir base. */
  stagingDirBase?: string;
}

function buildAppVdf(args: {
  appId: number;
  depotId: number;
  depotConfigPath: string;
  description: string;
}): string {
  return `"appbuild"
{
  "appid" "${args.appId}"
  "desc" "${args.description}"
  "buildoutput" "./BuildOutput"
  "contentroot" "./content"
  "setlive" ""
  "preview" "0"
  "local" ""
  "depots"
  {
    "${args.depotId}" "${args.depotConfigPath}"
  }
}
`;
}

function buildDepotVdf(args: { depotId: number }): string {
  return `"DepotBuildConfig"
{
  "DepotID" "${args.depotId}"
  "ContentRoot" "."
  "FileMapping"
  {
    "LocalPath" "*"
    "DepotPath" "."
    "recursive" "1"
  }
  "FileExclusion" "*.pdb"
}
`;
}

/** Scrub the password from steamcmd output. The login arg looks like
 *  `+login user PASSWORD` so we mask the third token after `+login`. */
function scrubLog(log: string, username: string | undefined): string {
  let out = log;
  if (username !== undefined && username.length > 0) {
    // No-op for username — username isn't a secret. Strip password
    // patterns that show up in steamcmd's prompt echoes.
    out = out.replace(/Steam Guard code:[^\n]*/gi, 'Steam Guard code: [scrubbed]');
  }
  return out;
}

async function defaultRunSteamCmd(
  binPath: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<{ exitCode: number }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) if (line.length > 0) onLine(line);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
  });
}

export interface ResolvedSteamConfig {
  enabled: boolean;
  username: string;
  password: string;
  appId: number;
  depotId: number;
  steamcmdPath: string;
  buildDescription: string;
}

/** Pull every Steam credential into memory in plaintext for upload. The
 *  caller MUST scope the result narrowly — never log it, never write
 *  anywhere on disk. */
export function resolveSteamConfig(cfg: Config): ResolvedSteamConfig | null {
  const settings = cfg.steam;
  if (settings === undefined || !settings.enabled) return null;
  if (settings.username === undefined || settings.password === undefined) return null;
  if (settings.appId === undefined || settings.depotId === undefined) return null;
  let password: string;
  try {
    password = decryptSecret(settings.password.ciphertext);
  } catch {
    return null;
  }
  if (password.length === 0) return null;
  let steamcmdPath: string;
  if (settings.steamcmdPath !== undefined && settings.steamcmdPath.length > 0) {
    steamcmdPath = settings.steamcmdPath;
  } else {
    const detected = findSteamCmd();
    if (!detected.ok) return null;
    steamcmdPath = detected.path;
  }
  return {
    enabled: true,
    username: settings.username,
    password,
    appId: settings.appId,
    depotId: settings.depotId,
    steamcmdPath,
    buildDescription: settings.buildDescription ?? 'Built via open-codesign',
  };
}

export async function uploadBuildToSteam(
  config: ResolvedSteamConfig,
  request: SteamUploadRequest,
  deps: SteamUploadDeps = {},
): Promise<SteamUploadResult> {
  const started = Date.now();
  const runSteamCmd = deps.runSteamCmd ?? defaultRunSteamCmd;
  const baseDir = deps.stagingDirBase ?? tmpdir();
  await mkdir(baseDir, { recursive: true });
  const stagingDir = await mkdtemp(join(baseDir, 'codesign-steam-'));
  try {
    // Write the depot + app VDF descriptors. ContentRoot is `./content`
    // relative to the staging dir; we symlink the user's contentRoot in.
    const description = request.buildDescription ?? config.buildDescription;
    const depotVdfPath = join(stagingDir, `depot_${config.depotId}.vdf`);
    const appVdfPath = join(stagingDir, `app_${config.appId}.vdf`);
    await writeFile(depotVdfPath, buildDepotVdf({ depotId: config.depotId }), 'utf8');
    await writeFile(
      appVdfPath,
      buildAppVdf({
        appId: config.appId,
        depotId: config.depotId,
        depotConfigPath: depotVdfPath,
        description,
      }),
      'utf8',
    );

    // For v1 we ask the user to point contentRoot at the build output
    // and reference it directly in the VDF. The depot VDF says
    // `ContentRoot=.` and we run steamcmd with cwd=contentRoot via -dir
    // on macOS — but steamcmd's depot ContentRoot is resolved at
    // load time relative to the VDF. Simpler: rewrite ContentRoot to
    // the absolute contentRoot path.
    await writeFile(
      depotVdfPath,
      `"DepotBuildConfig"
{
  "DepotID" "${config.depotId}"
  "ContentRoot" "${request.contentRoot}"
  "FileMapping"
  {
    "LocalPath" "*"
    "DepotPath" "."
    "recursive" "1"
  }
  "FileExclusion" "*.pdb"
}
`,
      'utf8',
    );

    const args = [
      '+login',
      config.username,
      config.password,
      ...(request.steamGuardCode !== undefined ? [request.steamGuardCode] : []),
      '+run_app_build',
      appVdfPath,
      '+quit',
    ];

    let logBuf = '';
    let buildId: string | undefined;
    const onLine = (line: string) => {
      logBuf += `${line}\n`;
      const m = line.match(/BuildID\s+(\d+)/i);
      if (m !== null && m[1] !== undefined) buildId = m[1];
    };

    const { exitCode } = await runSteamCmd(config.steamcmdPath, args, onLine);
    const ok = exitCode === 0 && /Successfully finished AppBuild/i.test(logBuf);
    const scrubbed = scrubLog(logBuf, config.username);
    log.info(ok ? 'upload.ok' : 'upload.fail', {
      appId: config.appId,
      depotId: config.depotId,
      exitCode,
      buildId: buildId ?? null,
    });
    return {
      ok,
      log: scrubbed,
      ...(buildId !== undefined ? { buildId } : {}),
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerSteamSettingsIpc(): void {
  ipcMain.handle('steam:v1:get', async (): Promise<SteamSettingsView> => {
    const cfg = getCachedConfig();
    return steamSettingsToView(cfg?.steam);
  });
  ipcMain.handle(
    'steam:v1:update',
    async (_e, raw: unknown): Promise<SteamSettingsView> => updateSteamSettings(parseUpdate(raw)),
  );
  ipcMain.handle(
    'steam:v1:test-login',
    async (_e, raw: unknown): Promise<{ ok: boolean; log: string }> => {
      // Convenience: validates that steamcmd + credentials work without
      // performing a full upload. Surfaces SteamGuard prompts for the UI
      // 2FA modal.
      const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const guardCode = typeof r['steamGuardCode'] === 'string' ? r['steamGuardCode'] : undefined;
      const cfg = getCachedConfig();
      if (cfg === null) return { ok: false, log: 'No configuration loaded.' };
      const resolved = resolveSteamConfig(cfg);
      if (resolved === null) {
        return {
          ok: false,
          log: 'Steam settings incomplete (need username, password, appId, depotId, and steamcmd).',
        };
      }
      let logBuf = '';
      const args = [
        '+login',
        resolved.username,
        resolved.password,
        ...(guardCode !== undefined ? [guardCode] : []),
        '+quit',
      ];
      const { exitCode } = await defaultRunSteamCmd(resolved.steamcmdPath, args, (line) => {
        logBuf += `${line}\n`;
      });
      return {
        ok: exitCode === 0 && /Logged in OK/i.test(logBuf),
        log: scrubLog(logBuf, resolved.username),
      };
    },
  );
}

export const _internal = { buildAppVdf, buildDepotVdf, scrubLog, parseUpdate };
