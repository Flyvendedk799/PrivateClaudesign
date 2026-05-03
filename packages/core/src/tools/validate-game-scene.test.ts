/**
 * gameplan §A5 + §7.6 — validate_game_scene tool tests.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TextEditorFsCallbacks } from './text-editor';
import {
  type ValidateGameSceneFn,
  type ValidateOutcome,
  makeValidateGameSceneTool,
} from './validate-game-scene';

function makeFs(files: Record<string, string>): TextEditorFsCallbacks {
  const paths = Object.keys(files);
  return {
    view: (path) => {
      const content = files[path];
      return content !== undefined ? { content, numLines: content.split('\n').length } : null;
    },
    create: () => ({ path: '' }),
    strReplace: () => ({ path: '' }),
    insert: () => ({ path: '' }),
    listDir: (dir) => {
      // Top-level call: dir === ''. Return all paths. Subsequent recursion
      // is filtered to children of that dir.
      if (dir === '') return paths;
      return paths.filter((p) => p.startsWith(`${dir}/`));
    },
  };
}

const okOutcome: ValidateOutcome = { ok: true, engine: 'phaser', issues: [] };

describe('makeValidateGameSceneTool', () => {
  it('forwards engine + read-back files to the host validate callback', async () => {
    const validate = vi.fn<ValidateGameSceneFn>().mockResolvedValue(okOutcome);
    const tool = makeValidateGameSceneTool({
      fs: makeFs({
        'index.html': '<!doctype html><body><div id="game"></div></body>',
        'src/main.js': "import Phaser from 'phaser';",
      }),
      getCurrentEngine: () => 'phaser',
      validate,
    });
    const result = await tool.execute('id-1', {});
    expect(validate).toHaveBeenCalledOnce();
    const [engineArg, filesArg] = validate.mock.calls[0] ?? [];
    expect(engineArg).toBe('phaser');
    expect(filesArg).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'index.html' }),
        expect.objectContaining({ path: 'src/main.js' }),
      ]),
    );
    expect(result.details.engine).toBe('phaser');
    expect(result.details.ok).toBe(true);
  });

  it('honours the per-call engine override (agent passes engine param explicitly)', async () => {
    const validate = vi
      .fn<ValidateGameSceneFn>()
      .mockResolvedValue({ ok: true, engine: 'three', issues: [] });
    const tool = makeValidateGameSceneTool({
      fs: makeFs({}),
      getCurrentEngine: () => 'phaser', // host says phaser, agent overrides to three
      validate,
    });
    await tool.execute('id-1', { engine: 'three' });
    expect(validate.mock.calls[0]?.[0]).toBe('three');
  });

  it('throws when no engine is set yet (agent forgot choose_engine)', async () => {
    const tool = makeValidateGameSceneTool({
      fs: makeFs({}),
      getCurrentEngine: () => null,
      validate: vi.fn(),
    });
    await expect(tool.execute('id-1', {})).rejects.toThrow(/choose_engine/);
  });

  it('returns ok summary when validation passes', async () => {
    const tool = makeValidateGameSceneTool({
      fs: makeFs({ 'index.html': '<html></html>' }),
      getCurrentEngine: () => 'three',
      validate: () => ({ ok: true, engine: 'three', issues: [] }),
    });
    const result = await tool.execute('id-1', {});
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('validate_game_scene OK');
    expect(text).toContain('three');
  });

  it('formats failing issues into a blocking message', async () => {
    const tool = makeValidateGameSceneTool({
      fs: makeFs({ 'index.html': '<html></html>' }),
      getCurrentEngine: () => 'phaser',
      validate: () => ({
        ok: false,
        engine: 'phaser',
        issues: [
          { path: 'src/main.js', line: 12, message: 'No physics block', severity: 'error' },
          { path: 'index.html', message: 'Missing canvas', severity: 'warn' },
        ],
      }),
    });
    const result = await tool.execute('id-1', {});
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('FAILED');
    expect(text).toContain('1 error');
    expect(text).toContain('1 warning');
    expect(text).toContain('[ERROR] src/main.js:12 — No physics block');
    expect(text).toContain('[WARN] index.html — Missing canvas');
    expect(result.details.errorCount).toBe(1);
    expect(result.details.warnCount).toBe(1);
    expect(result.details.ok).toBe(false);
  });

  it('walks the file bundle (including nested src/ paths)', async () => {
    const validate = vi.fn<ValidateGameSceneFn>().mockResolvedValue(okOutcome);
    const tool = makeValidateGameSceneTool({
      fs: makeFs({
        'index.html': '<html></html>',
        'src/main.js': 'main',
        'src/scenes/play.js': 'play',
        'src/entities/player.js': 'player',
      }),
      getCurrentEngine: () => 'phaser',
      validate,
    });
    await tool.execute('id-1', {});
    const filesArg = validate.mock.calls[0]?.[1] ?? [];
    const paths = filesArg.map((f) => f.path).sort();
    expect(paths).toContain('index.html');
    expect(paths).toContain('src/main.js');
    expect(paths).toContain('src/scenes/play.js');
    expect(paths).toContain('src/entities/player.js');
  });
});
