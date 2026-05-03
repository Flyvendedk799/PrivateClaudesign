/**
 * gameplan §D — godot-cli-detect tests. Use injected deps so the suite
 * runs without a real Godot install.
 */

import { describe, expect, it } from 'vitest';
import {
  type GodotCliDeps,
  detectGodotCli,
  findGodotOnPath,
  parseGodotVersion,
} from './godot-cli-detect';

function fakeDeps(over: Partial<GodotCliDeps>): GodotCliDeps {
  return {
    candidateNames: ['godot-headless', 'godot'],
    pathEnv: '/usr/local/bin:/usr/bin',
    exists: () => false,
    runWithVersion: async () => '',
    ...over,
  };
}

describe('parseGodotVersion', () => {
  it('parses the canonical 4.3.x.stable.official.<sha> shape', () => {
    expect(parseGodotVersion('4.3.1.stable.official.f06b6836a')).toEqual({
      version: '4.3.1.stable.official.f06b6836a',
      major: 4,
      minor: 3,
      patch: 1,
    });
  });

  it('parses the 3-part 4.0.0 shape (no status suffix)', () => {
    expect(parseGodotVersion('4.0.0')).toEqual({
      version: '4.0.0',
      major: 4,
      minor: 0,
      patch: 0,
    });
  });

  it('parses the 2-part 4.4.beta shape (early dev channel)', () => {
    expect(parseGodotVersion('4.4.beta')).toEqual({
      version: '4.4.beta',
      major: 4,
      minor: 4,
      patch: 0,
    });
  });

  it('parses Godot 3.x', () => {
    expect(parseGodotVersion('3.5.3.stable.official')).toEqual({
      version: '3.5.3.stable.official',
      major: 3,
      minor: 5,
      patch: 3,
    });
  });

  it('takes the first non-empty line when --version emits a banner', () => {
    expect(parseGodotVersion('\n4.3.1.stable.official\nServer: yes\n')).toEqual({
      version: '4.3.1.stable.official',
      major: 4,
      minor: 3,
      patch: 1,
    });
  });

  it('returns null on garbage', () => {
    expect(parseGodotVersion('hello world')).toBeNull();
    expect(parseGodotVersion('')).toBeNull();
    expect(parseGodotVersion('   ')).toBeNull();
  });
});

describe('findGodotOnPath', () => {
  it('returns the first matching candidate honouring search-name priority', () => {
    const found = findGodotOnPath(
      fakeDeps({
        pathEnv: '/usr/local/bin:/usr/bin',
        exists: (p) =>
          p === '/usr/local/bin/godot-headless' ||
          p === '/usr/local/bin/godot' ||
          p === '/usr/bin/godot',
      }),
    );
    // godot-headless beats godot even though both exist in the same dir
    expect(found).toBe('/usr/local/bin/godot-headless');
  });

  it('walks PATH dirs in order when the first candidate is absent there', () => {
    const found = findGodotOnPath(
      fakeDeps({
        pathEnv: '/empty:/usr/local/bin',
        exists: (p) => p === '/usr/local/bin/godot',
      }),
    );
    expect(found).toBe('/usr/local/bin/godot');
  });

  it('returns null when nothing on PATH matches', () => {
    expect(
      findGodotOnPath(
        fakeDeps({
          pathEnv: '/usr/bin:/opt/bin',
          exists: () => false,
        }),
      ),
    ).toBeNull();
  });

  it('returns null when PATH is empty', () => {
    expect(findGodotOnPath(fakeDeps({ pathEnv: '' }))).toBeNull();
  });
});

describe('detectGodotCli', () => {
  it('reports ok when a 4.x binary is on PATH and reports its version', async () => {
    const status = await detectGodotCli(
      fakeDeps({
        pathEnv: '/usr/local/bin',
        exists: (p) => p === '/usr/local/bin/godot',
        runWithVersion: async () => '4.3.1.stable.official.f06b6836a\n',
      }),
    );
    expect(status).toEqual({
      ok: true,
      path: '/usr/local/bin/godot',
      version: '4.3.1.stable.official.f06b6836a',
      major: 4,
      minor: 3,
      patch: 1,
    });
  });

  it('reports wrong-version when a 3.x binary is detected', async () => {
    const status = await detectGodotCli(
      fakeDeps({
        pathEnv: '/usr/local/bin',
        exists: (p) => p === '/usr/local/bin/godot',
        runWithVersion: async () => '3.5.3.stable.official\n',
      }),
    );
    expect(status).toEqual({
      ok: false,
      reason: 'wrong-version',
      path: '/usr/local/bin/godot',
      version: '3.5.3.stable.official',
      major: 3,
    });
  });

  it('reports missing when no candidate exists on PATH', async () => {
    const status = await detectGodotCli(
      fakeDeps({
        pathEnv: '/usr/local/bin',
        exists: () => false,
      }),
    );
    expect(status).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports missing when the binary throws on --version (broken install)', async () => {
    const status = await detectGodotCli(
      fakeDeps({
        pathEnv: '/usr/local/bin',
        exists: (p) => p === '/usr/local/bin/godot',
        runWithVersion: async () => {
          throw new Error('ENOENT spawn godot');
        },
      }),
    );
    expect(status).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports missing when --version output is unparseable', async () => {
    const status = await detectGodotCli(
      fakeDeps({
        pathEnv: '/usr/local/bin',
        exists: (p) => p === '/usr/local/bin/godot',
        runWithVersion: async () => 'not the godot binary\n',
      }),
    );
    expect(status).toEqual({ ok: false, reason: 'missing' });
  });
});
