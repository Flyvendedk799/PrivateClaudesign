/**
 * read_url — fetch a URL and return a stripped-text excerpt the model can
 * use to inform the design. This is a deliberate lightweight implementation:
 * no headless browser, no JS execution, just HTML → plain text with a
 * length cap. The model doesn't need pixel-perfect DOM; it needs copy +
 * structure hints.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import { Type } from '@sinclair/typebox';

const ReadUrlParams = Type.Object({
  url: Type.String(),
  maxChars: Type.Optional(Type.Number()),
});

export interface ReadUrlDetails {
  url: string;
  status: number;
  charsReturned: number;
  truncated: boolean;
}

/** Hard cap on time spent waiting for response headers. A stalled origin
 *  must not wedge a generation. */
export const READ_URL_NETWORK_TIMEOUT_MS = 15_000;
/** Hard cap on time spent draining the response body once headers are in.
 *  Pathological chunked responses still need an upper bound. */
export const READ_URL_BODY_TIMEOUT_MS = 5_000;

export function stripHtmlToText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      // Preserve paragraph/heading breaks as newlines so the model can see
      // structure without real block-level markup.
      .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|br)\s*>/gi, '\n')
      .replace(/<br\s*\/?>(?!\n)/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => s !== undefined);
  if (filtered.length === 1) {
    const only = filtered[0];
    if (only) return only;
  }
  // AbortSignal.any is Node 22+ (the project baseline per .nvmrc / engines).
  return AbortSignal.any(filtered);
}

function isAbortFromTimeout(err: unknown, timeoutSignal: AbortSignal): boolean {
  if (timeoutSignal.aborted) return true;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    // The DOM AbortError carries no clue about which signal aborted it, but if
    // the timeout signal is in the abort path it will have flipped by now.
    return timeoutSignal.aborted;
  }
  return false;
}

export function makeReadUrlTool(): AgentTool<typeof ReadUrlParams, ReadUrlDetails> {
  return {
    name: 'read_url',
    label: 'Read URL',
    description: `Fetch a public URL and return its visible text (stripped of HTML, scripts, styles). Use this to pull copy/facts from a reference URL the user supplied. Output is capped at maxChars (default 4000). The host bounds the network read at ${READ_URL_NETWORK_TIMEOUT_MS / 1000}s and the body drain at ${READ_URL_BODY_TIMEOUT_MS / 1000}s — a slow URL cannot wedge the run.`,
    parameters: ReadUrlParams,
    async execute(_id, params, signal): Promise<AgentToolResult<ReadUrlDetails>> {
      const max = params.maxChars ?? 4000;
      const networkTimeout = AbortSignal.timeout(READ_URL_NETWORK_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(params.url, {
          signal: combineSignals(signal, networkTimeout),
          headers: {
            'user-agent': 'open-codesign/0.1 (+https://github.com/hqhq1025/codesign)',
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          },
        });
      } catch (err) {
        if (isAbortFromTimeout(err, networkTimeout)) {
          throw new CodesignError(
            `read_url network timeout after ${READ_URL_NETWORK_TIMEOUT_MS / 1000}s for ${params.url}`,
            ERROR_CODES.REFERENCE_URL_FETCH_TIMEOUT,
            { cause: err instanceof Error ? err : new Error(String(err)) },
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Network request failed: ${msg}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${params.url}`);
      }
      const bodyTimeout = AbortSignal.timeout(READ_URL_BODY_TIMEOUT_MS);
      // Race res.text() against the body timeout. If the body signal fires we
      // proactively cancel the underlying stream so the socket releases — `res`
      // itself does not honour the original signal once headers are in.
      let body: string;
      try {
        body = await new Promise<string>((resolve, reject) => {
          const onAbort = () => {
            try {
              res.body?.cancel().catch(() => {});
            } catch {
              // ignore — best-effort cancel; promise rejects below
            }
            reject(new DOMException('Body read aborted', 'AbortError'));
          };
          if (bodyTimeout.aborted) {
            onAbort();
            return;
          }
          bodyTimeout.addEventListener('abort', onAbort, { once: true });
          res
            .text()
            .then((txt) => {
              bodyTimeout.removeEventListener('abort', onAbort);
              resolve(txt);
            })
            .catch((err) => {
              bodyTimeout.removeEventListener('abort', onAbort);
              reject(err);
            });
        });
      } catch (err) {
        if (isAbortFromTimeout(err, bodyTimeout)) {
          throw new CodesignError(
            `read_url body read timeout after ${READ_URL_BODY_TIMEOUT_MS / 1000}s for ${params.url}`,
            ERROR_CODES.REFERENCE_URL_FETCH_TIMEOUT,
            { cause: err instanceof Error ? err : new Error(String(err)) },
          );
        }
        throw err;
      }
      const text = stripHtmlToText(body);
      const truncated = text.length > max;
      const out = truncated ? `${text.slice(0, max)}\n\n[…truncated at ${max} chars]` : text;
      return {
        content: [{ type: 'text', text: out }],
        details: {
          url: params.url,
          status: res.status,
          charsReturned: out.length,
          truncated,
        },
      };
    },
  };
}
