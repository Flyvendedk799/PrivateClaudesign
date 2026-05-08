/**
 * may9 Phase 7 — abort classifier tests.
 *
 * Drives off the empirical error strings recorded in the FPS Wave
 * Defense run (see evals/baseline-2026-05-09.md) so the categorisation
 * stays honest with what the user actually sees.
 */
import { describe, expect, it } from 'vitest';
import { classifyAbortKind, isNeutralAbort, suggestsTokenReimport } from './abort-kind';

describe('classifyAbortKind', () => {
  it('returns "other" for empty / null', () => {
    expect(classifyAbortKind('')).toBe('other');
    expect(classifyAbortKind(null)).toBe('other');
    expect(classifyAbortKind(undefined)).toBe('other');
  });

  it('classifies the FPS-trace error strings', () => {
    // overloaded — 5 instances in the FPS run
    expect(
      classifyAbortKind(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe('overloaded');

    // oauth_expired — 3 instances
    expect(
      classifyAbortKind(
        'Claude Code token has expired and the local credential store does not have the refresh prerequisites required to renew it. Re-import from Claude Code in Settings.',
      ),
    ).toBe('oauth_expired');

    // ollama / local model misconfig — 1 instance
    expect(classifyAbortKind("404 model 'llama3.2' not found")).toBe('local_model_missing');

    // user aborted — 1 instance
    expect(classifyAbortKind('Request was aborted.')).toBe('user_aborted');

    // stream interrupted — 2 instances
    expect(classifyAbortKind('The model stream was interrupted before completion.')).toBe(
      'stream_interrupted',
    );

    // paused at safe boundary — 1 instance (D9)
    expect(
      classifyAbortKind('Paused at safe boundary (wall_clock) before next turn dispatch.'),
    ).toBe('paused_safe_boundary');
  });

  it('falls back to "other" for unknown shapes', () => {
    expect(classifyAbortKind('Random unknown failure with no signal')).toBe('other');
  });
});

describe('isNeutralAbort', () => {
  it('flags paused_safe_boundary and wall_clock as neutral', () => {
    expect(isNeutralAbort('paused_safe_boundary')).toBe(true);
    expect(isNeutralAbort('wall_clock')).toBe(true);
  });

  it('treats overloaded / oauth_expired / interrupted as real errors', () => {
    expect(isNeutralAbort('overloaded')).toBe(false);
    expect(isNeutralAbort('oauth_expired')).toBe(false);
    expect(isNeutralAbort('stream_interrupted')).toBe(false);
    expect(isNeutralAbort('other')).toBe(false);
  });
});

describe('suggestsTokenReimport', () => {
  it('only fires for oauth_expired', () => {
    expect(suggestsTokenReimport('oauth_expired')).toBe(true);
    expect(suggestsTokenReimport('overloaded')).toBe(false);
    expect(suggestsTokenReimport('user_aborted')).toBe(false);
  });
});
