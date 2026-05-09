import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _internal, buildUnityProject } from './unity-build';

const { parseLogLine, pickEditor, extractPinnedVersion, CODESIGN_BUILDER_CS } = _internal;

const MIN_FILES = [
  {
    path: 'ProjectSettings/ProjectVersion.txt',
    content: 'm_EditorVersion: 6000.0.23f1\nm_EditorVersionWithRevision: 6000.0.23f1 (abc)',
  },
  { path: 'Packages/manifest.json', content: '{ "dependencies": {} }' },
  {
    path: 'Assets/Scenes/Main.unity',
    content: '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:',
  },
];

let workDir = '';
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'unity-build-test-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('unity-build — log parsing', () => {
  it('parses CS#### error lines', () => {
    const r = parseLogLine(
      "Assets/Scripts/Foo.cs(12,9): error CS0103: The name 'Bar' does not exist in the current context",
    );
    expect(r?.kind).toBe('error');
    expect(r?.entry.code).toBe('CS0103');
    expect(r?.entry.path).toBe('Assets/Scripts/Foo.cs');
    expect(r?.entry.line).toBe(12);
    expect(r?.entry.message).toContain("'Bar' does not exist");
  });

  it('parses CS#### warning lines', () => {
    const r = parseLogLine(
      'Assets/Scripts/Bar.cs(7,1): warning CS0168: The variable `x` is declared but never used',
    );
    expect(r?.kind).toBe('warning');
    expect(r?.entry.code).toBe('CS0168');
  });

  it('detects license-not-activated', () => {
    const r = parseLogLine('No valid Unity license found.');
    expect(r?.kind).toBe('error');
    expect(r?.entry.code).toBe('UNITY_LICENSE');
  });

  it('returns null for irrelevant lines', () => {
    expect(parseLogLine('Refreshing assets...')).toBeNull();
  });
});

describe('unity-build — editor pick', () => {
  const editors = [
    { version: '6000.0.23f1', path: '/Editors/6000.0.23f1/Unity' },
    { version: '6000.0.18f1', path: '/Editors/6000.0.18f1/Unity' },
    { version: '2022.3.18f1', path: '/Editors/2022.3.18f1/Unity' },
  ];

  it('returns the first when no pin', () => {
    expect(pickEditor(editors, undefined)?.version).toBe('6000.0.23f1');
  });
  it('exact match wins', () => {
    expect(pickEditor(editors, '6000.0.18f1')?.version).toBe('6000.0.18f1');
  });
  it('falls back to major-version match', () => {
    expect(pickEditor(editors, '6000.0.99f1')?.version).toBe('6000.0.23f1');
  });
  it('returns null when nothing matches the major', () => {
    expect(pickEditor(editors, '5.6.0f1')).toBeNull();
  });
});

describe('unity-build — pinned-version extraction', () => {
  it('parses m_EditorVersion', () => {
    expect(extractPinnedVersion('m_EditorVersion: 6000.0.23f1')).toBe('6000.0.23f1');
  });
  it('returns undefined when missing', () => {
    expect(extractPinnedVersion('# nothing')).toBeUndefined();
    expect(extractPinnedVersion(undefined)).toBeUndefined();
  });
});

describe('buildUnityProject — happy path with stub editor', () => {
  it('writes the staging dir, injects CodesignBuilder.cs, runs the editor, returns artifact path', async () => {
    let capturedArgs: string[] | null = null;
    let capturedEditorPath = '';
    const result = await buildUnityProject(
      {
        files: MIN_FILES,
        target: 'StandaloneOSX',
        outDir: join(workDir, 'out'),
      },
      {
        discoverEditors: () => ({
          hubInstalled: true,
          editors: [{ version: '6000.0.23f1', path: '/fake/Editor/6000.0.23f1/Unity' }],
        }),
        runEditor: async (editorPath, args, onLine) => {
          capturedEditorPath = editorPath;
          capturedArgs = args;
          // Simulate Unity emitting a happy-path success log.
          onLine('[Builder] Refreshing assets...');
          onLine(`[Builder] Build succeeded: ${join(workDir, 'out', 'Game.app')}`);
          return { exitCode: 0 };
        },
        stagingDirBase: workDir,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.artifactPath).toBe(join(workDir, 'out', 'Game.app'));
    expect(result.errors).toEqual([]);
    expect(result.editorVersion).toBe('6000.0.23f1');
    expect(capturedEditorPath).toBe('/fake/Editor/6000.0.23f1/Unity');
    expect(capturedArgs).toContain('-batchmode');
    expect(capturedArgs).toContain('-executeMethod');
    expect(capturedArgs).toContain('CodesignBuilder.Build');
    expect(capturedArgs).toContain('-buildTarget');
    expect(capturedArgs).toContain('StandaloneOSX');
  });

  it('reports CS errors when the editor exits non-zero', async () => {
    const result = await buildUnityProject(
      {
        files: MIN_FILES,
        target: 'WebGL',
        outDir: join(workDir, 'out'),
      },
      {
        discoverEditors: () => ({
          hubInstalled: true,
          editors: [{ version: '6000.0.23f1', path: '/fake/Unity' }],
        }),
        runEditor: async (_path, _args, onLine) => {
          onLine(
            "Assets/Scripts/Bad.cs(10,5): error CS0103: The name 'foo' does not exist in the current context",
          );
          onLine('Build failed.');
          return { exitCode: 1 };
        },
        stagingDirBase: workDir,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('CS0103');
    expect(result.errors[0]?.path).toBe('Assets/Scripts/Bad.cs');
    expect(result.errors[0]?.line).toBe(10);
  });

  it('detects missing-license error and surfaces UNITY_LICENSE', async () => {
    const result = await buildUnityProject(
      {
        files: MIN_FILES,
        target: 'StandaloneOSX',
        outDir: join(workDir, 'out'),
      },
      {
        discoverEditors: () => ({
          hubInstalled: true,
          editors: [{ version: '6000.0.23f1', path: '/fake/Unity' }],
        }),
        runEditor: async (_path, _args, onLine) => {
          onLine('No valid Unity license found.');
          return { exitCode: 1 };
        },
        stagingDirBase: workDir,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'UNITY_LICENSE')).toBe(true);
  });

  it('throws when no Editors are installed', async () => {
    await expect(
      buildUnityProject(
        { files: MIN_FILES, target: 'StandaloneOSX', outDir: join(workDir, 'out') },
        {
          discoverEditors: () => ({ hubInstalled: false, editors: [] }),
          runEditor: async () => ({ exitCode: 0 }),
          stagingDirBase: workDir,
        },
      ),
    ).rejects.toThrow(/No Unity Editor found/);
  });

  it('throws when the project pin matches no installed Editor', async () => {
    await expect(
      buildUnityProject(
        { files: MIN_FILES, target: 'StandaloneOSX', outDir: join(workDir, 'out') },
        {
          discoverEditors: () => ({
            hubInstalled: true,
            editors: [{ version: '2021.3.0f1', path: '/fake/2021/Unity' }],
          }),
          runEditor: async () => ({ exitCode: 0 }),
          stagingDirBase: workDir,
        },
      ),
    ).rejects.toThrow(/no matching Editor is installed/);
  });

  it('throws when ProjectVersion.txt is missing from the bundle', async () => {
    await expect(
      buildUnityProject(
        {
          files: [{ path: 'Packages/manifest.json', content: '{}' }],
          target: 'StandaloneOSX',
          outDir: join(workDir, 'out'),
        },
        {
          discoverEditors: () => ({
            hubInstalled: true,
            editors: [{ version: '6000.0.0f1', path: '/fake/Unity' }],
          }),
          runEditor: async () => ({ exitCode: 0 }),
          stagingDirBase: workDir,
        },
      ),
    ).rejects.toThrow(/ProjectVersion\.txt/);
  });
});

describe('buildUnityProject — CodesignBuilder.cs is host-injected', () => {
  it('always overwrites Assets/Editor/CodesignBuilder.cs even if the agent authored one', async () => {
    let stagedBuilder = '';
    await buildUnityProject(
      {
        files: [
          ...MIN_FILES,
          {
            path: 'Assets/Editor/CodesignBuilder.cs',
            content: '// agent-authored stub that should be overwritten',
          },
        ],
        target: 'StandaloneOSX',
        outDir: join(workDir, 'out'),
      },
      {
        discoverEditors: () => ({
          hubInstalled: true,
          editors: [{ version: '6000.0.23f1', path: '/fake/Unity' }],
        }),
        runEditor: async (_path, args, _onLine) => {
          // Read what landed at staging dir's CodesignBuilder path.
          const projectPathIdx = args.indexOf('-projectPath');
          const projectPath = args[projectPathIdx + 1] ?? '';
          stagedBuilder = readFileSync(
            join(projectPath, 'Assets', 'Editor', 'CodesignBuilder.cs'),
            'utf8',
          );
          return { exitCode: 0 };
        },
        stagingDirBase: workDir,
      },
    );
    expect(stagedBuilder).toBe(CODESIGN_BUILDER_CS);
    expect(stagedBuilder).toContain('public static class CodesignBuilder');
    expect(stagedBuilder).toContain('BuildPipeline.BuildPlayer');
  });
});
