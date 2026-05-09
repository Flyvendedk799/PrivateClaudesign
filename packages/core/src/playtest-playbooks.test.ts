/**
 * may9 Phase 9 — playtest playbook lookup tests.
 */
import { describe, expect, it } from 'vitest';
import { getPlaytestPlaybook, listSupportedGenres } from './playtest-playbooks';

describe('getPlaytestPlaybook', () => {
  it('returns the brawler playbook with the expected guard against c44763af sign error', () => {
    const pb = getPlaytestPlaybook('fighting');
    expect(pb).not.toBeNull();
    expect(pb?.genre).toBe('fighting');
    expect(pb?.steps.length).toBeGreaterThan(0);
    expect(pb?.watchFor.join(' ')).toMatch(/sign-error|reversed/i);
  });

  it('returns the FPS playbook with pointer-lock cooldown advice', () => {
    const pb = getPlaytestPlaybook('fps');
    expect(pb).not.toBeNull();
    expect(pb?.watchFor.join(' ').toLowerCase()).toContain('pointer-lock');
  });

  it('returns null for an un-bundled genre', () => {
    const pb = getPlaytestPlaybook('idle');
    expect(pb).toBeNull();
  });

  it('listSupportedGenres includes the 6 bundled cases', () => {
    const genres = listSupportedGenres();
    expect(genres).toContain('platformer');
    expect(genres).toContain('fighting');
    expect(genres).toContain('fps');
    expect(genres).toContain('puzzle');
    expect(genres).toContain('topdown_arcade');
    expect(genres).toContain('runner');
  });
});
