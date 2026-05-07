import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, formatPromptAssistConstraints } from './index.js';

describe('composeSystemPrompt — mobile-flow keyword routing (backlog-2 #6)', () => {
  it('routes the mobile-flow template into the prompt for mobile keywords', () => {
    const out = composeSystemPrompt({
      mode: 'create',
      userPrompt: 'Create a mobile 5 screen flow for e-learning purposes',
    });
    expect(out).toContain('Mobile flow scaffolding');
    expect(out).toContain('TabBar pattern');
    expect(out).toContain('Screen routing (no router library)');
    expect(out).toContain('Quiz scaffolding');
  });

  it('skips the mobile-flow template for non-mobile keywords', () => {
    const out = composeSystemPrompt({
      mode: 'create',
      userPrompt: 'Design a B2B pricing page with three tiers',
    });
    expect(out).not.toContain('Mobile flow scaffolding');
    expect(out).not.toContain('Screen routing (no router library)');
  });

  it('does NOT inject mobile-flow on revise mode (refinement turns)', () => {
    const out = composeSystemPrompt({ mode: 'revise' });
    expect(out).not.toContain('Mobile flow scaffolding');
  });
});

describe('composeSystemPrompt — anti-slop sections (backlog-2 #4)', () => {
  it('full anti-slop on revise mode contains the new Touch targets section', () => {
    const out = composeSystemPrompt({ mode: 'revise' });
    expect(out).toContain('## Touch targets');
    expect(out).toMatch(/Tap target ≥ 44 × 44 px/);
    expect(out).toMatch(/Min 8 px gap/);
  });

  it('full anti-slop on revise mode contains the new Iconography section', () => {
    const out = composeSystemPrompt({ mode: 'revise' });
    expect(out).toContain('## Iconography');
    expect(out).toMatch(/never substitute an emoji for an icon/);
    expect(out).toMatch(/lucide-react/);
  });

  it('digest used by progressive-disclosure callouts the icon-set rule prominently', () => {
    // Progressive mode renders the digest, not the full anti-slop block.
    const out = composeSystemPrompt({ mode: 'create', userPrompt: 'short prompt' });
    expect(out).toMatch(/icon set is in scope/);
    expect(out).toMatch(/sub-44 px touch targets/);
  });
});

describe('formatPromptAssistConstraints', () => {
  it('returns null when no metadata is provided', () => {
    expect(formatPromptAssistConstraints(undefined)).toBeNull();
  });

  it('returns null when every field is undefined', () => {
    expect(formatPromptAssistConstraints({})).toBeNull();
  });

  it('emits only the fields that were provided', () => {
    const out = formatPromptAssistConstraints({
      audience: 'devs',
      device: 'mobile',
      depth: 'deep',
    });
    expect(out).toContain('<audience>devs</audience>');
    expect(out).toContain('<device>mobile</device>');
    expect(out).toContain('<depth>deep</depth>');
    expect(out).not.toContain('<vibe>');
    expect(out).not.toContain('<a11y-target>');
  });

  it('wraps the fields in a structured constraints block, not free text', () => {
    const out = formatPromptAssistConstraints({ audience: 'pm', a11y: 'enhanced' }) ?? '';
    expect(out).toContain('<design-constraints>');
    expect(out).toContain('</design-constraints>');
    expect(out).toContain('# Design constraints');
  });
});

describe('composeSystemPrompt — promptAssist injection (backlog-1 #9)', () => {
  it('appends the constraints block when promptAssist is provided', () => {
    const prompt = composeSystemPrompt({
      mode: 'create',
      userPrompt: 'short prompt',
      promptAssist: { audience: 'designers', vibe: 'minimal' },
    });
    expect(prompt).toContain('<design-constraints>');
    expect(prompt).toContain('<audience>designers</audience>');
    expect(prompt).toContain('<vibe>minimal</vibe>');
  });

  it('omits the constraints block when no promptAssist is provided', () => {
    const prompt = composeSystemPrompt({ mode: 'create', userPrompt: 'short prompt' });
    expect(prompt).not.toContain('<design-constraints>');
  });

  it('omits the constraints block when promptAssist is empty', () => {
    const prompt = composeSystemPrompt({
      mode: 'create',
      userPrompt: 'short prompt',
      promptAssist: {},
    });
    expect(prompt).not.toContain('<design-constraints>');
  });

  it('also injects on revise mode (refinement turns inherit constraints)', () => {
    const prompt = composeSystemPrompt({
      mode: 'revise',
      promptAssist: { device: 'mobile' },
    });
    expect(prompt).toContain('<device>mobile</device>');
  });
});

describe('AGENT_WORKFLOW conversation-mode scoping (plan 2026-05-08 P1)', () => {
  // The 2026-05-07 trace showed the model second-guessing itself on chat
  // follow-ups ("I must call a tool — wait, no, I can reply with prose").
  // Root cause: AGENT_WORKFLOW had unconditional "no assistant text" rules
  // that didn't carve out conversational follow-ups. These tests lock the
  // fix in: the prompt scopes the rules to active build runs and adds a
  // Conversation mode section that explicitly permits plain text.
  it('scopes the no-assistant-text rule to active artifact runs', () => {
    const out = composeSystemPrompt({ mode: 'create', agentMode: true });
    // Phase 1 wording — the rule applies between the first set_todos of a
    // run and the matching `done` call, NOT to every assistant turn.
    expect(out).toMatch(/between the first `set_todos`[\s\S]*and[\s\S]*`done`/i);
  });

  it('does NOT contain the unscoped "assistant text is not rendered" phrasing', () => {
    const out = composeSystemPrompt({ mode: 'create', agentMode: true });
    // The old line falsely claimed assistant text was unrendered. Removing
    // it (or rephrasing) is the load-bearing fix — leaving the absolute
    // wording in place re-introduces the second-guessing behavior.
    expect(out).not.toContain('assistant text is not rendered to the user');
  });

  it('contains an explicit Conversation mode carve-out section', () => {
    const out = composeSystemPrompt({ mode: 'create', agentMode: true });
    expect(out).toContain('## Conversation mode');
    // Section must clearly grant permission to reply with plain text for
    // non-build follow-ups; otherwise the carve-out is just decoration.
    expect(out).toMatch(/reply (?:as|with) plain (?:assistant )?text/i);
  });

  it('keeps the in-build no-text rule intact (still a hard rule during builds)', () => {
    const out = composeSystemPrompt({ mode: 'create', agentMode: true });
    // The fix scopes, it doesn't remove. Mid-build prose is still banned.
    expect(out).toMatch(/no assistant text|emit no assistant text|do not emit assistant text/i);
  });
});

describe('composeSystemPrompt — motion-mode (motion-graphics-plan §3)', () => {
  it('composes the motion-builder layered prompt when artifactType=motion', () => {
    const out = composeSystemPrompt({ mode: 'create', artifactType: 'motion' });
    expect(out).toContain('Motion graphics workflow');
    expect(out).toContain('Remotion composition guide');
    expect(out).toContain('Motion anti-slop');
    // Motion is React-via-Remotion — design-mode workflow is excluded.
    expect(out).not.toContain('# Design workflow');
  });

  it('surfaces a style pin preamble when motionStyle is set', () => {
    const out = composeSystemPrompt({
      mode: 'create',
      artifactType: 'motion',
      motionStyle: 'kinetic-text',
    });
    expect(out).toContain('Motion style pin');
    expect(out).toContain('`kinetic-text`');
  });

  it('omits the style pin preamble when motionStyle is undefined', () => {
    const out = composeSystemPrompt({ mode: 'create', artifactType: 'motion' });
    expect(out).not.toContain('Motion style pin');
  });
});
