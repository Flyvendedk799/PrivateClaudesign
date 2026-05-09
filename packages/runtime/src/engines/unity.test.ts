import { describe, expect, it } from 'vitest';
import type { InputFile } from './types';
import { unityAdapter } from './unity';

function makeMinimalProject(extra: InputFile[] = []): InputFile[] {
  return [
    {
      path: 'ProjectSettings/ProjectVersion.txt',
      content: 'm_EditorVersion: 6000.0.23f1\nm_EditorVersionWithRevision: 6000.0.23f1 (abc)',
    },
    { path: 'Packages/manifest.json', content: '{ "dependencies": {} }' },
    {
      path: 'Assets/Scenes/Main.unity',
      content: '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!29 &1\nOcclusionCullingSettings:',
    },
    ...extra,
  ];
}

describe('unityAdapter — basics', () => {
  it('id, label, canonicalEntry, defaultVersion', () => {
    expect(unityAdapter.id).toBe('unity');
    expect(unityAdapter.canonicalEntry).toBe('ProjectSettings/ProjectVersion.txt');
    // U2: live preview comes from the agent-authored Three.js shadow scene at
    // index.html, even though Unity itself doesn't run in the iframe.
    expect(unityAdapter.supportsLivePreview()).toBe(true);
    expect(unityAdapter.defaultVersion).toMatch(/^6000\./);
  });

  it('bootstrap returns a project-shell HTML page mentioning Unity', () => {
    const html = unityAdapter.bootstrap({
      designId: 'd-1',
      gameBaseUrl: 'game-files://designs/d-1/',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Unity 6000.0');
    expect(html).toContain('Assets/Scenes/Main.unity');
  });

  it('honors pinnedVersion', () => {
    const html = unityAdapter.bootstrap({
      designId: 'd-1',
      gameBaseUrl: 'game-files://designs/d-1/',
      pinnedVersion: '2022.3.18f1',
    });
    expect(html).toContain('Unity 2022.3.18f1');
  });
});

describe('unityAdapter — validation', () => {
  it('passes a minimal valid project', () => {
    const result = unityAdapter.validate(makeMinimalProject());
    expect(result.ok).toBe(true);
  });

  it('errors when ProjectVersion.txt is missing', () => {
    const files: InputFile[] = [{ path: 'Packages/manifest.json', content: '{}' }];
    const result = unityAdapter.validate(files);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === 'ProjectSettings/ProjectVersion.txt')).toBe(true);
    }
  });

  it('errors when manifest.json is missing', () => {
    const files: InputFile[] = [
      { path: 'ProjectSettings/ProjectVersion.txt', content: 'm_EditorVersion: 6000.0.23f1' },
    ];
    const result = unityAdapter.validate(files);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === 'Packages/manifest.json')).toBe(true);
    }
  });

  it('warns on GameObject.Find inside Update()', () => {
    const cs = `using UnityEngine;
public class Bad : MonoBehaviour {
  void Update() {
    var p = GameObject.Find("Player");
    p.transform.position += Vector3.up;
  }
}`;
    const result = unityAdapter.validate(
      makeMinimalProject([{ path: 'Assets/Scripts/Bad.cs', content: cs }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('GameObject.Find inside Update'))).toBe(
        true,
      );
    }
  });

  it('does not warn on GameObject.Find inside Start()', () => {
    const cs = `using UnityEngine;
public class Good : MonoBehaviour {
  GameObject p;
  void Start() { p = GameObject.Find("Player"); }
  void Update() { p.transform.position += Vector3.up * Time.deltaTime; }
}`;
    const result = unityAdapter.validate(
      makeMinimalProject([{ path: 'Assets/Scripts/Good.cs', content: cs }]),
    );
    expect(result.ok).toBe(true);
  });

  it('warns on transform.Translate without Time.deltaTime in Update()', () => {
    const cs = `using UnityEngine;
public class Mover : MonoBehaviour {
  void Update() { transform.Translate(Vector3.forward * 5f); }
}`;
    const result = unityAdapter.validate(
      makeMinimalProject([{ path: 'Assets/Scripts/Mover.cs', content: cs }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('Time.deltaTime'))).toBe(true);
    }
  });

  it('errors when Resources.Load points at a missing asset', () => {
    const cs = `using UnityEngine;
public class Spawn : MonoBehaviour {
  void Start() { var p = Resources.Load<GameObject>("Prefabs/Player"); }
}`;
    const result = unityAdapter.validate(
      makeMinimalProject([{ path: 'Assets/Scripts/Spawn.cs', content: cs }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.message.includes('Resources.Load("Prefabs/Player")')),
      ).toBe(true);
    }
  });

  it('passes Resources.Load when the asset exists', () => {
    const cs = `using UnityEngine;
public class Spawn : MonoBehaviour {
  void Start() { var p = Resources.Load<GameObject>("Prefabs/Player"); }
}`;
    const result = unityAdapter.validate(
      makeMinimalProject([
        { path: 'Assets/Scripts/Spawn.cs', content: cs },
        { path: 'Assets/Resources/Prefabs/Player.prefab', content: '%YAML 1.1' },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('warns on Editor script that writes assets without AssetDatabase.Refresh', () => {
    const cs = `using UnityEditor;
using System.IO;
public class WriteThing {
  static void Build() {
    File.WriteAllText("Assets/foo.txt", "hi");
  }
}`;
    const result = unityAdapter.validate(
      makeMinimalProject([{ path: 'Assets/Editor/Builder.cs', content: cs }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('AssetDatabase.Refresh'))).toBe(true);
    }
  });

  it('errors when ProjectVersion.txt has no m_EditorVersion line', () => {
    const files: InputFile[] = [
      { path: 'ProjectSettings/ProjectVersion.txt', content: '# nothing here' },
      { path: 'Packages/manifest.json', content: '{}' },
    ];
    const result = unityAdapter.validate(files);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('m_EditorVersion'))).toBe(true);
    }
  });
});
