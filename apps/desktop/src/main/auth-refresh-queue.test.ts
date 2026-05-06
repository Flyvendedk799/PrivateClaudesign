/**
 * Phase 5 — token-refresh queue. Six manual retries on 2026-05-06 17:25
 * are the regression we never want to hit again: the user's prompt sits
 * in the queue while the refresh runs once, and either fires after
 * success or surfaces the re-import flow on permanent failure.
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthRefreshQueue } from './auth-refresh-queue';

describe('AuthRefreshQueue (Phase 5)', () => {
  it('queues a prompt and fires it exactly once after refresh succeeds', async () => {
    const refresh = vi.fn(async () => 'refreshed' as const);
    const dispatch = vi.fn(async (args: { x: number }) => ({ ok: true as const, x: args.x }));
    const queue = new AuthRefreshQueue<{ x: number }, { ok: true; x: number }>({ refresh });

    const result = await queue.queueAfterRefresh({ x: 7 }, dispatch);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, x: 7 });
  });

  it('two concurrent prompts share one refresh and BOTH fire after success', async () => {
    let started = 0;
    const refresh = vi.fn(async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 10));
      return 'refreshed' as const;
    });
    const dispatch = vi.fn(async (args: { x: number }) => args.x * 2);
    const queue = new AuthRefreshQueue<{ x: number }, number>({ refresh });

    const [a, b] = await Promise.all([
      queue.queueAfterRefresh({ x: 1 }, dispatch),
      queue.queueAfterRefresh({ x: 2 }, dispatch),
    ]);
    expect(started).toBe(1); // ONE refresh, not two
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(new Set([a, b])).toEqual(new Set([2, 4]));
  });

  it('refresh failure rejects all queued prompts and fires onRefreshFailed once', async () => {
    const refresh = vi.fn(async () => 'failed' as const);
    const onRefreshFailed = vi.fn();
    const queue = new AuthRefreshQueue<unknown, unknown>({ refresh, onRefreshFailed });
    const dispatch = vi.fn();

    const a = queue.queueAfterRefresh(null, dispatch);
    const b = queue.queueAfterRefresh(null, dispatch);
    await expect(a).rejects.toThrow(/auth refresh failed/);
    await expect(b).rejects.toThrow(/auth refresh failed/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(onRefreshFailed).toHaveBeenCalledTimes(1);
  });

  it('refresh thrown error is treated as permanent failure (rejects, never silently retries)', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('credential file missing');
    });
    const onRefreshFailed = vi.fn();
    const queue = new AuthRefreshQueue<unknown, unknown>({ refresh, onRefreshFailed });
    const dispatch = vi.fn();

    await expect(queue.queueAfterRefresh(null, dispatch)).rejects.toThrow(/auth refresh failed/);
    expect(onRefreshFailed).toHaveBeenCalledTimes(1);
  });

  it('one dispatch failure rejects only that prompt — siblings still get their result', async () => {
    const refresh = vi.fn(async () => 'refreshed' as const);
    const dispatch = vi.fn(async (args: { failMe: boolean }) => {
      if (args.failMe) throw new Error('downstream broke');
      return 'ok';
    });
    const queue = new AuthRefreshQueue<{ failMe: boolean }, string>({ refresh });

    const [a, b] = await Promise.allSettled([
      queue.queueAfterRefresh({ failMe: true }, dispatch),
      queue.queueAfterRefresh({ failMe: false }, dispatch),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
    if (b.status === 'fulfilled') expect(b.value).toBe('ok');
  });

  it('lifecycle callbacks fire in the right order', async () => {
    const order: string[] = [];
    const refresh = vi.fn(async () => 'refreshed' as const);
    const queue = new AuthRefreshQueue<unknown, string>({
      refresh,
      onRefreshStarted: () => order.push('started'),
      onRefreshSucceeded: () => order.push('succeeded'),
      onRefreshFailed: () => order.push('failed'),
    });
    await queue.queueAfterRefresh(null, async () => 'ok');
    expect(order).toEqual(['started', 'succeeded']);
  });
});
