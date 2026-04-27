import { describe, expect, it } from 'vitest';
import { resolveUseAgentRuntime } from './runtime-flag';

describe('resolveUseAgentRuntime', () => {
  it('defaults to true when env var is unset', () => {
    expect(resolveUseAgentRuntime(undefined)).toBe(true);
  });

  it('defaults to true on empty string (treat as unset, not opt-out)', () => {
    expect(resolveUseAgentRuntime('')).toBe(true);
  });

  it('opts out on the literal "0"', () => {
    expect(resolveUseAgentRuntime('0')).toBe(false);
  });

  it('opts out on the literal "false"', () => {
    expect(resolveUseAgentRuntime('false')).toBe(false);
  });

  it('opts in on any other truthy-looking value', () => {
    expect(resolveUseAgentRuntime('1')).toBe(true);
    expect(resolveUseAgentRuntime('true')).toBe(true);
    expect(resolveUseAgentRuntime('yes')).toBe(true);
    // Defensive: unknown values default to ON, matching the new default.
    expect(resolveUseAgentRuntime('whatever')).toBe(true);
  });

  it('does NOT opt out on case variants of "false" / "0" (strict literals only)', () => {
    expect(resolveUseAgentRuntime('FALSE')).toBe(true);
    expect(resolveUseAgentRuntime('False')).toBe(true);
    expect(resolveUseAgentRuntime(' 0')).toBe(true);
  });
});
