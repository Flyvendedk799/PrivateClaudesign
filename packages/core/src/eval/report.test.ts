/**
 * may9 Phase 14 — eval report markdown tests.
 */
import { describe, expect, it } from 'vitest';
import { EvalFixture, type EvalReport } from './fixture';
import { renderEvalReport } from './report';
import { evaluateFixture } from './runner';

const PLATFORMER: EvalFixture = EvalFixture.parse({
  name: 'Platformer baseline',
  slug: 'platformer-2d',
  description: 'Pong-style 2D platformer',
  brief: 'Make a 2D platformer with jumping and a flag.',
  assertions: { expectedEngine: 'phaser', expectedGenre: 'platformer' },
});

describe('renderEvalReport', () => {
  it('renders a markdown table with status badges + summary line', () => {
    const passed = evaluateFixture(PLATFORMER, {
      engine: 'phaser',
      genre: 'platformer',
      inputTokens: 500_000,
      outputTokens: 20_000,
      cachedInputTokens: 350_000,
      toolCounts: {
        str_replace_based_edit_tool: 30,
        set_todos: 2,
        validate_game_scene: 1,
        playtest_game: 1,
      },
      strReplaceFailures: 0,
      filePaths: ['index.html'],
      snapshotCount: 1,
      correctionCount: 0,
    });
    const failed = evaluateFixture(PLATFORMER, {
      engine: 'pygame',
      genre: 'platformer',
      inputTokens: 500_000,
      outputTokens: 20_000,
      cachedInputTokens: 0,
      toolCounts: {},
      strReplaceFailures: 0,
      filePaths: [],
      snapshotCount: 0,
      correctionCount: 0,
    });
    const report: EvalReport = {
      generatedAt: '2026-05-09',
      results: [passed, failed],
      summary: { total: 2, passed: 1, failed: 1 },
    };
    const md = renderEvalReport(report);
    expect(md).toContain('# Eval report');
    expect(md).toContain('1 / 2 fixtures passed (1 failed)');
    expect(md).toContain('| ✓ pass |');
    expect(md).toContain('| ✗ FAIL |');
    expect(md).toContain('## Failures');
    expect(md).toContain('platformer-2d');
  });

  it('renders "(none)" when all fixtures pass', () => {
    const ok = evaluateFixture(PLATFORMER, {
      engine: 'phaser',
      genre: 'platformer',
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 50,
      toolCounts: { validate_game_scene: 1, playtest_game: 1 },
      strReplaceFailures: 0,
      filePaths: [],
      snapshotCount: 0,
      correctionCount: 0,
    });
    const md = renderEvalReport({
      generatedAt: '2026-05-09',
      results: [ok],
      summary: { total: 1, passed: 1, failed: 0 },
    });
    expect(md).toContain('_(none)_');
  });
});
