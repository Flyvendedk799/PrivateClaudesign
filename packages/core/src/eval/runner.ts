/**
 * may9 Phase 14 — eval-runner.
 *
 * Pure-compute layer that takes a fixture + an observed-run shape
 * and produces an EvalResult. Two facts that are NOT this module's
 * job:
 *   1. Fetching the observation. Both the SQLite-baseline backend
 *      (scripts/eval-baseline.ts -> RunObservation) and the future
 *      live-replay backend feed into the same shape.
 *   2. Replaying the agent. Live recording is a follow-up; for now
 *      the runner inspects already-recorded designs.
 *
 * Keeping this module pure makes the assertion logic vitest-friendly
 * even when better-sqlite3 native bindings are missing in CI.
 */
import type { EvalFixture, EvalResult } from './fixture.js';

export interface RunObservation {
  /** The agent's chosen engine for this run, or null if no choose_engine
   *  call was recorded. */
  engine: string | null;
  /** The genre from declare_game_spec, or null if no spec recorded. */
  genre: string | null;
  /** Sum of input tokens across all chunks in the run. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from cache. */
  cachedInputTokens: number;
  /** Per-tool counts derived from the chat_messages tool_call rows
   *  or run_tool_durations. */
  toolCounts: Readonly<Record<string, number>>;
  /** Best-effort str_replace failure count. Empty when the recording
   *  source can't distinguish (chat_messages.tool_call doesn't carry
   *  result status); set when run_tool_durations is available. */
  strReplaceFailures: number;
  /** Number of design files present at end-of-run. The fixture can
   *  reference paths via assertions.requiredFiles. */
  filePaths: ReadonlyArray<string>;
  /** Number of snapshots created during this fixture's run. Multi-edit
   *  fixtures will have N > 1. */
  snapshotCount: number;
  /** Number of distinct user prompts beyond the initial — i.e. the
   *  user's correction count. */
  correctionCount: number;
}

const DEFAULT_OBSERVATION: RunObservation = {
  engine: null,
  genre: null,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  toolCounts: {},
  strReplaceFailures: 0,
  filePaths: [],
  snapshotCount: 0,
  correctionCount: 0,
};

function get(toolCounts: Readonly<Record<string, number>>, name: string): number {
  return toolCounts[name] ?? 0;
}

/**
 * Apply a fixture's assertions against an observation. Returns an
 * EvalResult with the per-assertion pass/fail breakdown.
 */
export function evaluateFixture(
  fixture: EvalFixture,
  observation: RunObservation = DEFAULT_OBSERVATION,
  durationMs = 0,
): EvalResult {
  const failures: string[] = [];
  const a = fixture.assertions;

  if (a.expectedEngine !== undefined && observation.engine !== a.expectedEngine) {
    failures.push(
      `engine: expected '${a.expectedEngine}', observed '${observation.engine ?? '(none)'}'`,
    );
  }

  if (a.expectedGenre !== undefined && observation.genre !== a.expectedGenre) {
    failures.push(
      `genre: expected '${a.expectedGenre}', observed '${observation.genre ?? '(none)'}'`,
    );
  }

  for (const required of a.requiredFiles) {
    if (!observation.filePaths.includes(required)) {
      failures.push(`requiredFiles: '${required}' is missing`);
    }
  }

  const audioCalls =
    get(observation.toolCounts, 'generate_audio_asset') +
    get(observation.toolCounts, 'generate_audio');
  if (a.requiredAudio && audioCalls === 0) {
    failures.push('requiredAudio: no generate_audio_asset calls recorded');
  }

  if (observation.inputTokens > a.maxInputTokens) {
    failures.push(
      `inputTokens: ${observation.inputTokens.toLocaleString()} exceeds max ${a.maxInputTokens.toLocaleString()}`,
    );
  }

  const strReplaceCalls =
    get(observation.toolCounts, 'str_replace_based_edit_tool') +
    get(observation.toolCounts, 'str_replace');
  if (strReplaceCalls > 0) {
    const rate = observation.strReplaceFailures / strReplaceCalls;
    if (rate > a.maxStrReplaceFailureRate) {
      failures.push(
        `strReplaceFailureRate: ${(rate * 100).toFixed(1)}% exceeds max ${(a.maxStrReplaceFailureRate * 100).toFixed(1)}%`,
      );
    }
  }

  const setTodosCalls = get(observation.toolCounts, 'set_todos');
  if (setTodosCalls > a.maxSetTodosCalls) {
    failures.push(`set_todos calls: ${setTodosCalls} exceeds max ${a.maxSetTodosCalls}`);
  }

  const validateCalls = get(observation.toolCounts, 'validate_game_scene');
  if (validateCalls < a.minValidateGameSceneCalls) {
    failures.push(
      `validate_game_scene calls: ${validateCalls} below min ${a.minValidateGameSceneCalls}`,
    );
  }

  const playtestCalls = get(observation.toolCounts, 'playtest_game');
  if (playtestCalls < a.minPlaytestGameCalls) {
    failures.push(`playtest_game calls: ${playtestCalls} below min ${a.minPlaytestGameCalls}`);
  }

  const renderPreviewCalls = get(observation.toolCounts, 'render_preview');
  if (renderPreviewCalls > a.maxRenderPreviewCalls) {
    failures.push(
      `render_preview calls: ${renderPreviewCalls} exceeds max ${a.maxRenderPreviewCalls}`,
    );
  }

  if (observation.correctionCount > a.maxCorrections) {
    failures.push(`corrections: ${observation.correctionCount} exceeds max ${a.maxCorrections}`);
  }

  const cacheHitRate =
    observation.inputTokens > 0 ? observation.cachedInputTokens / observation.inputTokens : 0;

  return {
    fixture,
    pass: failures.length === 0,
    durationMs,
    failures,
    observed: {
      engine: observation.engine,
      inputTokens: observation.inputTokens,
      outputTokens: observation.outputTokens,
      cacheHitRate,
      setTodosCalls,
      validateGameSceneCalls: validateCalls,
      playtestGameCalls: playtestCalls,
      renderPreviewCalls,
      strReplaceCalls,
      audioCalls,
      snapshotCount: observation.snapshotCount,
      correctionCount: observation.correctionCount,
    },
  };
}
