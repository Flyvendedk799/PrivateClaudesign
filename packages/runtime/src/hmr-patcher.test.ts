/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HMR_PATCHER_MARKER, HMR_PROTOCOL_VERSION, hmrPatcherScript } from './hmr-patcher';

function loadPatcher(): void {
  const fn = new Function(hmrPatcherScript());
  fn.call(window);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { [HMR_PATCHER_MARKER]?: unknown })[HMR_PATCHER_MARKER];
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('hmr-patcher — Backlog-3 §1', () => {
  it('exports a versioned protocol marker', () => {
    expect(HMR_PROTOCOL_VERSION).toBe(1);
    expect(HMR_PATCHER_MARKER).toMatch(/^__CODESIGN_/);
  });

  it('the patcher script is idempotent (window.__codesign marker)', () => {
    loadPatcher();
    expect((window as { [HMR_PATCHER_MARKER]?: unknown })[HMR_PATCHER_MARKER]).toBe(true);
    // Re-running should be a no-op (the function bails on the marker).
    loadPatcher();
    expect((window as { [HMR_PATCHER_MARKER]?: unknown })[HMR_PATCHER_MARKER]).toBe(true);
  });

  it('CSS patch swaps <style> textContent without re-parsing the document', () => {
    document.head.innerHTML = '<style>.a { color: red; }</style>';
    loadPatcher();
    const styleEl = document.querySelector('style');
    if (styleEl === null) throw new Error('expected <style> element');
    const beforeRef = styleEl;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          __codesign_hmr: true,
          protocolVersion: 1,
          kind: 'css',
          oldStyles: ['.a { color: red; }'],
          newStyles: ['.a { color: blue; }'],
        },
      }),
    );
    expect(styleEl.textContent).toBe('.a { color: blue; }');
    // Same DOM node — no reload.
    expect(document.querySelector('style')).toBe(beforeRef);
  });

  it('CSS patch acks failure when style count mismatches', async () => {
    document.head.innerHTML = '<style>.a {}</style>';
    loadPatcher();
    const acks: Array<{ ok: boolean; kind: string; error?: string }> = [];
    const origParent = window.parent;
    Object.defineProperty(window, 'parent', {
      configurable: true,
      get: () => ({ postMessage: (data: unknown) => acks.push(data as (typeof acks)[0]) }),
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          __codesign_hmr: true,
          protocolVersion: 1,
          kind: 'css',
          oldStyles: ['.a {}', '.b {}'],
          newStyles: ['.a {x}', '.b {x}'],
        },
      }),
    );
    // Each loadPatcher() in earlier tests registered its own listener; we
    // assert the LAST ack rather than the count.
    const last = acks[acks.length - 1];
    expect(last?.ok).toBe(false);
    expect(last?.error).toMatch(/style count mismatch/);
    Object.defineProperty(window, 'parent', { configurable: true, value: origParent });
  });

  it('protocol version mismatch is rejected', () => {
    loadPatcher();
    const acks: Array<{ ok: boolean }> = [];
    Object.defineProperty(window, 'parent', {
      configurable: true,
      get: () => ({ postMessage: (data: unknown) => acks.push(data as { ok: boolean }) }),
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          __codesign_hmr: true,
          protocolVersion: 999,
          kind: 'css',
          oldStyles: [],
          newStyles: [],
        },
      }),
    );
    expect(acks[0]?.ok).toBe(false);
  });

  it('non-HMR messages are ignored', () => {
    loadPatcher();
    const acks: unknown[] = [];
    Object.defineProperty(window, 'parent', {
      configurable: true,
      get: () => ({ postMessage: (data: unknown) => acks.push(data) }),
    });
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'something_else', kind: 'css' } }),
    );
    expect(acks.length).toBe(0);
  });

  it('JS patch replaces single changed <script> in place', () => {
    document.body.innerHTML =
      '<script data-test="a">window.A = 1;</script>' +
      '<script data-test="b">window.B = 2;</script>';
    loadPatcher();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          __codesign_hmr: true,
          protocolVersion: 1,
          kind: 'js',
          oldScripts: ['window.A = 1;', 'window.B = 2;'],
          newScripts: ['window.A = 1;', 'window.B = 99;'],
        },
      }),
    );
    const scripts = Array.from(document.querySelectorAll('script[data-test]'));
    expect(scripts.length).toBe(2);
    // The replaced script element is a fresh node carrying the new body.
    expect(scripts[1]?.textContent).toBe('window.B = 99;');
  });

  it('JS patch refuses when multiple scripts changed (structural)', () => {
    document.body.innerHTML = '<script>window.A = 1;</script><script>window.B = 2;</script>';
    loadPatcher();
    const acks: Array<{ ok: boolean; error?: string }> = [];
    Object.defineProperty(window, 'parent', {
      configurable: true,
      get: () => ({
        postMessage: (data: unknown) => acks.push(data as { ok: boolean; error?: string }),
      }),
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          __codesign_hmr: true,
          protocolVersion: 1,
          kind: 'js',
          oldScripts: ['window.A = 1;', 'window.B = 2;'],
          newScripts: ['window.A = 99;', 'window.B = 99;'],
        },
      }),
    );
    expect(acks[0]?.ok).toBe(false);
    expect(acks[0]?.error).toMatch(/multiple scripts changed/);
  });
});
