/**
 * Phase 5 — token-refresh queue. When a `sendPrompt` request fails with
 * `auth_expired`, the queue holds the prompt while the OAuth refresh
 * runs in the background; once refresh succeeds the queued prompt fires
 * exactly once (no duplicate dispatches, no loss).
 *
 * This module exposes the *queue mechanics* — the actual refresh call
 * is injected via the `refresh` callback so this is testable without
 * touching real credential stores. The runtime composes it with the
 * existing `claude-code-token-refresh` module.
 *
 * Per the Phase 7 ambition guardrails, this never silently retries on
 * permanent failure: when refresh fails we surface the existing
 * "Re-import in Settings" path through the queue's `onRefreshFailed`
 * callback. The user's prompt stays visible, never lost.
 */

export type RefreshOutcome = 'refreshed' | 'failed';

export interface AuthRefreshQueueOptions {
  /** Async function the queue calls when it owes a refresh. Resolves
   *  to 'refreshed' on success, 'failed' on permanent failure. */
  refresh: () => Promise<RefreshOutcome>;
  /** Called once when a refresh starts so the renderer can show the
   *  "Refreshing Claude Code credential…" toast. */
  onRefreshStarted?: () => void;
  /** Called once when refresh resolves to 'refreshed'. */
  onRefreshSucceeded?: () => void;
  /** Called once when refresh resolves to 'failed'. The renderer surfaces
   *  the existing "Re-import in Settings" path here. */
  onRefreshFailed?: () => void;
}

export interface QueuedPrompt<TArgs, TResult> {
  args: TArgs;
  resolve: (result: TResult) => void;
  reject: (err: unknown) => void;
}

/** A queue scoped to a single underlying credential. Cross-credential
 *  use should construct a queue per credential (rare in this app — one
 *  Claude Code import per user).
 *
 *  Lifecycle invariants (verified by tests):
 *   - Concurrent queueAfterRefresh calls share ONE refresh.
 *   - onRefreshStarted / onRefreshSucceeded / onRefreshFailed each fire
 *     EXACTLY ONCE per refresh cycle, regardless of how many prompts
 *     are queued. We dispatch + drain inside `ensureRefresh` so all
 *     queueAfterRefresh callers observe the same drained outcome.
 */
export class AuthRefreshQueue<TArgs, TResult> {
  private inFlight: Promise<RefreshOutcome> | null = null;
  private readonly pending: QueuedPrompt<TArgs, TResult>[] = [];
  private currentDispatch: ((args: TArgs) => Promise<TResult>) | null = null;
  constructor(private readonly options: AuthRefreshQueueOptions) {}

  /** Queue a prompt to retry after the next successful refresh. The
   *  `dispatch` callback supplied by the FIRST caller of a cycle is the
   *  one used to retry every queued prompt — concurrent callers in the
   *  same cycle should pass equivalent dispatchers (typically the same
   *  closure; the runtime owns one dispatcher per credential). */
  queueAfterRefresh(args: TArgs, dispatch: (args: TArgs) => Promise<TResult>): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      this.pending.push({ args, resolve, reject });
      if (this.currentDispatch === null) this.currentDispatch = dispatch;
      this.ensureRefresh().catch((err) => {
        const drained = this.pending.splice(0, this.pending.length);
        for (const p of drained) p.reject(err);
      });
    });
  }

  /** Test-only: read pending count without draining. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Spawn a refresh if none is in flight; coalesce concurrent callers
   *  onto the same promise so we never run two refreshes in parallel.
   *  The drain + lifecycle-callback firing happens here exactly once
   *  per refresh cycle. */
  private ensureRefresh(): Promise<RefreshOutcome> {
    if (this.inFlight !== null) return this.inFlight;
    this.options.onRefreshStarted?.();
    const p = this.options
      .refresh()
      .catch((): RefreshOutcome => 'failed')
      .then((outcome) => {
        const drained = this.pending.splice(0, this.pending.length);
        const dispatch = this.currentDispatch;
        this.currentDispatch = null;
        this.inFlight = null;
        if (outcome === 'failed') {
          for (const queued of drained) {
            queued.reject(new Error('auth refresh failed — re-import credential in settings'));
          }
          this.options.onRefreshFailed?.();
          return outcome;
        }
        this.options.onRefreshSucceeded?.();
        if (dispatch !== null) {
          for (const queued of drained) {
            void dispatch(queued.args)
              .then((res) => queued.resolve(res))
              .catch((err) => queued.reject(err));
          }
        }
        return outcome;
      });
    this.inFlight = p;
    return p;
  }
}
