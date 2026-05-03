import { describe, expect, it, vi } from 'vitest';
import {
  type PlaytestStep,
  type Playtester,
  type PlaytesterOutput,
  makePlaytestGameTool,
} from './playtest-game.js';

function makeFs(files: Record<string, string>) {
  return {
    view: (path: string) => {
      const c = files[path];
      return c === undefined ? null : { content: c, numLines: c.split('\n').length };
    },
    listDir: () => Object.keys(files),
    create: vi.fn().mockReturnValue({ path: '' }),
    strReplace: vi.fn().mockReturnValue({ path: '' }),
    insert: vi.fn().mockReturnValue({ path: '' }),
  };
}

function okOutput(overrides: Partial<PlaytesterOutput> = {}): PlaytesterOutput {
  return {
    hasDebugContract: true,
    baselineSnapshot: { playerPos: { x: 0, y: 0, z: 0 }, playerAngle: 0 },
    steps: [],
    bootErrors: [],
    ...overrides,
  };
}

describe('makePlaytestGameTool', () => {
  it('throws when the requested path is not in the fs', async () => {
    const playtester: Playtester = vi.fn().mockResolvedValue(okOutput());
    const tool = makePlaytestGameTool(makeFs({ 'index.html': '<html></html>' }), playtester);
    await expect(
      tool.execute('id', {
        steps: [{ kind: 'key', code: 'KeyD' }] as PlaytestStep[],
        path: 'missing.html',
      }),
    ).rejects.toThrow(/file "missing.html" not found/);
  });

  it('passes the artifact source + steps to the host playtester', async () => {
    const playtester: Playtester = vi.fn().mockResolvedValue(okOutput());
    const tool = makePlaytestGameTool(
      makeFs({ 'index.html': '<html><body>game</body></html>' }),
      playtester,
    );
    await tool.execute('id', {
      steps: [
        { kind: 'key', code: 'KeyD', frames: 30 },
        { kind: 'wait', frames: 5 },
      ] as PlaytestStep[],
    });
    expect(playtester).toHaveBeenCalledTimes(1);
    const call = (playtester as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.artifactSource).toContain('<body>game</body>');
    expect(call.viewport).toBe('desktop');
    expect(call.steps).toHaveLength(2);
    expect(call.steps[0]).toEqual({ kind: 'key', code: 'KeyD', frames: 30 });
  });

  it('flags `no_debug_contract` in the summary when the bootstrap default was never replaced', async () => {
    const playtester: Playtester = vi
      .fn()
      .mockResolvedValue(okOutput({ hasDebugContract: false, baselineSnapshot: null }));
    const tool = makePlaytestGameTool(makeFs({ 'index.html': '<html></html>' }), playtester);
    const res = await tool.execute('id', {
      steps: [{ kind: 'key', code: 'KeyD' }] as PlaytestStep[],
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('NO DEBUG CONTRACT');
    expect(res.details.hasDebugContract).toBe(false);
  });

  it('summarises each step with the snapshot trace', async () => {
    const playtester: Playtester = vi.fn().mockResolvedValue(
      okOutput({
        steps: [
          {
            step: { kind: 'key', code: 'KeyD', frames: 30 },
            snapshotAfter: { playerPos: { x: 1.5, y: 0, z: 0 } },
            errors: [],
          },
        ],
      }),
    );
    const tool = makePlaytestGameTool(makeFs({ 'index.html': '<html></html>' }), playtester);
    const res = await tool.execute('id', {
      steps: [{ kind: 'key', code: 'KeyD', frames: 30 }] as PlaytestStep[],
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Step 1 key KeyD x30f');
    expect(text).toContain('"playerPos":{"x":1.5');
    expect(res.details.stepCount).toBe(1);
    expect(res.details.stepErrorCount).toBe(0);
  });

  it('surfaces boot errors and per-step errors in both the summary and the details', async () => {
    const playtester: Playtester = vi.fn().mockResolvedValue(
      okOutput({
        bootErrors: ['ReferenceError: THREE is not defined'],
        steps: [
          {
            step: { kind: 'mouseDown', button: 0 },
            snapshotAfter: null,
            errors: ['TypeError: cannot read property hp of undefined'],
          },
        ],
      }),
    );
    const tool = makePlaytestGameTool(makeFs({ 'index.html': '<html></html>' }), playtester);
    const res = await tool.execute('id', {
      steps: [{ kind: 'mouseDown', button: 0 }] as PlaytestStep[],
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Boot errors');
    expect(text).toContain('THREE is not defined');
    expect(text).toContain('cannot read property hp');
    expect(res.details.bootErrorCount).toBe(1);
    expect(res.details.stepErrorCount).toBe(1);
  });

  it('truncates very large snapshots so a long history field cannot blow the tool result', async () => {
    const big = { trail: 'x'.repeat(1000) };
    const playtester: Playtester = vi.fn().mockResolvedValue(
      okOutput({
        steps: [{ step: { kind: 'wait', frames: 1 }, snapshotAfter: big, errors: [] }],
      }),
    );
    const tool = makePlaytestGameTool(makeFs({ 'index.html': '<html></html>' }), playtester);
    const res = await tool.execute('id', {
      steps: [{ kind: 'wait', frames: 1 }] as PlaytestStep[],
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/\.\.\.$/m);
  });
});
