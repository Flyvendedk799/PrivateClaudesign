import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from './index.js';

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
