import { describe, expect, it, vi } from 'vitest';
import { type BuildUnityFn, makeBuildUnityTool } from './build-unity';

describe('build_unity tool', () => {
  it('threads files + target into the build callback and returns artifact path', async () => {
    const calls: Array<{ files: number; target: string; outDir: string }> = [];
    const stubBuild: BuildUnityFn = async (req) => {
      calls.push({ files: req.files.length, target: req.target, outDir: req.outDir });
      return {
        ok: true,
        artifactPath: '/tmp/out/Game.app',
        buildMs: 12_345,
        errors: [],
        warnings: [],
        editorVersion: '6000.0.23f1',
        editorPath: '/Editor/Unity',
      };
    };
    const tool = makeBuildUnityTool(stubBuild, {
      listFiles: () => [
        { path: 'ProjectSettings/ProjectVersion.txt', content: 'm_EditorVersion: 6000.0.23f1' },
        { path: 'Assets/Scenes/Main.unity', content: '%YAML 1.1' },
      ],
      resolveOutDir: (target) => `/tmp/${target}`,
    });
    const result = await tool.execute('id-1', { target: 'StandaloneOSX' });
    expect(result.details.ok).toBe(true);
    expect(result.details.target).toBe('StandaloneOSX');
    expect(result.details.artifactPath).toBe('/tmp/out/Game.app');
    expect(calls[0]?.files).toBe(2);
    expect(calls[0]?.outDir).toBe('/tmp/StandaloneOSX');
  });

  it('reports a failed build with parsed CS errors in the result text', async () => {
    const stubBuild: BuildUnityFn = async () => ({
      ok: false,
      buildMs: 5_000,
      errors: [
        { code: 'CS0103', message: "name 'Foo' missing", path: 'Assets/Scripts/Foo.cs', line: 12 },
      ],
      warnings: [],
      editorVersion: '6000.0.23f1',
      editorPath: '/x/Unity',
    });
    const tool = makeBuildUnityTool(stubBuild, {
      listFiles: () => [],
      resolveOutDir: () => '/tmp/o',
    });
    const result = await tool.execute('id-1', { target: 'WebGL' });
    expect(result.details.ok).toBe(false);
    expect(result.details.errorCount).toBe(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('FAILED');
    expect(text).toContain('CS0103');
    expect(text).toContain('Foo.cs:12');
  });

  it('honors the development flag', async () => {
    const recv: Array<{ development?: boolean }> = [];
    const stubBuild: BuildUnityFn = async (req) => {
      recv.push({ ...(req.development !== undefined ? { development: req.development } : {}) });
      return {
        ok: true,
        artifactPath: '/tmp/Game.app',
        buildMs: 1,
        errors: [],
        warnings: [],
        editorVersion: '6000.0.23f1',
        editorPath: '/x',
      };
    };
    const tool = makeBuildUnityTool(stubBuild, {
      listFiles: () => [],
      resolveOutDir: () => '/o',
    });
    await tool.execute('id', { target: 'StandaloneOSX', development: true });
    expect(recv[0]?.development).toBe(true);
  });

  it('rethrows when the build callback throws', async () => {
    const stubBuild: BuildUnityFn = async () => {
      throw new Error('No Unity Editor found');
    };
    const tool = makeBuildUnityTool(stubBuild, {
      listFiles: () => [],
      resolveOutDir: () => '/o',
    });
    await expect(tool.execute('id', { target: 'StandaloneOSX' })).rejects.toThrow(
      /No Unity Editor/,
    );
  });
});
