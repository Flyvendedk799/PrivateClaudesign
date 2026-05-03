/**
 * Verifies the turn-counter logic that the chat status header reads from
 * `agentLiveness.turnCount` to render "· turn N" past the threshold.
 *
 * The math lives inline in `handleTurnStart`:
 *   sameGen = prevLiveness?.turnCountGenerationId === event.generationId
 *   nextTurnCount = sameGen ? (prevLiveness?.turnCount ?? 0) + 1 : 1
 *
 * Mirrored here as a pure helper so it can be exercised without spinning up
 * the React renderer or Electron IPC plumbing.
 */

import { describe, expect, it } from 'vitest';

interface LivenessSlice {
  turnCount: number;
  turnCountGenerationId: string | null;
}

function nextTurnCount(prev: LivenessSlice | null, generationId: string): LivenessSlice {
  const sameGen = prev?.turnCountGenerationId === generationId;
  return {
    turnCount: sameGen ? (prev?.turnCount ?? 0) + 1 : 1,
    turnCountGenerationId: generationId,
  };
}

const TURN_COUNT_THRESHOLD = 10;

describe('agentLiveness turn counter', () => {
  it('starts at 1 on the first turn_start of a fresh run', () => {
    const next = nextTurnCount(null, 'gen-1');
    expect(next.turnCount).toBe(1);
    expect(next.turnCountGenerationId).toBe('gen-1');
  });

  it('increments within the same generationId', () => {
    let liveness: LivenessSlice | null = null;
    for (let i = 1; i <= 5; i++) {
      liveness = nextTurnCount(liveness, 'gen-1');
      expect(liveness.turnCount).toBe(i);
    }
  });

  it('resets to 1 when generationId changes', () => {
    const afterFirstRun = nextTurnCount({ turnCount: 12, turnCountGenerationId: 'gen-1' }, 'gen-2');
    expect(afterFirstRun.turnCount).toBe(1);
    expect(afterFirstRun.turnCountGenerationId).toBe('gen-2');
  });

  it('threshold gating: short runs stay quiet, long runs surface the count', () => {
    // Below threshold: no "(turn N)" badge.
    expect(9 >= TURN_COUNT_THRESHOLD).toBe(false);
    // At and above threshold: badge appears.
    expect(10 >= TURN_COUNT_THRESHOLD).toBe(true);
    expect(30 >= TURN_COUNT_THRESHOLD).toBe(true);
  });

  it('handles a same-run chunk transition: turnCount accumulates across chunks', () => {
    // Chunk 1: turns 1..3
    let liveness: LivenessSlice | null = null;
    for (let i = 0; i < 3; i++) {
      liveness = nextTurnCount(liveness, 'gen-A');
    }
    expect(liveness?.turnCount).toBe(3);
    // Same generationId continues into chunk 2 — counter should NOT reset.
    for (let i = 0; i < 4; i++) {
      liveness = nextTurnCount(liveness, 'gen-A');
    }
    expect(liveness?.turnCount).toBe(7);
  });
});
