/**
 * may9 Phase 8b — destructive-edit advisory tests.
 *
 * Replays the FPS Wave Defense snapshot a3d4afd7 case (110 KB → 21 KB)
 * and verifies the advisory fires; verifies legitimate cleanup prompts
 * (with explicit "remove" / "simplify" intent) suppress the advisory.
 */
import { describe, expect, it } from 'vitest';
import { DESTRUCTIVE_SHRINK_THRESHOLD, checkDestructiveEdit } from './destructive-edit';

describe('checkDestructiveEdit', () => {
  it('fires on the FPS Wave Defense regression case (110 KB → 21 KB)', () => {
    const result = checkDestructiveEdit({
      priorBytes: 110_328,
      currentBytes: 20_788,
      userPrompt: 'Implement a visually pleasing smooth impressive holographic reload ui',
    });
    expect(result.triggered).toBe(true);
    expect(result.shrinkRatio).toBeGreaterThan(0.7);
    expect(result.reason).toContain('Source shrank');
  });

  it('suppresses when the user prompt contains "remove"', () => {
    const result = checkDestructiveEdit({
      priorBytes: 100_000,
      currentBytes: 10_000,
      userPrompt: 'Remove the post-processing filter — its making the screen unreadable',
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain("user prompt contains 'remove'");
  });

  it('suppresses when the prompt contains "simplify"', () => {
    const result = checkDestructiveEdit({
      priorBytes: 100_000,
      currentBytes: 30_000,
      userPrompt: 'Simplify the rendering pipeline so it loads under 1s',
    });
    expect(result.triggered).toBe(false);
  });

  it('does not fire below the 40% threshold', () => {
    const result = checkDestructiveEdit({
      priorBytes: 100_000,
      currentBytes: 75_000, // 25% shrink
      userPrompt: 'add HUD',
    });
    expect(result.triggered).toBe(false);
    expect(result.shrinkRatio).toBeCloseTo(0.25, 2);
  });

  it('returns triggered=false when there is no prior snapshot', () => {
    const result = checkDestructiveEdit({
      priorBytes: 0,
      currentBytes: 5000,
      userPrompt: 'first run',
    });
    expect(result.triggered).toBe(false);
  });

  it('threshold lives at the documented constant', () => {
    expect(DESTRUCTIVE_SHRINK_THRESHOLD).toBe(0.4);
  });
});
