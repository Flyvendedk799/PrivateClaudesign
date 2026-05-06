/**
 * Phase 5 — `checkStatusPage` is the third-overload-retry escalation:
 * surface live Anthropic status so the user sees "Anthropic reports a
 * major incident" instead of just "still retrying". Must NEVER throw —
 * graceful degradation to `{ unknown: true }` is the contract.
 */

import { describe, expect, it, vi } from 'vitest';
import { checkStatusPage } from './status-page';

const okResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

describe('checkStatusPage (Phase 5)', () => {
  it('returns the indicator + description on a healthy fetch', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ status: { indicator: 'major', description: 'Elevated error rates' } }),
    ) as unknown as typeof fetch;
    const report = await checkStatusPage({ fetchImpl });
    expect(report).toEqual({
      indicator: 'major',
      description: 'Elevated error rates',
      unknown: false,
    });
  });

  it('every documented indicator round-trips', async () => {
    for (const ind of ['none', 'minor', 'major', 'critical'] as const) {
      const fetchImpl = vi.fn(async () =>
        okResponse({ status: { indicator: ind, description: 'x' } }),
      ) as unknown as typeof fetch;
      const r = await checkStatusPage({ fetchImpl });
      expect(r.indicator).toBe(ind);
      expect(r.unknown).toBe(false);
    }
  });

  it('unknown indicator → unknown:true (no fabrication of confidence)', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ status: { indicator: 'something-else', description: 'x' } }),
    ) as unknown as typeof fetch;
    const r = await checkStatusPage({ fetchImpl });
    expect(r.unknown).toBe(true);
    expect(r.indicator).toBe('unknown');
  });

  it('non-OK HTTP response → unknown', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
    ) as unknown as typeof fetch;
    const r = await checkStatusPage({ fetchImpl });
    expect(r.unknown).toBe(true);
  });

  it('network failure → unknown (no thrown exception)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENETDOWN');
    }) as unknown as typeof fetch;
    const r = await checkStatusPage({ fetchImpl });
    expect(r.unknown).toBe(true);
  });

  it('malformed JSON → unknown (no thrown exception)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new Error('parse fail');
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const r = await checkStatusPage({ fetchImpl });
    expect(r.unknown).toBe(true);
  });

  it('honours the timeout — abort after the configured ms', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;
    const r = await checkStatusPage({ fetchImpl, timeoutMs: 5 });
    expect(r.unknown).toBe(true);
  });
});
