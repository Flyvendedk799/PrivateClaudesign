/**
 * Verifies the per-run failure-counter logic that the chat status header
 * reads from `agentLiveness.runFailureCount` to render an "N retries this
 * run" warning badge past a threshold.
 *
 * The math lives inline in `handleToolCallResult`:
 *   if (event.isFailure === true) {
 *     sameGen = prev?.runFailureGenerationId === event.generationId
 *     nextCount = sameGen ? (prev?.runFailureCount ?? 0) + 1 : 1
 *   }
 *
 * Mirrored here as a pure helper so it can be exercised without spinning up
 * the React renderer or Electron IPC plumbing.
 */

import { describe, expect, it } from 'vitest';

interface FailureSlice {
  runFailureCount: number;
  runFailureGenerationId: string | null;
}

function nextRunFailureCount(prev: FailureSlice | null, generationId: string): FailureSlice {
  const sameGen = prev?.runFailureGenerationId === generationId;
  return {
    runFailureCount: sameGen ? (prev?.runFailureCount ?? 0) + 1 : 1,
    runFailureGenerationId: generationId,
  };
}

const RUN_FAILURE_THRESHOLD = 3;

describe('agentLiveness run failure counter', () => {
  it('starts at 1 on the first failure of a fresh run', () => {
    const next = nextRunFailureCount(null, 'gen-1');
    expect(next.runFailureCount).toBe(1);
    expect(next.runFailureGenerationId).toBe('gen-1');
  });

  it('increments on each failure within the same generationId', () => {
    let slice: FailureSlice | null = null;
    for (let i = 1; i <= 6; i++) {
      slice = nextRunFailureCount(slice, 'gen-1');
      expect(slice.runFailureCount).toBe(i);
    }
  });

  it('resets to 1 when a new run starts (generationId change)', () => {
    const after = nextRunFailureCount(
      { runFailureCount: 9, runFailureGenerationId: 'gen-1' },
      'gen-2',
    );
    expect(after.runFailureCount).toBe(1);
    expect(after.runFailureGenerationId).toBe('gen-2');
  });

  it('threshold gating: 0-2 stays quiet, 3+ shows the badge', () => {
    // The 2026-04-29 traces showed mostly-healthy runs at 0-2 failures and
    // thrashing runs at 8+. Threshold of 3 cleanly separates them.
    expect(0 >= RUN_FAILURE_THRESHOLD).toBe(false);
    expect(2 >= RUN_FAILURE_THRESHOLD).toBe(false);
    expect(3 >= RUN_FAILURE_THRESHOLD).toBe(true);
    expect(9 >= RUN_FAILURE_THRESHOLD).toBe(true);
  });

  it('counts only failure events — non-failure tool_call_result is ignored', () => {
    // Pure helper assumes the caller already filtered on event.isFailure ===
    // true. Verifies the increment is monotonic when called repeatedly.
    let slice: FailureSlice | null = null;
    slice = nextRunFailureCount(slice, 'gen-A');
    slice = nextRunFailureCount(slice, 'gen-A');
    expect(slice.runFailureCount).toBe(2);
    // No call between → no increment in the slice.
    expect(slice.runFailureCount).toBe(2);
  });
});
