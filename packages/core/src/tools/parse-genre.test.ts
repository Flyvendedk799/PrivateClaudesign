import { describe, expect, it } from 'vitest';
import { parseGenreFromTranscript } from './assert-game-invariants.js';

describe('parseGenreFromTranscript', () => {
  it('extracts a Genre token from the canonical Mechanic spec block', () => {
    const text = `
      Genre: brawler
      Reference: Hades top-down brawler
      Camera: 3rd-person-follow
      Inputs: Z = Jab; X = Cross
      Win: clear all waves
      Lose: hp <= 0
    `;
    expect(parseGenreFromTranscript(text)).toBe('brawler');
  });

  it('returns null when no Genre line is present', () => {
    expect(parseGenreFromTranscript('A long deliverable summary here.')).toBeNull();
  });

  it('returns null on unknown genre tokens (avoids leaking arbitrary user input)', () => {
    expect(parseGenreFromTranscript('Genre: kart-game')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(parseGenreFromTranscript('GENRE: SHOOTER')).toBe('shooter');
  });

  it('handles compound genres with hyphens (tower-defense)', () => {
    expect(parseGenreFromTranscript('Genre: tower-defense')).toBe('tower-defense');
  });
});
