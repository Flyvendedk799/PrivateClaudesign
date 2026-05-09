/**
 * UNITY_PIPELINE.md §U1 — Unity 6 LTS engine adapter.
 *
 * Project-download only (no live preview); the iframe shows a project-shell
 * page identical in spirit to godot.ts. Live preview is intentionally NOT
 * planned for Unity — WebGL builds are 5–15 min/iter, too slow to drive the
 * inner authoring loop. UNITY_PIPELINE §U2 wires a parallel Three.js shadow
 * scene to fill the preview gap; the Unity tree is the export target.
 *
 * Validator catches the foot-guns called out in UNITY_PIPELINE.md
 * "Anti-slop additions for Unity":
 *   - GameObject.Find inside Update() / FixedUpdate() / LateUpdate()
 *   - transform.Translate / transform.Rotate without Time.deltaTime
 *   - Resources.Load("path") whose path doesn't resolve under Assets/Resources/
 *   - Missing project files (ProjectSettings/ProjectVersion.txt, Packages/manifest.json)
 *   - Editor scripts that write assets without AssetDatabase.Refresh()
 */

import type {
  BootstrapOptions,
  GameEngineAdapter,
  InputFile,
  ValidationIssue,
  ValidationResult,
} from './types';

const UNITY_DEFAULT_VERSION = '6000.0';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unityBootstrap(opts: BootstrapOptions): string {
  const version = opts.pinnedVersion ?? UNITY_DEFAULT_VERSION;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${escapeHtml(opts.gameBaseUrl)}" />
<title>Unity project</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0e; color: #e6e6e6;
    font: 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 720px; margin: 4rem auto; padding: 0 2rem; }
  h1 { margin: 0 0 0.5rem; font-size: 1.5rem; font-weight: 600; }
  .sub { color: #9ca3af; margin-bottom: 2rem; }
  .panel { border: 1px solid #2a2a30; border-radius: 8px; padding: 1.25rem;
    background: #15151a; }
  .row { display: flex; justify-content: space-between; gap: 1rem;
    padding: 0.4rem 0; border-bottom: 1px solid #2a2a30; }
  .row:last-child { border-bottom: 0; }
  .row .k { color: #9ca3af; }
  .row .v { color: #e6e6e6; font-family: ui-monospace, Menlo, monospace; }
  .cta { margin-top: 1.5rem; padding: 1rem; border-radius: 6px;
    background: #1f1f25; color: #d1d5db; }
  .cta strong { color: #fff; }
  .cta code { background: #0b0b0e; padding: 1px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Unity ${escapeHtml(version)} project</h1>
    <p class="sub">Live preview is deferred to the Three.js shadow scene (U2). Native + WebGL builds happen via Unity Editor batch mode (U3).</p>
    <div class="panel">
      <div class="row"><span class="k">Engine</span><span class="v">Unity ${escapeHtml(version)}</span></div>
      <div class="row"><span class="k">Entry</span><span class="v">Assets/Scenes/Main.unity</span></div>
      <div class="row"><span class="k">Live preview</span><span class="v">via Three.js shadow scene</span></div>
    </div>
    <div class="cta">
      <strong>To open this project</strong>:<br/>
      Export the bundle (<code>game-unity-project</code>), unzip it, then open the folder in
      Unity Hub. Unity ${escapeHtml(version)}+ is required.
    </div>
  </div>
</body>
</html>`;
}

const UPDATE_FN_RE = /\b(?:void|public|private|protected)?\s*(Update|FixedUpdate|LateUpdate)\s*\(/g;

function unityValidate(files: ReadonlyArray<InputFile>): ValidationResult {
  const issues: ValidationIssue[] = [];
  const filePathSet = new Set(files.map((f) => f.path));

  // Project-level structural checks.
  if (!filePathSet.has('ProjectSettings/ProjectVersion.txt')) {
    issues.push({
      path: 'ProjectSettings/ProjectVersion.txt',
      message:
        'Unity projects must include ProjectSettings/ProjectVersion.txt — Unity Hub reads this to identify the project.',
      severity: 'error',
    });
  }
  if (!filePathSet.has('Packages/manifest.json')) {
    issues.push({
      path: 'Packages/manifest.json',
      message:
        'Unity 6 projects must include Packages/manifest.json. Even an empty `{ "dependencies": {} }` is acceptable.',
      severity: 'error',
    });
  }

  // C# script lints.
  for (const file of files) {
    if (!file.path.endsWith('.cs')) continue;
    const content = file.content;

    // Find each Update/FixedUpdate/LateUpdate body and lint inside.
    for (const match of content.matchAll(UPDATE_FN_RE)) {
      const fnName = match[1] ?? 'Update';
      const startIdx = match.index ?? 0;
      const openBrace = content.indexOf('{', startIdx);
      if (openBrace === -1) continue;
      let depth = 1;
      let i = openBrace + 1;
      for (; i < content.length && depth > 0; i++) {
        const ch = content[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      const body = content.slice(openBrace + 1, i - 1);
      if (/\bGameObject\.Find\s*\(/.test(body)) {
        issues.push({
          path: file.path,
          message: `GameObject.Find inside ${fnName}() runs a string search every frame — cache the reference in Start() / Awake().`,
          severity: 'warn',
        });
      }
      if (
        /\btransform\.(Translate|Rotate)\s*\(/.test(body) &&
        !/Time\.(deltaTime|fixedDeltaTime)/.test(body)
      ) {
        issues.push({
          path: file.path,
          message: `${fnName}() calls transform.Translate/Rotate without Time.deltaTime — movement will run at different speeds at different frame rates.`,
          severity: 'warn',
        });
      }
    }

    // Resources.Load("…") path must resolve under Assets/Resources/.
    for (const m of content.matchAll(/Resources\.Load(?:<[^>]+>)?\s*\(\s*"([^"]+)"/g)) {
      const resPath = m[1];
      if (typeof resPath !== 'string' || resPath.length === 0) continue;
      // Resources.Load takes a path WITHOUT extension; we accept any
      // file under Assets/Resources/<resPath>.* as a match.
      const prefix = `Assets/Resources/${resPath}`;
      const found = [...filePathSet].some((p) => p === prefix || p.startsWith(`${prefix}.`));
      if (!found) {
        issues.push({
          path: file.path,
          message: `Resources.Load("${resPath}") references a path that doesn't exist under Assets/Resources/. Add the asset or fix the path.`,
          severity: 'error',
        });
      }
    }

    // Editor scripts that write assets without AssetDatabase.Refresh().
    if (file.path.startsWith('Assets/Editor/')) {
      const writes = /\b(AssetDatabase\.Create|File\.WriteAllText|File\.WriteAllBytes)\b/.test(
        content,
      );
      const refreshes = /\bAssetDatabase\.Refresh\s*\(/.test(content);
      if (writes && !refreshes) {
        issues.push({
          path: file.path,
          message:
            'Editor script writes assets but never calls AssetDatabase.Refresh() — the next build will not see the new asset.',
          severity: 'warn',
        });
      }
    }
  }

  // ProjectVersion.txt must declare an Editor version we can act on.
  const pv = files.find((f) => f.path === 'ProjectSettings/ProjectVersion.txt');
  if (pv !== undefined && !/^m_EditorVersion:\s*\S+/m.test(pv.content)) {
    issues.push({
      path: 'ProjectSettings/ProjectVersion.txt',
      message:
        "ProjectVersion.txt must include an `m_EditorVersion: <version>` line so the host can match it against the user's installed Unity Editors.",
      severity: 'error',
    });
  }

  if (issues.length === 0) return { ok: true };
  return { ok: false, issues };
}

export const unityAdapter: GameEngineAdapter = {
  id: 'unity',
  label: 'Unity',
  defaultVersion: UNITY_DEFAULT_VERSION,
  canonicalEntry: 'ProjectSettings/ProjectVersion.txt',
  fileExtensions: ['cs', 'unity', 'asset', 'meta', 'prefab', 'mat', 'shader', 'asmdef', 'json'],
  bootstrap: unityBootstrap,
  // UNITY_PIPELINE.md §U2 — live preview is delivered by the agent-authored
  // Three.js shadow scene at index.html. The Unity tree is the export
  // target. The bootstrap above is the fallback project-shell page; once
  // the agent writes index.html, the runtime serves that instead.
  supportsLivePreview: () => true,
  validate: unityValidate,
};
