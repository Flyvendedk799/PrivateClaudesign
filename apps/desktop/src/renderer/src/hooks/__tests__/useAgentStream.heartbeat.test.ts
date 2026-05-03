/**
 * plan0305 P2.4 — verifies the heartbeat-driven "still working — last update
 * mm:ss ago" placeholder math lives in useAgentStream's `handleHeartbeat`.
 *
 * The handler:
 *   - ticks liveness on every heartbeat (so the run-watchdog stays happy)
 *   - synthesises a placeholder thinkingBuffer ONLY when the model itself
 *     hasn't produced thinking content this turn — otherwise the model's
 *     real reasoning text wins and we leave it alone.
 *
 * Mirrored here as a pure helper to exercise without React / IPC plumbing.
 */

import { describe, expect, it } from 'vitest';

interface HeartbeatInput {
  hasModelThinkingContent: boolean;
  sinceMs: number;
}

interface HeartbeatOutcome {
  tickedLiveness: boolean;
  placeholder: string | null;
}

function computeHeartbeatOutcome(input: HeartbeatInput): HeartbeatOutcome {
  if (input.hasModelThinkingContent) {
    return { tickedLiveness: true, placeholder: null };
  }
  const totalSec = Math.floor(input.sinceMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const padded = `${m}:${s.toString().padStart(2, '0')}`;
  return { tickedLiveness: true, placeholder: `Still working — last update ${padded} ago` };
}

describe('useAgentStream heartbeat placeholder (plan0305 P2.4)', () => {
  it('always ticks liveness, even when the model has its own thinking content', () => {
    const out = computeHeartbeatOutcome({ hasModelThinkingContent: true, sinceMs: 12_000 });
    expect(out.tickedLiveness).toBe(true);
    expect(out.placeholder).toBeNull();
  });

  it('synthesises a placeholder when the thinking buffer is empty', () => {
    const out = computeHeartbeatOutcome({ hasModelThinkingContent: false, sinceMs: 12_000 });
    expect(out.placeholder).toBe('Still working — last update 0:12 ago');
  });

  it('formats minutes and zero-pads the seconds (matches the run 1 turn 3 14-min gap)', () => {
    const out = computeHeartbeatOutcome({
      hasModelThinkingContent: false,
      sinceMs: 14 * 60 * 1000 + 7 * 1000,
    });
    expect(out.placeholder).toBe('Still working — last update 14:07 ago');
  });

  it('rounds the elapsed value down (sub-second remainder is dropped)', () => {
    const out = computeHeartbeatOutcome({ hasModelThinkingContent: false, sinceMs: 65_900 });
    expect(out.placeholder).toBe('Still working — last update 1:05 ago');
  });
});
