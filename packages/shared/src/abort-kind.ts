/**
 * may9 Phase 7 — single-source abort classifier.
 *
 * Maps an error message (or a CodesignError's `.message`) to a stable
 * AbortKind enum. Used by:
 *   - apps/desktop/src/main when writing `run_usage.abort_kind` (Phase 0
 *     column added a place to put this; this file decides what to write)
 *   - the renderer's ChatMessageList when picking error-pill semantics
 *     (Phase 7 D9: `paused_at_safe_boundary` is neutral, not red)
 *   - the eval baseline report (scripts/eval-baseline.ts) when grouping
 *     errors by classification — the inline `classifyError` there is
 *     superseded by this module
 *
 * The list is intentionally small and grows only with empirical error
 * shapes the user sees in production. Keep enum strings stable; the
 * `abort_kind` column persists them and breaking the values would
 * orphan historical rows.
 */

/** Discrete classes of "the run did not complete cleanly". */
export type AbortKind =
  /** Continuation safe-boundary pause. The run committed its turn and
   *  parked; the user resumes via the Continue button. NOT an error. */
  | 'paused_safe_boundary'
  /** Provider returned 5xx Overloaded (Anthropic). Transient — caller
   *  retries with backoff. */
  | 'overloaded'
  /** Anthropic OAuth (Claude Code) token expired AND the refresh
   *  prerequisites were missing. User must re-import. */
  | 'oauth_expired'
  /** Model stream cut off mid-turn (network or provider hiccup). The
   *  abort-handling path writes a continuation_pending row so the user
   *  can resume. */
  | 'stream_interrupted'
  /** User-initiated abort (Stop button). */
  | 'user_aborted'
  /** Local model misconfig (Ollama, llama.cpp) — wrong model id. */
  | 'local_model_missing'
  /** Provider auth failed at request build time (no key in keychain). */
  | 'provider_auth_missing'
  /** Tool-call budget exceeded (runaway loop). Hard-fail. */
  | 'tool_budget_exceeded'
  /** Wall-clock budget exceeded (chunk timeout). Soft-fail; usually
   *  paired with continuation_pending. */
  | 'wall_clock'
  /** Anything else. */
  | 'other';

/** Map an error message string (or a partial CodesignError) to a
 *  stable AbortKind. The function is intentionally string-pattern based
 *  — ergonomic to extend, easy to test, and the canonical strings stay
 *  in one place.
 *
 *  Pass either the error message verbatim (preferred) or the full
 *  serialized JSON the renderer stores in chat_messages.payload (the
 *  function looks for substring matches so JSON-wrapped strings work).
 */
export function classifyAbortKind(message: string | null | undefined): AbortKind {
  if (typeof message !== 'string' || message.length === 0) return 'other';
  // Cheaper than splitting + checking each token. Order matters where a
  // single message could match more than one (e.g. "stream interrupted"
  // also contains "interrupted"); place the more specific clause first.
  if (message.includes('Paused at safe boundary')) return 'paused_safe_boundary';
  if (message.includes('overloaded_error') || message.includes('Overloaded')) return 'overloaded';
  if (message.includes('token has expired') || message.includes('PROVIDER_AUTH_EXPIRED'))
    return 'oauth_expired';
  if (message.includes('PROVIDER_AUTH_MISSING') || message.includes('No API key'))
    return 'provider_auth_missing';
  if (message.includes('stream was interrupted') || message.includes('STREAM_INTERRUPTED'))
    return 'stream_interrupted';
  if (
    message.includes('Request was aborted') ||
    message.includes('User aborted') ||
    message.includes('AbortError')
  )
    return 'user_aborted';
  if (message.includes('AGENT_BUDGET_EXCEEDED') || message.includes('tool_calls'))
    return 'tool_budget_exceeded';
  if (message.includes('wall_clock') || message.includes('Wall clock')) return 'wall_clock';
  if (
    message.includes("model '") &&
    message.includes("' not found") // e.g. "404 model 'llama3.2' not found"
  )
    return 'local_model_missing';
  return 'other';
}

/** Whether a given AbortKind should be rendered as a *neutral* affordance
 *  (info color, no red) instead of an error pill. Used by the renderer
 *  to decide pill color when the row already shipped as kind='error'. */
export function isNeutralAbort(kind: AbortKind): boolean {
  return kind === 'paused_safe_boundary' || kind === 'wall_clock';
}

/** Whether a given AbortKind warrants suggesting an OAuth re-import to
 *  the user (D8). Drives the inline "Re-import token" affordance on the
 *  error row + the proactive pre-flight banner. */
export function suggestsTokenReimport(kind: AbortKind): boolean {
  return kind === 'oauth_expired';
}
