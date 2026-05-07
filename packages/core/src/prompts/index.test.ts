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
