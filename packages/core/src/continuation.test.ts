/**
 * Phase 4 — `shouldPauseForContinuation` and `buildContinuationPrompt`.
 *
 * Per the Phase 7 ambition guardrails, these functions never CAP — they
 * suggest clean cut points so the runtime can honour the suggestion at
 * the next safe boundary. Tests cover each documented threshold, the
 * priority order between rules, and the byte-stable prompt format.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_THRESHOLDS,
  buildContinuationPrompt,
  shouldPauseForContinuation,
} from './continuation';

const baseState = {
  contextUsedPct: 0.5,
  outputTokens: 10_000,
  wallClockMs: 60_000,
  modelEmittedPause: false,
};

describe('shouldPauseForContinuation (Phase 4)', () => {
  it('returns pause:false when no threshold trips', () => {
    expect(shouldPauseForContinuation(baseState)).toEqual({ pause: false });
  });

  it('pauses on context_threshold at 80%', () => {
    const result = shouldPauseForContinuation({
      ...baseState,
      contextUsedPct: CONTINUATION_THRESHOLDS.contextUsedPct,
    });
    expect(result).toEqual({ pause: true, reason: 'context_threshold' });
  });

  it('does NOT pause at 79% context — strictly below the threshold', () => {
    expect(shouldPauseForContinuation({ ...baseState, contextUsedPct: 0.79 }).pause).toBe(false);
  });

  it('pauses on output_budget at 50K output tokens', () => {
    expect(
      shouldPauseForContinuation({
        ...baseState,
        outputTokens: CONTINUATION_THRESHOLDS.outputTokens,
      }),
    ).toEqual({ pause: true, reason: 'output_budget' });
  });

  it('pauses on wall_clock at 10 min', () => {
    expect(
      shouldPauseForContinuation({
        ...baseState,
        wallClockMs: CONTINUATION_THRESHOLDS.wallClockMs,
      }),
    ).toEqual({ pause: true, reason: 'wall_clock' });
  });

  it('model_requested overrides every threshold', () => {
    expect(
      shouldPauseForContinuation({
        ...baseState,
        modelEmittedPause: true,
        contextUsedPct: 0.5,
      }),
    ).toEqual({ pause: true, reason: 'model_requested' });
  });

  it('manual user pause beats threshold-driven pauses but loses to model_requested', () => {
    // user vs. context threshold → user wins (more explicit)
    expect(
      shouldPauseForContinuation({
        ...baseState,
        contextUsedPct: 0.85,
        userRequestedPause: true,
      }),
    ).toEqual({ pause: true, reason: 'manual' });
    // user vs. model → model wins (model knows it can't continue safely)
    expect(
      shouldPauseForContinuation({
        ...baseState,
        modelEmittedPause: true,
        userRequestedPause: true,
      }),
    ).toEqual({ pause: true, reason: 'model_requested' });
  });

  it('thresholds are documented constants — locked at known values', () => {
    expect(CONTINUATION_THRESHOLDS.contextUsedPct).toBe(0.8);
    expect(CONTINUATION_THRESHOLDS.outputTokens).toBe(50_000);
    expect(CONTINUATION_THRESHOLDS.wallClockMs).toBe(600_000);
  });

  it('thresholds object is frozen — accidental mutation throws', () => {
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate mutation test
      (CONTINUATION_THRESHOLDS as any).contextUsedPct = 0.99;
    }).toThrow();
  });
});

describe('buildContinuationPrompt (Phase 4)', () => {
  const fpsTodos = {
    items: [
      { text: 'Enemy body: slimmer torso, tactical vest overlay', checked: true },
      { text: 'Enemy walk cycle: elbow pump, spine twist, hip bob', checked: true },
      { text: 'Enemy attack stance: crouch lean, elbow raise', checked: false },
      { text: 'Player gun: idle figure-8 sway + rotational shoot kick', checked: false },
    ],
  };

  it('embeds the original brief, todos, recap, and fs state — byte-stable', () => {
    const out = buildContinuationPrompt({
      todos: fpsTodos,
      decisionRecap:
        'Done: enemy body geometry + walk cycle. Next: attack stance + player gun sway.',
      fsState: [{ path: 'index.html', bytes: 78_240 }],
      originalUserPrompt: 'Improve all character animations and details + shaders.',
    });
    expect(out).toContain('# Continuation');
    expect(out).toContain('## Original brief');
    expect(out).toContain('Improve all character animations');
    expect(out).toContain('## Plan (latest set_todos snapshot)');
    expect(out).toContain('- [x] Enemy body: slimmer torso, tactical vest overlay');
    expect(out).toContain('- [ ] Player gun: idle figure-8 sway + rotational shoot kick');
    expect(out).toContain('## What was decided + what is next');
    expect(out).toContain('## Filesystem state at pause point');
    expect(out).toContain('`index.html` (78240 bytes)');
    expect(out).toContain('Continue.');
    // Same input always produces same bytes.
    const out2 = buildContinuationPrompt({
      todos: fpsTodos,
      decisionRecap:
        'Done: enemy body geometry + walk cycle. Next: attack stance + player gun sway.',
      fsState: [{ path: 'index.html', bytes: 78_240 }],
      originalUserPrompt: 'Improve all character animations and details + shaders.',
    });
    expect(out).toBe(out2);
  });

  it('omits the plan section entirely when todos is null', () => {
    const out = buildContinuationPrompt({
      todos: null,
      decisionRecap: 'recap',
      fsState: [],
      originalUserPrompt: 'go',
    });
    expect(out).not.toContain('## Plan');
    expect(out).toContain('recap');
  });

  it('omits the fs section when fsState is empty', () => {
    const out = buildContinuationPrompt({
      todos: null,
      decisionRecap: 'recap',
      fsState: [],
      originalUserPrompt: 'go',
    });
    expect(out).not.toContain('## Filesystem state');
  });

  it('explicitly tells the agent NOT to restart planning', () => {
    const out = buildContinuationPrompt({
      todos: null,
      decisionRecap: '',
      fsState: [],
      originalUserPrompt: 'go',
    });
    expect(out).toContain('do NOT restart the planning phase');
    expect(out).toContain('re-emit the original todos');
  });

  it('does not include any "Now I will" / "Next, I\'ll" prelude (Phase 2 hygiene)', () => {
    const out = buildContinuationPrompt({
      todos: fpsTodos,
      decisionRecap: 'recap',
      fsState: [{ path: 'a.html', bytes: 10 }],
      originalUserPrompt: 'go',
    });
    expect(out).not.toMatch(/Now (I'll|let me|find|replace|add)/i);
    expect(out).not.toMatch(/Next, (I'll|let me)/i);
  });
});
