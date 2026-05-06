/**
 * Phase 2 — strengthened prompts. The FPS run (2026-05-06 design ba2adf62
 * session 7) emitted 15 short "Now / Next, / Continuing —" intent lines
 * between tool_calls despite the existing "no inter-tool prose" rule.
 *
 * These assertions make the strengthened prompt a hard contract: future
 * edits to workflow.v1 / game-workflow.v1 cannot remove the FPS-run
 * regression cases or the first-line filter without breaking this test.
 */

import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from './index.js';

describe('Phase 2 — first-line filter present in agent prompts', () => {
  const designAgent = composeSystemPrompt({ mode: 'create', agentMode: true });
  const gameAgent = composeSystemPrompt({
    mode: 'create',
    agentMode: true,
    artifactType: 'game',
    engine: 'three',
  });

  it('design-mode agent prompt includes the first-line filter', () => {
    expect(designAgent).toContain('First-line filter');
    expect(designAgent).toContain('Now ');
    expect(designAgent).toContain('Next,');
    expect(designAgent).toContain('Let me ');
    expect(designAgent).toContain('Still clean');
  });

  it('game-mode agent prompt includes the first-line filter', () => {
    expect(gameAgent).toContain('First-line filter');
    expect(gameAgent).toContain('Now I will');
    expect(gameAgent).toContain('Now find');
    expect(gameAgent).toContain('Now replace');
    expect(gameAgent).toContain('Continuing —');
  });

  it('game-mode agent prompt cites the FPS-run regression cases verbatim', () => {
    expect(gameAgent).toContain('FPS-run regression cases');
    expect(gameAgent).toContain('design ba2adf62 session 7');
    expect(gameAgent).toContain('Now replace the `_updateDeath` method:');
    expect(gameAgent).toContain('Now find and replace the bright-extract shader');
    expect(gameAgent).toContain('All warnings are intentional game design decisions:');
    expect(gameAgent).toContain('Still clean. Continuing — finding the `shoot()`');
  });

  it('design-mode agent prompt names the reasoning pill so the model knows narration is doubly redundant', () => {
    expect(designAgent).toContain('Reasoned for Ns');
  });

  it('game-mode agent prompt names the reasoning pill', () => {
    expect(gameAgent).toMatch(/Reasoned for \d+s/);
  });
});

describe('Phase 2 — banned-prelude detection (renderer fallback contract)', () => {
  // Mirrors the renderer's `isInterToolNarration` first-line filter — any
  // assistant_text starting with one of these tokens is dropped client-side
  // when followed by a tool_call. The model should never emit them, but the
  // renderer is the safety net.
  const BANNED_PREFIXES = [
    'Now ',
    'Now I will ',
    "Now I'll ",
    'Now let me ',
    'Now find ',
    'Now replace ',
    'Now add ',
    'Next, ',
    "Next I'll ",
    'Let me ',
    "I'll ",
    'I will ',
    'Good, ',
    'Great, ',
    'OK, ',
    'Still clean. ',
    'Continuing — ',
  ];

  it('every banned prefix appears at least once in the strengthened game prompt', () => {
    const gameAgent = composeSystemPrompt({
      mode: 'create',
      agentMode: true,
      artifactType: 'game',
      engine: 'three',
    });
    for (const prefix of BANNED_PREFIXES) {
      expect(gameAgent, `prompt should reference the banned prefix "${prefix}"`).toContain(
        prefix.trim(),
      );
    }
  });
});
