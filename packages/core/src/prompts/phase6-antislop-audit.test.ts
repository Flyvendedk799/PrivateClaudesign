/**
 * Phase 6 — anti-slop wiring audit. The plan flagged a possible gap:
 * "anti-slop digest ran but anti-slop full prompt didn't trigger on
 * game runs". This test pins the expected wiring so future edits to
 * the prompt loader can't quietly drop the digest from one path while
 * keeping it in another.
 */

import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from './index.js';

describe('Phase 6 — anti-slop is wired into BOTH design and game prompts', () => {
  it('design-mode chat prompt includes the anti-slop digest', () => {
    const out = composeSystemPrompt({ mode: 'create' });
    expect(out).toMatch(/anti-slop|icon set is in scope|sub-44 px touch targets/i);
  });

  it('design-mode revise prompt includes the FULL anti-slop block', () => {
    const out = composeSystemPrompt({ mode: 'revise' });
    expect(out).toMatch(/Touch targets|Iconography/);
  });

  it('design-mode agent prompt includes anti-slop guidance', () => {
    const out = composeSystemPrompt({ mode: 'create', agentMode: true });
    expect(out).toMatch(/anti-slop|placeholder|lorem ipsum/i);
  });

  it('game-mode prompt includes game anti-slop block', () => {
    const out = composeSystemPrompt({
      mode: 'create',
      agentMode: true,
      artifactType: 'game',
      engine: 'three',
    });
    // Game anti-slop has its own copy ("game-anti-slop.v1.txt").
    expect(out).toMatch(/anti-slop|silent feedback|placeholder/i);
  });
});
