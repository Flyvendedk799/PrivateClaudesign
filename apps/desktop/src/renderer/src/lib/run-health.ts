/**
 * Improver1 §10 — derive a run-health level from the rolling
 * agentLiveness metrics. Pure function so the renderer can compute
 * the pill state on every tick without re-walking events; also
 * unit-testable in isolation.
 *
 * Inputs come from the agentLiveness slice (see store.ts):
 *  - turnCount, runToolCount, runFailureCount: cumulative counters
 *  - recentTurns: per-turn buffer of {tools, edits, failures}
 *
 * Health bands grounded in 2026-05-05 production data:
 *  - tools-per-turn: healthy ≤ 2.0, warn > 2.5, alert > 3.5
 *    (today's c44763af averaged ~2.2 tools/turn — borderline)
 *  - edits-per-turn (last 10 turns): warn < 0.3, alert < 0.1
 *    (today's run-2 had 1-2 small edits + many views = ~0.4 edits/turn
 *    in the back half — would warn but not alert)
 *  - failure-rate of tool_call_results: warn ≥ 20 %, alert ≥ 35 %
 *    (today's str_replace miss rate was 32 % — borderline)
 *
 * Suppressed under HEALTH_TURN_FLOOR turns to avoid early-run noise.
 */

export type HealthLevel = 'neutral' | 'warn' | 'alert';

export interface HealthInput {
  turnCount: number;
  runToolCount: number;
  runFailureCount: number;
  recentTurns: Array<{ tools: number; edits: number; failures: number }>;
}

export interface HealthSnapshot {
  level: HealthLevel;
  reasons: string[];
  /** Numeric metrics surfaced in tooltips. */
  metrics: {
    toolsPerTurn: number;
    editsPerTurn: number | null;
    failureRate: number | null;
  };
}

const HEALTH_TURN_FLOOR = 8;
const TOOLS_PER_TURN_WARN = 2.5;
const TOOLS_PER_TURN_ALERT = 3.5;
const EDITS_PER_TURN_WARN = 0.3;
const EDITS_PER_TURN_ALERT = 0.1;
const FAILURE_RATE_WARN = 0.2;
const FAILURE_RATE_ALERT = 0.35;

export function computeRunHealth(input: HealthInput): HealthSnapshot {
  const { turnCount, runToolCount, runFailureCount, recentTurns } = input;
  // Don't render a health verdict for short runs — every run looks
  // "off" in the first 5-8 turns because tool counts are noisy.
  if (turnCount < HEALTH_TURN_FLOOR) {
    return {
      level: 'neutral',
      reasons: [],
      metrics: { toolsPerTurn: 0, editsPerTurn: null, failureRate: null },
    };
  }
  const toolsPerTurn = turnCount > 0 ? runToolCount / turnCount : 0;
  const editsTotal = recentTurns.reduce((sum, t) => sum + t.edits, 0);
  const toolsTotal = recentTurns.reduce((sum, t) => sum + t.tools, 0);
  const failuresTotal = recentTurns.reduce((sum, t) => sum + t.failures, 0);
  const editsPerTurn = recentTurns.length > 0 ? editsTotal / recentTurns.length : null;
  const failureRate = toolsTotal > 0 ? failuresTotal / toolsTotal : null;

  const reasons: string[] = [];
  let level: HealthLevel = 'neutral';

  // Tools-per-turn: many tools per turn = thrashing.
  if (toolsPerTurn >= TOOLS_PER_TURN_ALERT) {
    level = 'alert';
    reasons.push(`tools/turn ${toolsPerTurn.toFixed(1)} (≥ ${TOOLS_PER_TURN_ALERT})`);
  } else if (toolsPerTurn >= TOOLS_PER_TURN_WARN) {
    if (level === 'neutral') level = 'warn';
    reasons.push(`tools/turn ${toolsPerTurn.toFixed(1)} (≥ ${TOOLS_PER_TURN_WARN})`);
  }

  // Edits-per-turn: low edits = small-tweak / re-read mode. Only
  // meaningful when we have a full lookback window to compare against.
  if (editsPerTurn !== null && recentTurns.length >= HEALTH_TURN_FLOOR) {
    if (editsPerTurn < EDITS_PER_TURN_ALERT) {
      level = 'alert';
      reasons.push(`edits/turn ${editsPerTurn.toFixed(2)} (< ${EDITS_PER_TURN_ALERT})`);
    } else if (editsPerTurn < EDITS_PER_TURN_WARN) {
      if (level === 'neutral') level = 'warn';
      reasons.push(`edits/turn ${editsPerTurn.toFixed(2)} (< ${EDITS_PER_TURN_WARN})`);
    }
  }

  // Failure rate: high tool error rate = thrash on the same target.
  if (failureRate !== null) {
    if (failureRate >= FAILURE_RATE_ALERT) {
      level = 'alert';
      reasons.push(
        `${Math.round(failureRate * 100)} % tool failures (≥ ${Math.round(FAILURE_RATE_ALERT * 100)} %)`,
      );
    } else if (failureRate >= FAILURE_RATE_WARN) {
      if (level === 'neutral') level = 'warn';
      reasons.push(
        `${Math.round(failureRate * 100)} % tool failures (≥ ${Math.round(FAILURE_RATE_WARN * 100)} %)`,
      );
    }
  }

  // Run-level fallback: lots of cumulative failures even if the rolling
  // window is calm right now.
  if (runFailureCount >= 6 && level === 'neutral') {
    level = 'warn';
    reasons.push(`${runFailureCount} cumulative tool failures`);
  }

  return {
    level,
    reasons,
    metrics: { toolsPerTurn, editsPerTurn, failureRate },
  };
}
