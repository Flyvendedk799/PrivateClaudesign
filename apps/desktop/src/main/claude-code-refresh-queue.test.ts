/**
 * Integration C — singleton AuthRefreshQueue wrapper around
 * `ensureFreshClaudeCodeToken`. Tests verify the queue surface (route,
 * coalesce, surface lifecycle events) without exercising the actual
 * OAuth refresh — that is covered by `claude-code-token-refresh.test`.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the underlying refresh helper BEFORE importing the queue so the
// queue closes over the mock.
const refreshSpy = vi.fn(async (_providerId: string) => {
  /* noop default — tests override per-case */
});
vi.mock('./claude-code-token-refresh', () => ({
  ensureFreshClaudeCodeToken: (providerId: string) => refreshSpy(providerId),
}));

const { queueClaudeCodeRefresh } = await import('./claude-code-refresh-queue');

describe('queueClaudeCodeRefresh — non-claude-code providers', () => {
  it('passes through directly without going through the queue', async () => {
    refreshSpy.mockResolvedValueOnce(undefined);
    await queueClaudeCodeRefresh('anthropic');
    expect(refreshSpy).toHaveBeenLastCalledWith('anthropic');
  });
});

describe('queueClaudeCodeRefresh — claude-code provider', () => {
  it('delegates to ensureFreshClaudeCodeToken on success', async () => {
    refreshSpy.mockReset();
    refreshSpy.mockResolvedValueOnce(undefined);
    await queueClaudeCodeRefresh('claude-code-imported');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenLastCalledWith('claude-code-imported');
  });

  it('rethrows the original error on permanent failure (CodesignError surfaces unchanged)', async () => {
    refreshSpy.mockReset();
    const original = Object.assign(new Error('expired'), {
      code: 'CLAUDE_CODE_REIMPORT_REQUIRED',
    });
    refreshSpy.mockRejectedValueOnce(original);
    await expect(queueClaudeCodeRefresh('claude-code-imported')).rejects.toBe(original);
  });
});
