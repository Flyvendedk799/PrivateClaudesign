import { describe, expect, it } from 'vitest';
import { resolveCachePolicy } from './cache-policy';

describe('resolveCachePolicy', () => {
  it('caches anthropic-messages by default', () => {
    expect(resolveCachePolicy('anthropic-messages')).toBe('short');
  });

  it('uses long Anthropic cache retention for game runs', () => {
    expect(resolveCachePolicy('anthropic-messages', undefined, { artifactType: 'game' })).toBe(
      'long',
    );
  });

  it('does not cache OpenAI-style providers (server-side prefix caching only)', () => {
    expect(resolveCachePolicy('openai-completions')).toBe('none');
    expect(resolveCachePolicy('openai-responses')).toBe('none');
    expect(resolveCachePolicy('google-generative-ai')).toBe('none');
  });

  it('honours explicit override', () => {
    expect(resolveCachePolicy('anthropic-messages', 'none')).toBe('none');
    expect(resolveCachePolicy('openai-completions', 'short')).toBe('short');
    expect(resolveCachePolicy('anthropic-messages', 'long')).toBe('long');
    expect(resolveCachePolicy('anthropic-messages', 'short', { artifactType: 'game' })).toBe(
      'short',
    );
  });
});
