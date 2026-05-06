/**
 * Phase 5 — status-page check. When a run hits its third overload retry,
 * fetch Anthropic's public status JSON to surface the live status to the
 * user instead of silently re-retrying. Graceful degradation: any
 * timeout, network error, or non-OK response returns
 * `{ unknown: true }` and the caller falls back to "still retrying".
 *
 * Per the Phase 7 ambition guardrails, this never throws — telemetry
 * must not break the run. The function takes an injected fetch so tests
 * can drive it without network access.
 */

export type StatusIndicator = 'none' | 'minor' | 'major' | 'critical' | 'unknown';

export interface StatusReport {
  indicator: StatusIndicator;
  /** Human-readable description, when available. Empty string when
   *  unknown / unparseable. */
  description: string;
  /** True when the check could not produce a definitive answer (network
   *  failure, timeout, etc.). The caller decides how to surface this. */
  unknown: boolean;
}

/** Default Anthropic status URL. Caller can override for testing or to
 *  point at a different provider's status page. */
export const ANTHROPIC_STATUS_URL = 'https://status.anthropic.com/api/v2/status.json';

export interface CheckStatusOptions {
  url?: string;
  timeoutMs?: number;
  /** Fetch implementation. Defaults to `globalThis.fetch`. Tests inject. */
  fetchImpl?: typeof fetch;
}

export async function checkStatusPage(options: CheckStatusOptions = {}): Promise<StatusReport> {
  const url = options.url ?? ANTHROPIC_STATUS_URL;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      return { indicator: 'unknown', description: '', unknown: true };
    }
    const body = (await res.json().catch(() => null)) as {
      status?: { indicator?: string; description?: string };
    } | null;
    const ind = body?.status?.indicator;
    const description =
      typeof body?.status?.description === 'string' ? body.status.description : '';
    if (ind === 'none' || ind === 'minor' || ind === 'major' || ind === 'critical') {
      return { indicator: ind, description, unknown: false };
    }
    return { indicator: 'unknown', description, unknown: true };
  } catch {
    return { indicator: 'unknown', description: '', unknown: true };
  } finally {
    clearTimeout(timer);
  }
}
