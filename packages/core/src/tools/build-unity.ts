/**
 * UNITY_PIPELINE.md §U3 — `build_unity` agent tool.
 *
 * Async (~3–10 min). Invokes the host's `BuildUnityFn` (wired by the
 * desktop main process to spawn Unity Editor in batch mode). Returns
 * the path to the produced binary + structured error/warning lists.
 *
 * Registered ONLY when the host wires a build callback (i.e. Unity is
 * detected on the user's machine). Without it the agent gets the
 * project-export path and the user opens the project in Unity Hub by hand.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { type CoreLogger, NOOP_LOGGER } from '../logger.js';

const BuildUnityParams = Type.Object({
  target: Type.Union([
    Type.Literal('StandaloneOSX'),
    Type.Literal('StandaloneWindows64'),
    Type.Literal('StandaloneLinux64'),
    Type.Literal('WebGL'),
  ]),
  development: Type.Optional(
    Type.Boolean({
      description:
        'Build with development symbols + profiler attached. Faster compile, ' +
        'larger output. Default: false (release build).',
    }),
  ),
});

export interface BuildUnityRequest {
  /** Project files (Assets/, Packages/, ProjectSettings/, ...). The host
   *  reads them from the agent's virtual FS before invoking. */
  files: ReadonlyArray<{ path: string; content: string | Buffer }>;
  target: 'StandaloneOSX' | 'StandaloneWindows64' | 'StandaloneLinux64' | 'WebGL';
  outDir: string;
  development?: boolean;
}

export interface BuildUnityError {
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface BuildUnityResult {
  ok: boolean;
  artifactPath?: string;
  buildMs: number;
  errors: BuildUnityError[];
  warnings: BuildUnityError[];
  editorVersion: string;
  editorPath: string;
}

export type BuildUnityFn = (
  request: BuildUnityRequest,
  signal?: AbortSignal,
) => Promise<BuildUnityResult>;

export interface BuildUnityToolDeps {
  /** Returns the project files the agent has authored. */
  listFiles: () => Array<{ path: string; content: string }>;
  /** Resolves to the directory where the host wants the binary to land
   *  for this design. The agent's tool result references this path. */
  resolveOutDir: (target: BuildUnityResult['editorVersion']) => string;
}

export interface BuildUnityToolDetails {
  target: BuildUnityRequest['target'];
  ok: boolean;
  artifactPath?: string;
  buildMs: number;
  errorCount: number;
  warningCount: number;
  editorVersion: string;
}

export function makeBuildUnityTool(
  build: BuildUnityFn,
  deps: BuildUnityToolDeps,
  logger: CoreLogger = NOOP_LOGGER,
): AgentTool<typeof BuildUnityParams, BuildUnityToolDetails> {
  return {
    name: 'build_unity',
    label: 'Build Unity binary',
    description:
      'Invoke Unity Editor in batch mode to produce a runnable binary from the authored project tree. ' +
      'Async (~3–10 min depending on target). Output: macOS .app bundle, Windows .exe, Linux .x86_64, ' +
      'or WebGL bundle. Use only after authoring the full Unity project (Assets/, Packages/, ProjectSettings/) ' +
      'AND after verify_unity_matches_preview reports OK. Failed builds return CS#### compile errors the agent ' +
      'can fix in-loop. Skips silently if the host has not detected a Unity Editor install.',
    parameters: BuildUnityParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<BuildUnityToolDetails>> {
      const files = deps.listFiles();
      const outDir = deps.resolveOutDir(params.target);
      logger.info('[unity_build] step=start', {
        target: params.target,
        development: params.development ?? false,
        fileCount: files.length,
        outDir,
      });
      const started = Date.now();
      let result: BuildUnityResult;
      try {
        result = await build(
          {
            files,
            target: params.target,
            outDir,
            ...(params.development !== undefined ? { development: params.development } : {}),
          },
          signal,
        );
      } catch (err) {
        logger.error('[unity_build] step=fail', {
          target: params.target,
          ms: Date.now() - started,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      logger.info(result.ok ? '[unity_build] step=ok' : '[unity_build] step=fail', {
        target: params.target,
        ok: result.ok,
        editor: result.editorVersion,
        errors: result.errors.length,
        warnings: result.warnings.length,
        buildMs: result.buildMs,
        artifact: result.artifactPath ?? null,
      });

      const lines: string[] = [];
      if (result.ok && result.artifactPath !== undefined) {
        lines.push(`Unity ${params.target} build OK → ${result.artifactPath}`);
        lines.push(`  Editor: Unity ${result.editorVersion}`);
        lines.push(`  Build time: ${(result.buildMs / 1000).toFixed(1)}s`);
        if (result.warnings.length > 0) {
          lines.push(`  ${result.warnings.length} warning(s) — ignored unless you choose to fix.`);
        }
      } else {
        lines.push(`Unity ${params.target} build FAILED (${result.errors.length} error(s)).`);
        lines.push(`  Editor: Unity ${result.editorVersion}`);
        lines.push(`  Build time: ${(result.buildMs / 1000).toFixed(1)}s`);
        for (const e of result.errors.slice(0, 8)) {
          const loc = e.path !== undefined ? ` ${e.path}:${e.line ?? '?'}` : '';
          lines.push(`  ${e.code}${loc}: ${e.message}`);
        }
        if (result.errors.length > 8) {
          lines.push(`  …and ${result.errors.length - 8} more error(s).`);
        }
      }

      const details: BuildUnityToolDetails = {
        target: params.target,
        ok: result.ok,
        ...(result.artifactPath !== undefined ? { artifactPath: result.artifactPath } : {}),
        buildMs: result.buildMs,
        errorCount: result.errors.length,
        warningCount: result.warnings.length,
        editorVersion: result.editorVersion,
      };
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details,
      };
    },
  };
}
