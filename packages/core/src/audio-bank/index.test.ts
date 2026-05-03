/**
 * gameplan §E1 — audio bank retrieval tests.
 */

import { describe, expect, it } from 'vitest';
import {
  type AudioBankManifest,
  loadAudioBankManifest,
  pickBestMatch,
  scoreEntry,
  tokenize,
} from './index';

const FIXTURE: AudioBankManifest = {
  schemaVersion: 1,
  entries: [
    {
      id: 'click',
      purpose: 'sfx',
      path: 'sfx/click.wav',
      mimeType: 'audio/wav',
      label: 'UI click',
      license: 'CC0',
      keywords: ['click', 'tap', 'button', 'ui', 'press'],
    },
    {
      id: 'coin',
      purpose: 'sfx',
      path: 'sfx/coin.wav',
      mimeType: 'audio/wav',
      label: 'Coin',
      license: 'CC0',
      keywords: ['coin', 'pickup', 'collect', 'gem', 'score'],
    },
    {
      id: 'ambient',
      purpose: 'music',
      path: 'music/ambient.wav',
      mimeType: 'audio/wav',
      label: 'Ambient loop',
      license: 'CC0',
      keywords: ['ambient', 'loop', 'background', 'pad', 'calm'],
    },
  ],
};

describe('tokenize', () => {
  it('lowercases, strips punctuation, drops short stop words', () => {
    expect(tokenize('A satisfying COIN pickup, please!')).toEqual([
      'satisfying',
      'coin',
      'pickup',
      'please',
    ]);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('scoreEntry', () => {
  it('scores by token-overlap with substring match', () => {
    const tokens = tokenize('button click for the menu');
    const click = FIXTURE.entries[0];
    if (!click) throw new Error('fixture missing entry');
    // 'button', 'click', 'menu' are all in keywords or substring-matched
    expect(scoreEntry(tokens, click)).toBeGreaterThanOrEqual(2);
  });

  it('returns 0 for completely unrelated prompts', () => {
    const tokens = tokenize('sword swing parry');
    const click = FIXTURE.entries[0];
    if (!click) throw new Error('fixture missing entry');
    expect(scoreEntry(tokens, click)).toBe(0);
  });

  it('matches plurals via substring (footstep ↔ footsteps)', () => {
    const entry = {
      id: 'footstep',
      purpose: 'sfx' as const,
      path: 'sfx/footstep.wav',
      mimeType: 'audio/wav',
      label: 'Footstep',
      license: 'CC0',
      keywords: ['footsteps', 'walk', 'tread'],
    };
    const tokens = tokenize('footstep on gravel');
    expect(scoreEntry(tokens, entry)).toBe(1);
  });
});

describe('pickBestMatch', () => {
  it('returns the highest-scoring entry within the requested purpose', () => {
    const match = pickBestMatch(FIXTURE, 'sfx', 'pick up a shiny gem coin');
    expect(match?.entry.id).toBe('coin');
  });

  it('respects purpose scoping (no music entries when purpose=sfx)', () => {
    const match = pickBestMatch(FIXTURE, 'music', 'a calm background pad for the menu');
    expect(match?.entry.id).toBe('ambient');
  });

  it('returns null when no entries of the requested purpose exist', () => {
    expect(pickBestMatch(FIXTURE, 'voice', 'announce game over')).toBeNull();
  });

  it('falls back deterministically when scores tie (longest first-keyword wins)', () => {
    // Both entries score 0 against this prompt. Tie-break = longest first
    // keyword. 'ambient' has keywords[0]='ambient' (7) vs 'click' (5).
    // But pickBestMatch only considers entries of the requested purpose,
    // so we test with two same-purpose entries explicitly.
    const tied: AudioBankManifest = {
      schemaVersion: 1,
      entries: [
        {
          id: 'short',
          purpose: 'sfx',
          path: 'a.wav',
          mimeType: 'audio/wav',
          label: 'a',
          license: 'CC0',
          keywords: ['ax'],
        },
        {
          id: 'long',
          purpose: 'sfx',
          path: 'b.wav',
          mimeType: 'audio/wav',
          label: 'b',
          license: 'CC0',
          keywords: ['axisymmetric'],
        },
      ],
    };
    const match = pickBestMatch(tied, 'sfx', 'something completely unrelated');
    expect(match?.entry.id).toBe('long');
  });
});

describe('loadAudioBankManifest (real bundle)', () => {
  it('loads + parses the committed manifest.json', async () => {
    const manifest = await loadAudioBankManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entries.length).toBeGreaterThan(0);
    for (const entry of manifest.entries) {
      expect(entry.id).toMatch(/^[a-z0-9_]+$/);
      expect(['sfx', 'music', 'voice']).toContain(entry.purpose);
      expect(entry.keywords.length).toBeGreaterThan(0);
      expect(entry.path).toMatch(/\.(wav|ogg|mp3)$/);
    }
  });

  it('every manifest entry references a file that actually exists', async () => {
    const { existsSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = await loadAudioBankManifest();
    for (const entry of manifest.entries) {
      const onDisk = join(here, entry.path);
      expect(existsSync(onDisk), `Expected ${entry.path} to exist on disk`).toBe(true);
    }
  });
});
