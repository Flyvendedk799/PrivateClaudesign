import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, formatPromptAssistConstraints } from './index.js';

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
