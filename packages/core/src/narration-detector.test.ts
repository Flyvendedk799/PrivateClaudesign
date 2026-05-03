import { describe, expect, it } from 'vitest';
import { createNarrationDetector } from './narration-detector.js';

describe('createNarrationDetector', () => {
  it('does not flag text emitted BEFORE the first tool_use (Mechanic spec block)', () => {
    const det = createNarrationDetector();
    det.observeTextDelta('Genre: brawler\nReference: Hades\n');
    det.observeTextDelta('Camera: 3rd-person-follow\n');
    det.observeToolStart();
    det.observeToolStart();
    const out = det.endTurn();
    expect(out.narrations).toEqual([]);
    expect(out.totalOffenses).toBe(0);
  });

  it('flags inter-tool narration that fits the short transitional shape', () => {
    const det = createNarrationDetector();
    det.observeToolStart();
    det.observeTextDelta('Now adding the keyframes:');
    det.observeToolStart();
    const out = det.endTurn();
    expect(out.narrations).toEqual(['Now adding the keyframes:']);
    expect(out.totalOffenses).toBe(1);
  });

  it('keeps long-form mid-turn explanations (>200 chars) since they are usually deliverable summaries', () => {
    const det = createNarrationDetector();
    det.observeToolStart();
    const longText = 'This is a deliverable-style explanation '.repeat(8);
    det.observeTextDelta(longText);
    det.observeToolStart();
    const out = det.endTurn();
    expect(out.narrations).toEqual([]);
    expect(out.totalOffenses).toBe(0);
  });

  it('counts every narration segment when the turn has multiple offenses', () => {
    const det = createNarrationDetector();
    det.observeToolStart();
    det.observeTextDelta('Now let me');
    det.observeToolStart();
    det.observeTextDelta('Good, now I will');
    det.observeToolStart();
    const out = det.endTurn();
    expect(out.narrations).toEqual(['Now let me', 'Good, now I will']);
    expect(out.totalOffenses).toBe(2);
  });

  it('keeps a running total across multiple turns', () => {
    const det = createNarrationDetector();
    det.observeToolStart();
    det.observeTextDelta('Now adding');
    det.observeToolStart();
    expect(det.endTurn().totalOffenses).toBe(1);
    det.observeToolStart();
    det.observeTextDelta('Now fix');
    det.observeToolStart();
    const second = det.endTurn();
    expect(second.narrations).toEqual(['Now fix']);
    expect(second.totalOffenses).toBe(2);
  });

  it('does not flag tail text emitted AFTER the last tool_use (e.g. final summary)', () => {
    const det = createNarrationDetector();
    det.observeToolStart();
    det.observeTextDelta('a long deliverable summary of what was built');
    const out = det.endTurn();
    expect(out.narrations).toEqual([]);
  });

  it('respects custom maxChars', () => {
    const det = createNarrationDetector({ maxChars: 12 });
    det.observeToolStart();
    det.observeTextDelta('thirteen chs!');
    det.observeToolStart();
    expect(det.endTurn().narrations).toEqual([]);

    const det2 = createNarrationDetector({ maxChars: 12 });
    det2.observeToolStart();
    det2.observeTextDelta('twelve chrs');
    det2.observeToolStart();
    expect(det2.endTurn().narrations).toEqual(['twelve chrs']);
  });
});
