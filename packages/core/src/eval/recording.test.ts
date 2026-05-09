/**
 * may9 Phase 14 follow-up #34 — recording parser tests.
 */
import { describe, expect, it } from 'vitest';
import { type EvalRecording, emptyRecording, parseEvalRecording } from './recording';

const VALID: EvalRecording = {
  schemaVersion: 1,
  fixtureSlug: 'fps-wave-defense',
  capturedAt: '2026-05-09T12:00:00.000Z',
  designId: 'ba2adf62-f041-486b-95fa-3919088e6c30',
  observation: {
    engine: 'three',
    genre: 'fps',
    inputTokens: 32_780_000,
    outputTokens: 668_000,
    cachedInputTokens: 28_830_000,
    toolCounts: {
      str_replace_based_edit_tool: 428,
      set_todos: 93,
      validate_game_scene: 1,
      playtest_game: 1,
    },
    strReplaceFailures: 80,
    filePaths: ['index.html'],
    snapshotCount: 28,
    correctionCount: 27,
  },
  notes: 'Seeded from the May-8 baseline.',
};

describe('parseEvalRecording', () => {
  it('round-trips a fully-populated recording', () => {
    const parsed = parseEvalRecording(JSON.parse(JSON.stringify(VALID)));
    expect(parsed.fixtureSlug).toBe('fps-wave-defense');
    expect(parsed.observation.engine).toBe('three');
    expect(parsed.observation.toolCounts['set_todos']).toBe(93);
    expect(parsed.observation.snapshotCount).toBe(28);
    expect(parsed.notes).toBe(VALID.notes);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() => parseEvalRecording({ ...VALID, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it('rejects a missing fixtureSlug', () => {
    const { fixtureSlug: _omit, ...broken } = JSON.parse(JSON.stringify(VALID)) as EvalRecording;
    void _omit;
    expect(() => parseEvalRecording(broken)).toThrow(/fixtureSlug/);
  });

  it('rejects a non-numeric inputTokens', () => {
    const broken = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
    (broken['observation'] as Record<string, unknown>)['inputTokens'] = 'lots';
    expect(() => parseEvalRecording(broken)).toThrow(/inputTokens/);
  });

  it('rejects a negative tool count', () => {
    const broken = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
    (broken['observation'] as Record<string, unknown>)['toolCounts'] = { set_todos: -1 };
    expect(() => parseEvalRecording(broken)).toThrow(/set_todos/);
  });

  it('emptyRecording returns a parser-valid sentinel', () => {
    const seeded = emptyRecording('fps-wave-defense', 'three', 'fps');
    const parsed = parseEvalRecording(JSON.parse(JSON.stringify(seeded)));
    expect(parsed.fixtureSlug).toBe('fps-wave-defense');
    expect(parsed.observation.engine).toBe('three');
    expect(parsed.observation.snapshotCount).toBe(0);
  });
});
