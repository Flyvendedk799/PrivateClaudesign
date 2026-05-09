/**
 * UNITY_PIPELINE.md §U1 — game-unity-project exporter tests.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportGameUnityProject } from './game-unity-project';

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-unity-export-')));
});
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function unzipTo(zipPath: string, destDir: string): Promise<string[]> {
  const ZipFile: typeof import('zip-lib') = await import('zip-lib');
  mkdirSync(destDir, { recursive: true });
  await ZipFile.extract(zipPath, destDir);
  const { readdirSync } = await import('node:fs');
  const out: string[] = [];
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  }
  walk(destDir, '');
  return out.sort();
}

const MINIMAL_PROJECT_FILES = [
  {
    path: 'ProjectSettings/ProjectVersion.txt',
    content: 'm_EditorVersion: 6000.0.23f1\nm_EditorVersionWithRevision: 6000.0.23f1 (abc)\n',
  },
  { path: 'Packages/manifest.json', content: '{ "dependencies": {} }' },
  {
    path: 'Assets/Scenes/Main.unity',
    content: '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!29 &1\nOcclusionCullingSettings:',
  },
  {
    path: 'Assets/Scripts/PlayerController.cs',
    content: `using UnityEngine;
public class PlayerController : MonoBehaviour {
  void Update() { transform.Translate(Vector3.forward * 5f * Time.deltaTime); }
}`,
  },
];

describe('exportGameUnityProject', () => {
  it('produces a valid Unity project zip with the required files', async () => {
    const dest = join(workDir, 'unity.zip');
    const result = await exportGameUnityProject(dest, {
      files: MINIMAL_PROJECT_FILES,
      designName: 'Third Person Combat',
      engineVersion: '6000.0',
    });
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);

    const extractDir = join(workDir, 'extract');
    const entries = await unzipTo(dest, extractDir);
    expect(entries).toContain('ProjectSettings/ProjectVersion.txt');
    expect(entries).toContain('Packages/manifest.json');
    expect(entries).toContain('Assets/Scenes/Main.unity');
    expect(entries).toContain('Assets/Scripts/PlayerController.cs');
    expect(entries).toContain('.gitignore');
    expect(entries).toContain('README.md');
  });

  it('writes a .gitignore that excludes Library/ Temp/ Logs/', async () => {
    const dest = join(workDir, 'unity.zip');
    await exportGameUnityProject(dest, { files: MINIMAL_PROJECT_FILES });
    const extractDir = join(workDir, 'extract');
    await unzipTo(dest, extractDir);
    const gi = readFileSync(join(extractDir, '.gitignore'), 'utf8');
    expect(gi).toContain('[Ll]ibrary/');
    expect(gi).toContain('[Tt]emp/');
    expect(gi).toContain('[Ll]ogs/');
    expect(gi).toContain('*.csproj');
  });

  it('drops Library/ Temp/ *.csproj from the bundle', async () => {
    const dest = join(workDir, 'unity.zip');
    await exportGameUnityProject(dest, {
      files: [
        ...MINIMAL_PROJECT_FILES,
        { path: 'Library/ScriptAssemblies/foo.dll', content: 'binary' },
        { path: 'Temp/UnityLockfile', content: '' },
        { path: 'Logs/ACEdtor.log', content: 'lol' },
        { path: 'MyProject.csproj', content: '<Project/>' },
        { path: 'MyProject.sln', content: 'Microsoft Visual Studio Solution File' },
      ],
    });
    const entries = await unzipTo(dest, join(workDir, 'extract'));
    expect(entries.some((e) => e.startsWith('Library/'))).toBe(false);
    expect(entries.some((e) => e.startsWith('Temp/'))).toBe(false);
    expect(entries.some((e) => e.startsWith('Logs/'))).toBe(false);
    expect(entries.some((e) => e.endsWith('.csproj'))).toBe(false);
    expect(entries.some((e) => e.endsWith('.sln'))).toBe(false);
  });

  it('respects user-authored .gitignore + README', async () => {
    const dest = join(workDir, 'unity.zip');
    await exportGameUnityProject(dest, {
      files: [
        ...MINIMAL_PROJECT_FILES,
        { path: '.gitignore', content: 'CUSTOM' },
        { path: 'README.md', content: '# Custom' },
      ],
    });
    const extractDir = join(workDir, 'extract');
    await unzipTo(dest, extractDir);
    expect(readFileSync(join(extractDir, '.gitignore'), 'utf8')).toBe('CUSTOM');
    expect(readFileSync(join(extractDir, 'README.md'), 'utf8')).toBe('# Custom');
  });

  it('rejects bundles without ProjectSettings/ProjectVersion.txt', async () => {
    const dest = join(workDir, 'unity.zip');
    await expect(
      exportGameUnityProject(dest, {
        files: [{ path: 'Packages/manifest.json', content: '{}' }],
      }),
    ).rejects.toThrow(/ProjectVersion\.txt/);
  });

  it('rejects empty file lists', async () => {
    const dest = join(workDir, 'unity.zip');
    await expect(exportGameUnityProject(dest, { files: [] })).rejects.toThrow(/empty file list/);
  });

  it('rejects path traversal attempts', async () => {
    const dest = join(workDir, 'unity.zip');
    await expect(
      exportGameUnityProject(dest, {
        files: [...MINIMAL_PROJECT_FILES, { path: '../etc/passwd', content: 'oops' }],
      }),
    ).rejects.toThrow(/unsafe path/);
  });
});
