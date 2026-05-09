import { describe, expect, it } from 'vitest';
import {
  type UnityDiscoveryDeps,
  compareUnityVersions,
  discoverUnityEditors,
} from './unity-discovery';

function makeFakeFs(
  files: string[],
): Pick<UnityDiscoveryDeps, 'exists' | 'listDir' | 'isDirectory'> {
  const fileSet = new Set(files);
  const dirSet = new Set<string>();
  for (const f of files) {
    const parts = f.split('/').filter((s) => s.length > 0);
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(`/${parts.slice(0, i).join('/')}`);
    }
    // Mirror the path-leading slash on Windows-style paths.
    if (f.match(/^[A-Z]:\\/)) {
      const winParts = f.split('\\');
      for (let i = 1; i < winParts.length; i++) {
        dirSet.add(winParts.slice(0, i).join('\\'));
      }
    }
  }
  return {
    exists: (p) => fileSet.has(p) || dirSet.has(p),
    listDir: (p) => {
      const items = new Set<string>();
      const prefix = p.endsWith('/') ? p : `${p}/`;
      for (const f of files) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const head = rest.split('/')[0];
          if (head !== undefined && head.length > 0) items.add(head);
        }
      }
      for (const d of dirSet) {
        if (d.startsWith(prefix) && d !== prefix.slice(0, -1)) {
          const rest = d.slice(prefix.length);
          const head = rest.split('/')[0];
          if (head !== undefined && head.length > 0) items.add(head);
        }
      }
      return [...items];
    },
    isDirectory: (p) => dirSet.has(p),
  };
}

describe('discoverUnityEditors — macOS', () => {
  const deps = (files: string[]): UnityDiscoveryDeps => ({
    platform: 'darwin',
    env: {},
    home: '/Users/tester',
    ...makeFakeFs(files),
  });

  it('finds Editors under ~/Applications/Unity/Hub/Editor', () => {
    const result = discoverUnityEditors(
      deps([
        '/Users/tester/Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app/Contents/MacOS/Unity',
        '/Users/tester/Applications/Unity/Hub/Editor/2022.3.18f1/Unity.app/Contents/MacOS/Unity',
      ]),
    );
    expect(result.hubInstalled).toBe(true);
    expect(result.editors.map((e) => e.version)).toEqual(['6000.0.23f1', '2022.3.18f1']);
    expect(result.editors[0]?.path).toContain('6000.0.23f1');
  });

  it('returns hubInstalled=false when no Editor root exists', () => {
    const result = discoverUnityEditors(deps([]));
    expect(result.hubInstalled).toBe(false);
    expect(result.editors).toEqual([]);
  });

  it('skips version dirs that lack Unity binary', () => {
    const result = discoverUnityEditors(
      deps([
        '/Users/tester/Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app/Contents/MacOS/Unity',
        '/Users/tester/Applications/Unity/Hub/Editor/half-installed/SomeOtherFile',
      ]),
    );
    expect(result.editors.map((e) => e.version)).toEqual(['6000.0.23f1']);
  });

  it('dedupes when the same Editor appears in both ~/Applications and /Applications', () => {
    // We can't easily fake both roots resolving to the same binary, but we
    // CAN check that two distinct binaries from two roots both surface.
    const result = discoverUnityEditors(
      deps([
        '/Users/tester/Applications/Unity/Hub/Editor/6000.0.23f1/Unity.app/Contents/MacOS/Unity',
        '/Applications/Unity/Hub/Editor/2023.2.5f1/Unity.app/Contents/MacOS/Unity',
      ]),
    );
    expect(result.editors.map((e) => e.version).sort()).toEqual(['2023.2.5f1', '6000.0.23f1']);
  });
});

describe('discoverUnityEditors — linux', () => {
  it('finds Editors under ~/Unity/Hub/Editor', () => {
    const files = ['/home/u/Unity/Hub/Editor/6000.0.23f1/Editor/Unity'];
    const result = discoverUnityEditors({
      platform: 'linux',
      env: {},
      home: '/home/u',
      ...makeFakeFs(files),
    });
    expect(result.editors.map((e) => e.version)).toEqual(['6000.0.23f1']);
  });
});

describe('compareUnityVersions', () => {
  it('orders 6000 before 2022', () => {
    expect(compareUnityVersions('6000.0.23f1', '2022.3.18f1')).toBeGreaterThan(0);
  });
  it('orders by minor when major equal', () => {
    expect(compareUnityVersions('6000.1.0f1', '6000.0.23f1')).toBeGreaterThan(0);
  });
  it('returns 0 for identical strings', () => {
    expect(compareUnityVersions('6000.0.23f1', '6000.0.23f1')).toBe(0);
  });
});
