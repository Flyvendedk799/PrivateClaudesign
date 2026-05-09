/**
 * may9 Phase 14 — eval fixture parser tests.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine, EvalFixture } from './fixture';

describe('EvalFixture.parse', () => {
  it('parses a minimal fixture with defaults', () => {
    const fx = EvalFixture.parse({
      name: 'Minimal',
      slug: 'minimal',
      description: 'desc',
      brief: 'brief text',
    });
    expect(fx.name).toBe('Minimal');
    expect(fx.slug).toBe('minimal');
    expect(fx.assertions.maxSetTodosCalls).toBe(8);
    expect(fx.assertions.minValidateGameSceneCalls).toBe(1);
    expect(fx.assertions.maxRenderPreviewCalls).toBe(0);
    expect(fx.assertions.requiredFiles).toEqual([]);
    expect(fx.assertions.requiredAudio).toBe(false);
  });

  it('rejects an invalid slug', () => {
    expect(() =>
      EvalFixture.parse({
        name: 'Bad',
        slug: 'Has Spaces',
        description: 'd',
        brief: 'b',
      }),
    ).toThrow(/slug/);
  });

  it('rejects an unknown engine', () => {
    expect(() => EvalEngine.parse('unity')).toThrow(/Invalid engine/);
  });

  it('accepts every may9 bundled engine', () => {
    expect(EvalEngine.parse('three')).toBe('three');
    expect(EvalEngine.parse('phaser')).toBe('phaser');
    expect(EvalEngine.parse('pygame')).toBe('pygame');
    expect(EvalEngine.parse('godot')).toBe('godot');
  });

  it('rejects maxStrReplaceFailureRate outside [0,1]', () => {
    expect(() =>
      EvalFixture.parse({
        name: 'x',
        slug: 'x',
        description: 'd',
        brief: 'b',
        assertions: { maxStrReplaceFailureRate: 2 },
      }),
    ).toThrow(/maxStrReplaceFailureRate/);
  });

  it('rejects an unknown engine in expectedEngine', () => {
    expect(() =>
      EvalFixture.parse({
        name: 'x',
        slug: 'x',
        description: 'd',
        brief: 'b',
        assertions: { expectedEngine: 'unity' },
      }),
    ).toThrow(/Invalid engine/);
  });

  it('parses every bundled fixture from disk', async () => {
    // Reading the bundled JSONs validates that the fixtures committed
    // to the repo all conform to this parser.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const fixturesDir = path.resolve(here, '..', '..', '..', '..', 'evals', 'fixtures');
    if (!fs.existsSync(fixturesDir)) return; // CI may run before the dir is committed.
    const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'));
      const fx = EvalFixture.parse(raw);
      expect(fx.slug.length).toBeGreaterThan(0);
    }
  });
});
