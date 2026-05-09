/**
 * UNITY_PIPELINE.md §U4 — `upload_to_steam` agent tool.
 *
 * Async (~1–10 min depending on diff size). Wraps the host's
 * `UploadToSteamFn` (wired by the desktop main process when Steam
 * settings are configured + steamcmd is on disk). Uploads a built
 * binary to Steam as a non-live build; the user promotes to live
 * via the Steamworks dashboard.
 *
 * Registered ONLY when:
 *   - The host detected `steamcmd` on disk
 *   - The user enabled Steam settings + provided app ID + depot ID + login
 *   - At least one Unity build artifact exists for this design
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { type CoreLogger, NOOP_LOGGER } from '../logger.js';

const UploadToSteamParams = Type.Object({
  /** Absolute path to the built binary directory, returned by `build_unity`. */
  contentRoot: Type.String({
    description:
      'Absolute path to the build output directory (e.g. the `web/` dir for WebGL or the parent dir of `Game.app` for macOS). Steamworks depot uploader recursively packages everything under this path.',
  }),
  steamGuardCode: Type.Optional(
    Type.String({
      description:
        'SteamGuard 2FA code. Required on first login from a new machine. ' +
        'The host opens a modal to capture this from the user — the agent ' +
        'should call upload_to_steam without the code first; if the result ' +
        'reports a SteamGuard prompt, the host re-invokes with the code.',
    }),
  ),
  buildDescription: Type.Optional(
    Type.String({
      description: 'Build description shown in the Steamworks Builds tab.',
    }),
  ),
});

export interface UploadToSteamRequest {
  contentRoot: string;
  steamGuardCode?: string;
  buildDescription?: string;
}

export interface UploadToSteamResult {
  ok: boolean;
  log: string;
  buildId?: string;
  durationMs: number;
}

export type UploadToSteamFn = (
  request: UploadToSteamRequest,
  signal?: AbortSignal,
) => Promise<UploadToSteamResult>;

export interface UploadToSteamDetails {
  ok: boolean;
  buildId: string | null;
  contentRoot: string;
  durationMs: number;
}

export function makeUploadToSteamTool(
  upload: UploadToSteamFn,
  logger: CoreLogger = NOOP_LOGGER,
): AgentTool<typeof UploadToSteamParams, UploadToSteamDetails> {
  return {
    name: 'upload_to_steam',
    label: 'Upload build to Steam',
    description:
      'Upload a built binary to Steamworks via steamcmd. Async (~1–10 min). ' +
      'The build appears in the Steamworks Builds tab as a non-live build — ' +
      'the user promotes it to a beta branch or live from the dashboard. ' +
      'Call ONLY after a successful build_unity. If the host reports a ' +
      'SteamGuard prompt, re-call with steamGuardCode set.',
    parameters: UploadToSteamParams,
    async execute(_id, params, signal): Promise<AgentToolResult<UploadToSteamDetails>> {
      const started = Date.now();
      logger.info('[steam_upload] step=start', {
        contentRoot: params.contentRoot,
        hasGuardCode: params.steamGuardCode !== undefined,
      });
      let result: UploadToSteamResult;
      try {
        result = await upload(
          {
            contentRoot: params.contentRoot,
            ...(params.steamGuardCode !== undefined
              ? { steamGuardCode: params.steamGuardCode }
              : {}),
            ...(params.buildDescription !== undefined
              ? { buildDescription: params.buildDescription }
              : {}),
          },
          signal,
        );
      } catch (err) {
        logger.error('[steam_upload] step=fail', {
          ms: Date.now() - started,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      logger.info(result.ok ? '[steam_upload] step=ok' : '[steam_upload] step=fail', {
        buildId: result.buildId ?? null,
        durationMs: result.durationMs,
      });
      const lines: string[] = [];
      if (result.ok) {
        lines.push(
          `Steam upload OK${result.buildId !== undefined ? ` (BuildID ${result.buildId})` : ''}.`,
        );
        lines.push(
          'Visible in Steamworks → Builds tab. Promote to a beta branch or live from the dashboard.',
        );
        lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
      } else {
        lines.push('Steam upload FAILED.');
        lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
        // Surface the last 30 lines of the (scrubbed) steamcmd log.
        const tail = result.log.split('\n').slice(-30).join('\n');
        if (tail.length > 0) lines.push(`steamcmd log (tail):\n${tail}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          ok: result.ok,
          buildId: result.buildId ?? null,
          contentRoot: params.contentRoot,
          durationMs: result.durationMs,
        },
      };
    },
  };
}
