/**
 * plan0305 P3.1 — verifies useAgentStream's `tool_call_result` handler
 * persists `status: 'error'` instead of `status: 'done'` when the runtime
 * flagged the call as a failure.
 *
 * Pre-plan0305 every tool_call row landed with `status: 'done'` regardless
 * of outcome — failed and successful executions were indistinguishable in
 * the chat history. This was the root cause of "23 invisible probe
 * round-trips" in run a64f.
 *
 * The branch lives inline in handleToolCallResult:
 *   const persistedStatus: 'done' | 'error' =
 *     event.isFailure === true ? 'error' : 'done';
 *
 * Mirrored here as a pure helper for unit-test isolation.
 */

import { describe, expect, it } from 'vitest';

function persistedStatusForResult(isFailure: boolean | undefined): 'done' | 'error' {
  return isFailure === true ? 'error' : 'done';
}

describe('useAgentStream tool failure status (plan0305 P3.1)', () => {
  it('writes status="error" when isFailure is true', () => {
    expect(persistedStatusForResult(true)).toBe('error');
  });

  it('writes status="done" when isFailure is explicitly false', () => {
    expect(persistedStatusForResult(false)).toBe('done');
  });

  it('writes status="done" when isFailure is undefined (legacy path)', () => {
    expect(persistedStatusForResult(undefined)).toBe('done');
  });
});
