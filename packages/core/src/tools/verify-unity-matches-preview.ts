/**
 * UNITY_PIPELINE.md §U2 — `verify_unity_matches_preview` agent tool.
 *
 * Unity-mode runs author TWO parallel artifacts:
 *   1. A Three.js shadow scene at `index.html` (live preview, instant feedback)
 *   2. The Unity project tree (`Assets/...`, the export target)
 *
 * The agent builds both from the same `declare_game_spec` brief, so they
 * should describe structurally-equivalent scenes — same camera kind, same
 * named actors. Pattern-based checker; no AST. Fast, cheap, runs over the
 * authored file bundle. Surfaces structural divergence so the agent can
 * fix the drift before `done`.
 *
 * v1 covers three lints:
 *   - **Both sides exist.** The shadow scene's `index.html` AND a Unity
 *     project (Assets/Scenes/Main.unity + at least one .cs file) must
 *     both be present. Unity-mode without a Three.js shadow = no preview
 *     was authored; Three.js without Unity = the export target is empty.
 *   - **Camera kind agrees.** First-person on one side ↔ first-person on
 *     the other. Catches the FPS-run lesson (silent camera swap between
 *     spec and runtime — memory: "fight-game lessons").
 *   - **Named actors overlap.** When the Unity scripts mention "Player",
 *     "Enemy", "Boss" etc., the Three.js scene should mention the same
 *     names. Strict overlap > 0 (not equality — small extras are fine).
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const VerifyParams = Type.Object({});

export type VerifyUnityIssueKind =
  | 'missing_shadow'
  | 'missing_unity'
  | 'camera_drift'
  | 'actor_drift';

export interface VerifyUnityIssue {
  kind: VerifyUnityIssueKind;
  message: string;
  severity: 'warn' | 'error';
}

export interface VerifyUnityDetails {
  ok: boolean;
  unityActors: string[];
  shadowActors: string[];
  unityCamera: 'first_person' | 'third_person' | 'unknown';
  shadowCamera: 'first_person' | 'third_person' | 'unknown';
  issues: VerifyUnityIssue[];
}

export interface VerifyUnityDeps {
  listFiles: () => Array<{ path: string; content: string }>;
}

// C#: match either a `new GameObject("Name")` constructor literal OR any
// `<lhs>.name = "Name"` assignment (covers `player.name = "Player"`,
// `gameObject.name = "Boss"`, etc).
const NAMED_ACTOR_RE_CSHARP_NEW = /\bnew\s+GameObject\s*\(\s*"([A-Z][\w_-]*)"/g;
const NAMED_ACTOR_RE_CSHARP_NAME = /\b\w+\.name\s*=\s*"([A-Z][\w_-]*)"/g;

// Three.js: match `<lhs>.name = "Name"` (single or double quotes). Most
// idiomatic Three code names objects after construction.
const NAMED_ACTOR_RE_THREE_NAME = /\b\w+\.name\s*=\s*['"]([A-Z][\w_-]*)['"]/g;

function extractMatches(re: RegExp, src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(re)) {
    for (let i = 1; i < m.length; i++) {
      const v = m[i];
      if (typeof v === 'string' && v.length > 0) out.add(v);
    }
  }
  return [...out];
}

/** Heuristic: which camera mode does the Unity side declare? */
function detectUnityCamera(src: string): VerifyUnityDetails['unityCamera'] {
  if (
    /Cinemachine.*FirstPerson|FirstPersonController|Cursor\.lockState\s*=\s*CursorLockMode\.Locked/i.test(
      src,
    )
  ) {
    return 'first_person';
  }
  if (/Cinemachine.*ThirdPerson|ThirdPersonController|FollowTarget|FollowCamera/i.test(src)) {
    return 'third_person';
  }
  return 'unknown';
}

/** Heuristic: which camera mode does the Three.js shadow declare? */
function detectShadowCamera(src: string): VerifyUnityDetails['shadowCamera'] {
  if (/PointerLockControls|requestPointerLock|FirstPersonControls/i.test(src)) {
    return 'first_person';
  }
  if (/OrbitControls|FollowCam|ThirdPersonControls|chase\s*camera/i.test(src)) {
    return 'third_person';
  }
  return 'unknown';
}

export function makeVerifyUnityMatchesPreviewTool(
  deps: VerifyUnityDeps,
): AgentTool<typeof VerifyParams, VerifyUnityDetails> {
  return {
    name: 'verify_unity_matches_preview',
    label: 'Verify Unity ↔ preview parity',
    description:
      'Lint the Three.js shadow scene (index.html) against the Unity project tree (Assets/Scenes/Main.unity + Assets/**/*.cs) for structural divergence. ' +
      'Catches: (a) missing shadow scene or missing Unity tree, (b) camera-kind drift (first-person vs third-person mismatch), (c) named-actor drift ' +
      "(named GameObjects in Unity that don't appear in the Three.js scene). Call before `done` whenever engine=unity.",
    parameters: VerifyParams,
    async execute(): Promise<AgentToolResult<VerifyUnityDetails>> {
      const files = deps.listFiles();
      const issues: VerifyUnityIssue[] = [];

      const shadowSources: string[] = [];
      const unitySources: string[] = [];
      let hasUnityProject = false;
      let hasShadowIndex = false;

      for (const f of files) {
        if (f.path === 'index.html' || f.path.endsWith('.js') || f.path.endsWith('.mjs')) {
          shadowSources.push(f.content);
          if (f.path === 'index.html') hasShadowIndex = true;
        }
        if (f.path === 'Assets/Scenes/Main.unity') hasUnityProject = true;
        if (f.path.endsWith('.cs')) unitySources.push(f.content);
      }

      if (!hasShadowIndex) {
        issues.push({
          kind: 'missing_shadow',
          message:
            'Unity-mode runs MUST author a Three.js shadow scene at index.html — it is the only live-preview surface. Without it, the user sees the project-shell page and cannot iterate.',
          severity: 'error',
        });
      }
      if (!hasUnityProject || unitySources.length === 0) {
        issues.push({
          kind: 'missing_unity',
          message:
            'Unity-mode runs MUST author a Unity project tree (Assets/Scenes/Main.unity + at least one C# script). The Three.js scene is the preview; the Unity tree is the export target.',
          severity: 'error',
        });
      }

      const shadowSrc = shadowSources.join('\n');
      const unitySrc = unitySources.join('\n');
      const shadowCamera = detectShadowCamera(shadowSrc);
      const unityCamera = detectUnityCamera(unitySrc);
      if (shadowCamera !== 'unknown' && unityCamera !== 'unknown' && shadowCamera !== unityCamera) {
        issues.push({
          kind: 'camera_drift',
          message: `Camera kind drift — Three.js shadow declares ${shadowCamera}, Unity declares ${unityCamera}. The two must agree or the preview lies about the export target.`,
          severity: 'warn',
        });
      }

      const shadowActors = extractMatches(NAMED_ACTOR_RE_THREE_NAME, shadowSrc);
      const unityActors = [
        ...new Set([
          ...extractMatches(NAMED_ACTOR_RE_CSHARP_NEW, unitySrc),
          ...extractMatches(NAMED_ACTOR_RE_CSHARP_NAME, unitySrc),
        ]),
      ];
      if (unityActors.length >= 2 && shadowActors.length >= 1) {
        const intersect = unityActors.filter((a) => shadowActors.includes(a));
        if (intersect.length === 0) {
          issues.push({
            kind: 'actor_drift',
            message: `Named-actor drift — Unity scene names [${unityActors.slice(0, 5).join(', ')}], Three.js shadow names [${shadowActors.slice(0, 5).join(', ')}]. No overlap; pick a shared name set so the preview describes the same scene as the export.`,
            severity: 'warn',
          });
        }
      }

      const ok = issues.every((i) => i.severity !== 'error');
      const summaryLines: string[] = [];
      summaryLines.push(`Unity ↔ preview parity check: ${ok ? 'OK' : 'FAIL'}`);
      summaryLines.push(`  Shadow camera: ${shadowCamera}    Unity camera: ${unityCamera}`);
      summaryLines.push(
        `  Shadow actors: [${shadowActors.slice(0, 8).join(', ')}]    Unity actors: [${unityActors.slice(0, 8).join(', ')}]`,
      );
      for (const issue of issues) {
        summaryLines.push(
          `  ${issue.severity === 'error' ? '✗' : '!'} ${issue.kind}: ${issue.message}`,
        );
      }
      return {
        content: [{ type: 'text', text: summaryLines.join('\n') }],
        details: {
          ok,
          unityActors,
          shadowActors,
          unityCamera,
          shadowCamera,
          issues,
        },
      };
    },
  };
}
