/**
 * Integration C — singleton AuthRefreshQueue wrapping the
 * `ensureFreshClaudeCodeToken` proactive refresh path.
 *
 * Lifecycle hooks fire IPC events so the renderer can surface a
 * "Refreshing Claude Code credential…" toast (start), dismiss it on
 * success, and route to the existing "Re-import" CTA on failure. Per
 * the Phase 7 ambition guardrail, this never silently drops the user's
 * prompt — failure rejects loudly with the existing
 * CLAUDE_CODE_REIMPORT_REQUIRED error so the renderer's existing handler
 * picks it up.
 *
 * The queue's concurrency-coalescing is the load-bearing benefit even
 * though `ensureFreshClaudeCodeToken` already has internal dedup in
 * `refreshClaudeCodeToken`: the queue lifts that dedup ABOVE the IPC
 * event emit so two concurrent generates only see ONE "Refreshing…"
 * toast, not two stacked ones.
 */

import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { AuthRefreshQueue, type RefreshOutcome } from './auth-refresh-queue';
import { ensureFreshClaudeCodeToken } from './claude-code-token-refresh';
import { getLogger } from './logger';

const log = getLogger('claude-code-refresh-queue');

const CLAUDE_CODE_PROVIDER_ID = 'claude-code-imported';

let mainWindowRef: ElectronBrowserWindow | null = null;
export function setRefreshQueueWindow(win: ElectronBrowserWindow | null): void {
  mainWindowRef = win;
}

function emit(channel: string, payload: Record<string, unknown> = {}): void {
  try {
    mainWindowRef?.webContents.send(channel, { ...payload, ts: Date.now() });
  } catch (err) {
    log.warn('emit.fail', {
      channel,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The most recent refresh failure, captured at refresh-callback time so
 *  queued dispatchers can re-throw with the original CodesignError shape
 *  the renderer's diagnostic pipeline already understands. */
let lastRefreshError: unknown = null;

const queue = new AuthRefreshQueue<unknown, void>({
  refresh: async (): Promise<RefreshOutcome> => {
    try {
      lastRefreshError = null;
      await ensureFreshClaudeCodeToken(CLAUDE_CODE_PROVIDER_ID);
      return 'refreshed';
    } catch (err) {
      lastRefreshError = err;
      log.warn('refresh.fail', {
        message: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  },
  onRefreshStarted: () => {
    log.info('refresh.start');
    emit('claude-code-refresh:v1', { phase: 'started' });
  },
  onRefreshSucceeded: () => {
    log.info('refresh.succeeded');
    emit('claude-code-refresh:v1', { phase: 'succeeded' });
  },
  onRefreshFailed: () => {
    log.warn('refresh.failed');
    const message = lastRefreshError instanceof Error ? lastRefreshError.message : 'unknown';
    emit('claude-code-refresh:v1', { phase: 'failed', message });
  },
});

/** Public entry. Routes through the queue so concurrent callers share
 *  one refresh + the renderer sees one toast. On permanent failure
 *  re-throws the ORIGINAL CodesignError captured by the refresh
 *  callback so the renderer's existing CLAUDE_CODE_REIMPORT_REQUIRED
 *  flow surfaces unchanged. No-op for non-claude-code providers. */
export async function queueClaudeCodeRefresh(providerId: string): Promise<void> {
  if (providerId !== CLAUDE_CODE_PROVIDER_ID) {
    // Non-claude-code providers don't go through the queue — refresh is
    // a no-op. Maintain the exact same external contract as the
    // existing direct call so callers can swap in the queue without
    // behaviour change.
    await ensureFreshClaudeCodeToken(providerId);
    return;
  }
  try {
    await queue.queueAfterRefresh(null, async () => {
      // The refresh itself happens inside the queue's `refresh` callback.
      // Dispatch is a noop — the work is already done by the time we
      // reach here. Returning resolves the queued caller's promise.
    });
  } catch (queueErr) {
    // The queue rejects when refresh fails; re-throw the original
    // CodesignError so the renderer maps to the right error code.
    if (lastRefreshError !== null) throw lastRefreshError;
    throw queueErr;
  }
}

/** Test-only: read pending count without draining. */
export function _queuePendingCount(): number {
  return queue.pendingCount();
}
