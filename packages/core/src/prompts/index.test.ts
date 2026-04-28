import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from './index.js';

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
