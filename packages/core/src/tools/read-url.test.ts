/**
 * Coverage for read_url failure modes — pre-#3 the tool had no test file
 * and silently regressed on network/body timeouts, non-2xx, body-cap, and
 * HTML-stripper edge cases.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READ_URL_BODY_TIMEOUT_MS, makeReadUrlTool, stripHtmlToText } from './read-url.js';

const tool = makeReadUrlTool();

async function run(url: string, maxChars?: number) {
  const params = maxChars === undefined ? { url } : { url, maxChars };
  return tool.execute('id', params, undefined);
}

describe('read_url — happy path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('200 OK returns stripped text and details.charsReturned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<p>Hello <b>world</b></p>', { status: 200 })),
    );
    const res = await run('https://example.com');
    expect(res.details.status).toBe(200);
    expect(res.details.truncated).toBe(false);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('Hello world');
    expect(res.details.charsReturned).toBe(text.length);
  });
});

describe('read_url — failure paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rejects with "Network request failed" when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );
    await expect(run('https://example.com')).rejects.toThrow(/Network request failed/);
  });

  it('rejects with HTTP <status> from <url> on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );
    await expect(run('https://example.com')).rejects.toThrow(/HTTP 503 from https:\/\/example.com/);
  });

  it('truncates body and flags truncated=true when over maxChars', async () => {
    const big = 'x'.repeat(5000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(big, { status: 200 })),
    );
    const res = await run('https://example.com', 1000);
    expect(res.details.truncated).toBe(true);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/\[…truncated at 1000 chars\]$/);
  });

  it('throws CodesignError with REFERENCE_URL_FETCH_TIMEOUT on body-drain timeout', async () => {
    // Headers in fast, body never resolves — body timeout fires.
    const slowBody = new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never enqueue/close so res.text() hangs.
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(slowBody, { status: 200 })),
    );
    const exec = run('https://example.com');
    // Body timeout = 5s; advance the test clock past that. AbortSignal.timeout
    // is real-time so we cannot use fake timers — use a real but tiny wait.
    await expect(
      Promise.race([
        exec,
        new Promise((_, reject) =>
          setTimeout(reject, READ_URL_BODY_TIMEOUT_MS + 1000, new Error('test wall-clock guard')),
        ),
      ]),
    ).rejects.toMatchObject({
      code: ERROR_CODES.REFERENCE_URL_FETCH_TIMEOUT,
    });
  }, 10_000);

  it('REFERENCE_URL_FETCH_TIMEOUT errors are CodesignError instances', async () => {
    const slowBody = new ReadableStream<Uint8Array>({ start() {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(slowBody, { status: 200 })),
    );
    try {
      await run('https://example.com');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CodesignError);
    }
  }, 10_000);
});

describe('stripHtmlToText edge cases', () => {
  it('decodes named and numeric entities', () => {
    expect(stripHtmlToText('a&amp;b&lt;c&gt;d&quot;e&#39;f&nbsp;g')).toBe('a&b<c>d"e\'f g');
  });

  it('preserves newlines for block-level tags', () => {
    const html = '<p>one</p><p>two</p>';
    expect(stripHtmlToText(html)).toContain('one');
    expect(stripHtmlToText(html)).toContain('two');
    expect(stripHtmlToText(html).split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('strips <script> and <style> blocks entirely', () => {
    const html = '<style>body{color:red}</style><script>alert(1)</script><p>visible</p>';
    expect(stripHtmlToText(html)).toBe('visible');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(stripHtmlToText('   a    \t   b   ')).toBe('a b');
  });

  it('flattens nested tags into one text run', () => {
    expect(stripHtmlToText('<div><span>hi <strong>there</strong></span></div>')).toContain(
      'hi there',
    );
  });
});
