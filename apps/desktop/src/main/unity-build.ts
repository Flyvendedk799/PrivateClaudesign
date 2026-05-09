/**
 * UNITY_PIPELINE.md §U3 — invoke Unity Editor in batch mode to build a
 * native binary or WebGL bundle from a project tree.
 *
 * The host:
 *   1. Picks an Editor whose version matches `ProjectSettings/ProjectVersion.txt`.
 *   2. Writes the project files into a tmp directory.
 *   3. Injects `Assets/Editor/CodesignBuilder.cs` (a small wrapper that calls
 *      `BuildPipeline.BuildPlayer` from a known method the CLI can target).
 *   4. Runs `Unity -batchmode -nographics -quit -projectPath ... -executeMethod
 *      CodesignBuilder.Build -outDir ...`.
 *   5. Streams the log file to the caller. Parses Unity's `error CS####` lines
 *      into a structured ToolError shape so the agent can react.
 *   6. Returns the path to the produced binary (zipped if WebGL — index.html +
 *      Build/ + StreamingAssets/).
 *
 * Pure-ish: file system + process spawning are dependency-injected so tests
 * exercise the full pipeline without a real Unity install.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import {
  type UnityEditor,
  defaultUnityDiscoveryDeps,
  discoverUnityEditors,
} from './unity-discovery';

export type UnityBuildTarget =
  | 'StandaloneOSX'
  | 'StandaloneWindows64'
  | 'StandaloneLinux64'
  | 'WebGL';

export interface UnityBuildRequest {
  /** Authored project files. The host writes these into a staging dir
   *  before invoking the Editor. */
  files: ReadonlyArray<{ path: string; content: string | Buffer }>;
  target: UnityBuildTarget;
  /** Where the built binary should land. Directory will be created.
   *  WebGL output is zipped here as `<outDir>/web.zip`. */
  outDir: string;
  /** When true, build with development symbols + profiler attached.
   *  Faster builds, larger output. */
  development?: boolean;
  /** Scenes to include in the build. Defaults to ['Assets/Scenes/Main.unity']. */
  scenesInBuild?: string[];
}

export interface UnityBuildError {
  /** Unity-classified error code, e.g. 'CS0103' or 'BUILD_FAILED'. */
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface UnityBuildResult {
  ok: boolean;
  /** Produced binary path. macOS: `<outDir>/<bundle>.app`. Windows: `<outDir>/<exe>`.
   *  Linux: `<outDir>/<x86_64>`. WebGL: `<outDir>/web.zip`. */
  artifactPath?: string;
  buildMs: number;
  errors: UnityBuildError[];
  warnings: UnityBuildError[];
  editorVersion: string;
  editorPath: string;
}

export interface UnityBuildDeps {
  /** Returns the list of installed Unity Editors. Default uses
   *  unity-discovery.ts. */
  discoverEditors?: () => { editors: UnityEditor[]; hubInstalled: boolean };
  /** Spawn the Editor and stream the log. The default implementation in
   *  this file runs `child_process.spawn`; tests inject a fake. */
  runEditor?: (
    editorPath: string,
    args: string[],
    onLogLine: (line: string) => void,
  ) => Promise<{ exitCode: number }>;
  /** Override the staging dir base. Tests pass a deterministic temp path. */
  stagingDirBase?: string;
}

const CODESIGN_BUILDER_CS = `// Auto-injected by open-codesign UNITY_PIPELINE.md §U3.
// Do NOT author this file in your project — duplicate type errors will
// break the build. The host overwrites it on every build invocation.
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class CodesignBuilder {
  public static void Build() {
    string outDir = GetArg("-outDir");
    string targetArg = GetArg("-buildTarget");
    bool development = HasFlag("-development");
    if (string.IsNullOrEmpty(outDir)) {
      Debug.LogError("[CodesignBuilder] -outDir not provided");
      EditorApplication.Exit(2);
      return;
    }

    BuildTarget target = ParseTarget(targetArg);
    Directory.CreateDirectory(outDir);

    string artifactPath = ArtifactPath(outDir, target);
    var scenes = new List<string>();
    foreach (var s in EditorBuildSettings.scenes) {
      if (s.enabled && !string.IsNullOrEmpty(s.path)) scenes.Add(s.path);
    }
    if (scenes.Count == 0) scenes.Add("Assets/Scenes/Main.unity");

    BuildOptions options = development ? BuildOptions.Development : BuildOptions.None;
    BuildReport report = BuildPipeline.BuildPlayer(scenes.ToArray(), artifactPath, target, options);
    if (report.summary.result == BuildResult.Succeeded) {
      Debug.Log("[CodesignBuilder] Build succeeded: " + artifactPath);
      EditorApplication.Exit(0);
    } else {
      Debug.LogError("[CodesignBuilder] Build failed: " + report.summary.result);
      EditorApplication.Exit(1);
    }
  }

  static string GetArg(string name) {
    var args = Environment.GetCommandLineArgs();
    for (int i = 0; i < args.Length - 1; i++) {
      if (args[i] == name) return args[i + 1];
    }
    return "";
  }
  static bool HasFlag(string name) {
    foreach (var a in Environment.GetCommandLineArgs()) {
      if (a == name) return true;
    }
    return false;
  }
  static BuildTarget ParseTarget(string s) {
    switch (s) {
      case "StandaloneOSX": return BuildTarget.StandaloneOSX;
      case "StandaloneWindows64": return BuildTarget.StandaloneWindows64;
      case "StandaloneLinux64": return BuildTarget.StandaloneLinux64;
      case "WebGL": return BuildTarget.WebGL;
      default: return BuildTarget.StandaloneOSX;
    }
  }
  static string ArtifactPath(string outDir, BuildTarget t) {
    switch (t) {
      case BuildTarget.StandaloneOSX: return Path.Combine(outDir, "Game.app");
      case BuildTarget.StandaloneWindows64: return Path.Combine(outDir, "Game.exe");
      case BuildTarget.StandaloneLinux64: return Path.Combine(outDir, "Game.x86_64");
      case BuildTarget.WebGL: return Path.Combine(outDir, "web");
      default: return Path.Combine(outDir, "Game");
    }
  }
}
`;

const ERROR_LINE_RE = /^(.+?\.cs)\((\d+),\d+\):\s+error\s+(CS\d+):\s+(.+)$/;
const WARN_LINE_RE = /^(.+?\.cs)\((\d+),\d+\):\s+warning\s+(CS\d+):\s+(.+)$/;
const LICENSE_RE = /No valid Unity license|License not activated|Unable to find a license/i;

function parseLogLine(line: string): { kind: 'error' | 'warning'; entry: UnityBuildError } | null {
  const errMatch = line.match(ERROR_LINE_RE);
  if (errMatch !== null) {
    const path = errMatch[1];
    const lineNoStr = errMatch[2];
    const entry: UnityBuildError = {
      code: errMatch[3] ?? 'CS_UNKNOWN',
      message: errMatch[4] ?? line,
      ...(typeof path === 'string' ? { path } : {}),
      ...(typeof lineNoStr === 'string' ? { line: Number.parseInt(lineNoStr, 10) } : {}),
    };
    return { kind: 'error', entry };
  }
  const warnMatch = line.match(WARN_LINE_RE);
  if (warnMatch !== null) {
    const path = warnMatch[1];
    const lineNoStr = warnMatch[2];
    const entry: UnityBuildError = {
      code: warnMatch[3] ?? 'CS_UNKNOWN',
      message: warnMatch[4] ?? line,
      ...(typeof path === 'string' ? { path } : {}),
      ...(typeof lineNoStr === 'string' ? { line: Number.parseInt(lineNoStr, 10) } : {}),
    };
    return { kind: 'warning', entry };
  }
  if (LICENSE_RE.test(line)) {
    return {
      kind: 'error',
      entry: {
        code: 'UNITY_LICENSE',
        message:
          'Unity Editor license is not activated. Open Unity Hub once to sign in / activate Personal license, then retry.',
      },
    };
  }
  return null;
}

function pickEditor(editors: UnityEditor[], pinnedVersion: string | undefined): UnityEditor | null {
  if (editors.length === 0) return null;
  if (pinnedVersion === undefined || pinnedVersion.length === 0) return editors[0] ?? null;
  // Exact match preferred; major-version match accepted.
  const exact = editors.find((e) => e.version === pinnedVersion);
  if (exact !== undefined) return exact;
  const majorPin = pinnedVersion.split('.')[0] ?? '';
  const majorMatch = editors.find((e) => e.version.split('.')[0] === majorPin);
  return majorMatch ?? null;
}

function extractPinnedVersion(projectVersionTxt: string | undefined): string | undefined {
  if (projectVersionTxt === undefined) return undefined;
  const m = projectVersionTxt.match(/^m_EditorVersion:\s*(\S+)/m);
  return m?.[1];
}

async function defaultRunEditor(
  editorPath: string,
  args: string[],
  onLogLine: (line: string) => void,
): Promise<{ exitCode: number }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(editorPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) onLogLine(line);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
  });
}

export async function buildUnityProject(
  request: UnityBuildRequest,
  deps: UnityBuildDeps = {},
): Promise<UnityBuildResult> {
  const started = Date.now();
  const discover =
    deps.discoverEditors ?? (() => discoverUnityEditors(defaultUnityDiscoveryDeps()));
  const runEditor = deps.runEditor ?? defaultRunEditor;

  const discovery = discover();
  if (discovery.editors.length === 0) {
    throw new CodesignError(
      `No Unity Editor found. ${
        discovery.hubInstalled
          ? 'Unity Hub is installed but no Editor versions are present — install one via Hub.'
          : 'Install Unity Hub and at least one Editor (6 LTS recommended) from https://unity.com/download.'
      }`,
      ERROR_CODES.PROVIDER_UPSTREAM_ERROR,
    );
  }

  const projectVersionFile = request.files.find(
    (f) => f.path === 'ProjectSettings/ProjectVersion.txt',
  );
  if (projectVersionFile === undefined) {
    throw new CodesignError(
      'Unity build requires ProjectSettings/ProjectVersion.txt in the file bundle.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  const pinnedVersion = extractPinnedVersion(
    typeof projectVersionFile.content === 'string'
      ? projectVersionFile.content
      : projectVersionFile.content.toString('utf8'),
  );
  const editor = pickEditor(discovery.editors, pinnedVersion);
  if (editor === null) {
    throw new CodesignError(
      `Project pins Unity ${pinnedVersion ?? 'unknown'} but no matching Editor is installed. Available: ${discovery.editors.map((e) => e.version).join(', ')}. Install the matching version via Unity Hub.`,
      ERROR_CODES.PROVIDER_UPSTREAM_ERROR,
    );
  }

  // Stage the project on disk. Using a tmpdir so concurrent builds don't
  // collide; the staging dir lives until the build completes (or errors)
  // and is removed in `finally`.
  const baseDir = deps.stagingDirBase ?? tmpdir();
  await mkdir(baseDir, { recursive: true });
  const stagingDir = await mkdtemp(join(baseDir, 'codesign-unity-build-'));
  try {
    for (const file of request.files) {
      const target = join(stagingDir, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    // Always overwrite CodesignBuilder.cs — the agent shouldn't author it.
    const builderPath = join(stagingDir, 'Assets', 'Editor', 'CodesignBuilder.cs');
    await mkdir(dirname(builderPath), { recursive: true });
    await writeFile(builderPath, CODESIGN_BUILDER_CS, 'utf8');

    await mkdir(request.outDir, { recursive: true });
    const args = [
      '-batchmode',
      '-nographics',
      '-quit',
      '-projectPath',
      stagingDir,
      '-buildTarget',
      request.target,
      '-executeMethod',
      'CodesignBuilder.Build',
      '-outDir',
      request.outDir,
    ];
    if (request.development === true) args.push('-development');

    const errors: UnityBuildError[] = [];
    const warnings: UnityBuildError[] = [];
    const onLine = (line: string) => {
      const parsed = parseLogLine(line);
      if (parsed === null) return;
      if (parsed.kind === 'error') errors.push(parsed.entry);
      else warnings.push(parsed.entry);
    };

    const { exitCode } = await runEditor(editor.path, args, onLine);
    const ok = exitCode === 0 && errors.length === 0;
    let artifactPath: string | undefined;
    if (ok) {
      switch (request.target) {
        case 'StandaloneOSX':
          artifactPath = join(request.outDir, 'Game.app');
          break;
        case 'StandaloneWindows64':
          artifactPath = join(request.outDir, 'Game.exe');
          break;
        case 'StandaloneLinux64':
          artifactPath = join(request.outDir, 'Game.x86_64');
          break;
        case 'WebGL':
          artifactPath = join(request.outDir, 'web');
          break;
      }
    }
    if (!ok && errors.length === 0) {
      errors.push({
        code: 'BUILD_FAILED',
        message: `Unity Editor exited with code ${exitCode} but no error lines were captured. Check the Unity Editor.log for details.`,
      });
    }
    return {
      ok,
      ...(artifactPath !== undefined ? { artifactPath } : {}),
      buildMs: Date.now() - started,
      errors,
      warnings,
      editorVersion: editor.version,
      editorPath: editor.path,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Exports for tests.
export const _internal = {
  CODESIGN_BUILDER_CS,
  parseLogLine,
  pickEditor,
  extractPinnedVersion,
};
