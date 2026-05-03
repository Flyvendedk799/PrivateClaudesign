import { describe, expect, it, vi } from 'vitest';
import { OVERLAY_SCRIPT } from './overlay';

interface FakeWindow {
  addEventListener: (type: string, fn: unknown, capture?: boolean) => void;
  parent: { postMessage: (msg: unknown, target: string) => void };
  __cs_err?: boolean;
  __cs_rej?: boolean;
  __cs_msg?: boolean;
}

function runOverlay(opts: {
  removeThrows?: boolean;
  addThrows?: boolean;
}): { warn: ReturnType<typeof vi.fn>; tick: () => void } {
  const warn = vi.fn();
  const fakeConsole = { warn };

  const fakeDocument = {
    body: {},
    addEventListener: () => {
      if (opts.addThrows) throw new Error('add failed');
    },
    removeEventListener: () => {
      if (opts.removeThrows) throw new Error('remove failed');
    },
  };

  const fakeWindow: FakeWindow = {
    addEventListener: () => {},
    parent: { postMessage: () => {} },
  };

  let intervalFn: (() => void) | null = null;
  const fakeSetInterval = (fn: () => void) => {
    intervalFn = fn;
    return 1;
  };

  const sandbox = new Function(
    'window',
    'document',
    'console',
    'setInterval',
    `with (window) { ${OVERLAY_SCRIPT} }`,
  );
  sandbox(fakeWindow, fakeDocument, fakeConsole, fakeSetInterval);

  return {
    warn,
    tick: () => {
      if (intervalFn) intervalFn();
    },
  };
}

describe('OVERLAY_SCRIPT reattach loop warning throttle', () => {
  it('dedupes repeated reattach failures across many ticks', () => {
    const { warn, tick } = runOverlay({ removeThrows: true, addThrows: true });
    // Initial reattach already ran inside script; simulate 25 more interval fires (~5s @ 200ms).
    for (let i = 0; i < 25; i++) tick();

    // 4 install specs (mouseover/mouseout/click/submit) * 2 ops (remove+add)
    // = 8 distinct keys at most. The point: it must not scale with tick count.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('emits at most one warn per unique error key over the whole loop', () => {
    const { warn, tick } = runOverlay({ removeThrows: true });
    for (let i = 0; i < 25; i++) tick();
    const keys = new Set(warn.mock.calls.map((c) => String(c[0])));
    // each warn call should be a unique key
    expect(warn.mock.calls.length).toBe(keys.size);
    // should be ≤ 4 (one per install-spec event type), well under the 25-tick spam ceiling
    expect(warn.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// SET_MODE trust boundary: control messages must come from window.parent.
// Untrusted in-iframe scripts could synthesise MessageEvent-shaped objects or
// bounce events off the iframe itself (window.postMessage(self, ...)), which
// would arrive with ev.source === window. Both paths must be rejected.
// ---------------------------------------------------------------------------

interface ListenerHarness {
  documentListeners: Map<string, (e: unknown) => void>;
  windowListeners: Map<string, (e: unknown) => void>;
  parent: object;
  postedToParent: unknown[];
}

function runOverlayWithHarness(): ListenerHarness {
  const documentListeners = new Map<string, (e: unknown) => void>();
  const windowListeners = new Map<string, (e: unknown) => void>();
  const postedToParent: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => postedToParent.push(msg) };

  const fakeDocument = {
    body: {},
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      documentListeners.set(type, fn);
    },
    removeEventListener: () => {},
  };
  const fakeWindow = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      windowListeners.set(type, fn);
    },
    parent,
  };
  const fakeSetInterval = () => 1;
  const sandbox = new Function(
    'window',
    'document',
    'console',
    'setInterval',
    `with (window) { ${OVERLAY_SCRIPT} }`,
  );
  sandbox(fakeWindow, fakeDocument, { warn: () => {} }, fakeSetInterval);
  return { documentListeners, windowListeners, parent, postedToParent };
}

describe('OVERLAY_SCRIPT SET_MODE source validation', () => {
  it('drops SET_MODE messages whose source is not window.parent (forged)', () => {
    const h = runOverlayWithHarness();
    const onMessage = h.windowListeners.get('message');
    const onClick = h.documentListeners.get('click');
    expect(onMessage).toBeDefined();
    expect(onClick).toBeDefined();

    // Forged: source is the iframe itself (e.g. window.postMessage(self,...)),
    // not the embedding parent. Even though the envelope looks valid, the
    // mode must NOT switch to 'comment'.
    const forgedSource = {};
    onMessage?.({
      source: forgedSource,
      data: { __codesign: true, type: 'SET_MODE', mode: 'comment' },
    });

    // currentMode is internal to the IIFE, so we observe via the click gate:
    // in default mode, clicks must not be intercepted (no postMessage to parent).
    onClick?.({
      preventDefault: () => {},
      stopPropagation: () => {},
      target: { tagName: 'DIV', getBoundingClientRect: () => ({}), outerHTML: '<div/>' },
    });
    expect(h.postedToParent).toHaveLength(0);
  });

  it('accepts SET_MODE only when ev.source === window.parent', () => {
    const h = runOverlayWithHarness();
    const onMessage = h.windowListeners.get('message');
    const onClick = h.documentListeners.get('click');

    onMessage?.({
      source: h.parent,
      data: { __codesign: true, type: 'SET_MODE', mode: 'comment' },
    });

    // Now in comment mode → click should be intercepted and posted to parent.
    onClick?.({
      preventDefault: () => {},
      stopPropagation: () => {},
      target: {
        tagName: 'BUTTON',
        getBoundingClientRect: () => ({ top: 1, left: 2, width: 3, height: 4 }),
        outerHTML: '<button/>',
      },
    });
    expect(h.postedToParent).toHaveLength(1);
    expect((h.postedToParent[0] as { type: string }).type).toBe('ELEMENT_SELECTED');
  });

  it('drops messages with no source (null) even when envelope matches', () => {
    const h = runOverlayWithHarness();
    const onMessage = h.windowListeners.get('message');
    const onClick = h.documentListeners.get('click');

    onMessage?.({
      source: null,
      data: { __codesign: true, type: 'SET_MODE', mode: 'comment' },
    });

    onClick?.({
      preventDefault: () => {},
      stopPropagation: () => {},
      target: { tagName: 'DIV', getBoundingClientRect: () => ({}), outerHTML: '<div/>' },
    });
    expect(h.postedToParent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WATCH_SELECTORS + scroll/resize → ELEMENT_RECTS broadcast.
// The iframe owns the source of truth for each pinned element's rect; the
// parent can't observe iframe-internal scroll, so pins drift without this.
// ---------------------------------------------------------------------------

interface RectHarness {
  documentListeners: Map<string, (e: unknown) => void>;
  windowListeners: Map<string, (e: unknown) => void>;
  parent: object;
  postedToParent: Array<Record<string, unknown>>;
  runRaf: () => void;
  registerElement: (selector: string, rect: DOMRect) => void;
}

function runOverlayForRects(): RectHarness {
  const documentListeners = new Map<string, (e: unknown) => void>();
  const windowListeners = new Map<string, (e: unknown) => void>();
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (msg: unknown) => posted.push(msg as Record<string, unknown>) };
  const elements = new Map<string, { getBoundingClientRect: () => DOMRect }>();

  const fakeDocument = {
    body: {},
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      documentListeners.set(type, fn);
    },
    removeEventListener: () => {},
    querySelector: (sel: string) => elements.get(sel) ?? null,
    evaluate: (sel: string) => ({ singleNodeValue: elements.get(sel) ?? null }),
  };
  let pendingRaf: (() => void) | null = null;
  const fakeWindow = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      windowListeners.set(type, fn);
    },
    parent,
    requestAnimationFrame: (fn: () => void) => {
      pendingRaf = fn;
      return 42;
    },
  };
  const fakeSetInterval = () => 1;
  const sandbox = new Function(
    'window',
    'document',
    'console',
    'setInterval',
    `with (window) { ${OVERLAY_SCRIPT} }`,
  );
  sandbox(fakeWindow, fakeDocument, { warn: () => {} }, fakeSetInterval);

  return {
    documentListeners,
    windowListeners,
    parent,
    postedToParent: posted,
    runRaf: () => {
      const fn = pendingRaf;
      pendingRaf = null;
      if (fn) fn();
    },
    registerElement: (selector, rect) => {
      elements.set(selector, { getBoundingClientRect: () => rect });
    },
  };
}

function makeRect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('OVERLAY_SCRIPT rect broadcast', () => {
  it('broadcasts ELEMENT_RECTS after WATCH_SELECTORS message', () => {
    const h = runOverlayForRects();
    h.registerElement('#a', makeRect(10, 20, 30, 40));
    const onMessage = h.windowListeners.get('message');
    onMessage?.({
      source: h.parent,
      data: { __codesign: true, type: 'WATCH_SELECTORS', selectors: ['#a'] },
    });
    h.runRaf();

    const rectMsg = h.postedToParent.find((m) => m['type'] === 'ELEMENT_RECTS');
    expect(rectMsg).toBeDefined();
    const entries = rectMsg?.['entries'] as Array<{
      selector: string;
      rect: Record<string, number>;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      selector: '#a',
      rect: { top: 10, left: 20, width: 30, height: 40 },
    });
  });

  it('re-broadcasts on scroll so pins track the element', () => {
    const h = runOverlayForRects();
    h.registerElement('#a', makeRect(100, 0, 50, 50));

    h.windowListeners.get('message')?.({
      source: h.parent,
      data: { __codesign: true, type: 'WATCH_SELECTORS', selectors: ['#a'] },
    });
    h.runRaf();
    const firstCount = h.postedToParent.filter((m) => m['type'] === 'ELEMENT_RECTS').length;
    expect(firstCount).toBe(1);

    // Simulate the user scrolling the iframe content: the element's top moved.
    h.registerElement('#a', makeRect(30, 0, 50, 50));
    const onScroll = h.windowListeners.get('scroll');
    expect(onScroll).toBeDefined();
    onScroll?.({});
    h.runRaf();

    const all = h.postedToParent.filter((m) => m['type'] === 'ELEMENT_RECTS');
    expect(all).toHaveLength(2);
    const lastEntries = all[1]?.['entries'] as Array<{ rect: Record<string, number> }>;
    expect(lastEntries[0]?.rect['top']).toBe(30);
  });

  it('coalesces burst of scroll events into one rAF-scheduled broadcast', () => {
    const h = runOverlayForRects();
    h.registerElement('#a', makeRect(0, 0, 1, 1));
    h.windowListeners.get('message')?.({
      source: h.parent,
      data: { __codesign: true, type: 'WATCH_SELECTORS', selectors: ['#a'] },
    });
    h.runRaf(); // initial broadcast from WATCH_SELECTORS

    const onScroll = h.windowListeners.get('scroll');
    onScroll?.({});
    onScroll?.({});
    onScroll?.({});
    h.runRaf();

    const all = h.postedToParent.filter((m) => m['type'] === 'ELEMENT_RECTS');
    // Initial + exactly one from the burst — not three.
    expect(all).toHaveLength(2);
  });

  it('silently skips selectors that do not resolve to elements', () => {
    const h = runOverlayForRects();
    h.registerElement('#live', makeRect(5, 5, 5, 5));
    h.windowListeners.get('message')?.({
      source: h.parent,
      data: {
        __codesign: true,
        type: 'WATCH_SELECTORS',
        selectors: ['#live', '#ghost'],
      },
    });
    h.runRaf();
    const rectMsg = h.postedToParent.find((m) => m['type'] === 'ELEMENT_RECTS');
    const entries = rectMsg?.['entries'] as Array<{ selector: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.selector).toBe('#live');
  });
});

// ---------------------------------------------------------------------------
// HIGHLIGHT_SRC_LINE → __edit_cursor__ rect broadcast.
// Powers the follow-the-edit overlay in the preview iframe. The overlay
// queries [data-src-line] elements, picks the deepest one whose line is
// in [startLine, endLine], and broadcasts its rect under the synthetic key
// `__edit_cursor__`. Renderer reads liveRects['__edit_cursor__'] to position
// the halo + tool pill.
// ---------------------------------------------------------------------------

interface FakeSrcLineEl {
  id: string;
  tagName: string;
  dataset: Record<string, string>;
  parentElement: null;
  previousElementSibling: null;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => DOMRect;
}

function makeSrcLineEl(opts: {
  id: string;
  line: number;
  rect: DOMRect;
}): FakeSrcLineEl {
  return {
    id: opts.id,
    tagName: 'DIV',
    dataset: { srcLine: String(opts.line) },
    parentElement: null,
    previousElementSibling: null,
    getAttribute: (name) => (name === 'data-src-line' ? String(opts.line) : null),
    getBoundingClientRect: () => opts.rect,
  };
}

function runOverlayForCursor(elements: FakeSrcLineEl[]): {
  windowListeners: Map<string, (e: unknown) => void>;
  parent: { postMessage: (msg: unknown) => void };
  postedToParent: Array<Record<string, unknown>>;
  runRaf: () => void;
} {
  const documentListeners = new Map<string, (e: unknown) => void>();
  const windowListeners = new Map<string, (e: unknown) => void>();
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (msg: unknown) => posted.push(msg as Record<string, unknown>) };
  const fakeDocument = {
    body: {},
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      documentListeners.set(type, fn);
    },
    removeEventListener: () => {},
    querySelector: (sel: string) => {
      // Only `#id` selectors come through here from getXPath() resolution.
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        return elements.find((el) => el.id === id) ?? null;
      }
      return null;
    },
    querySelectorAll: (sel: string) => {
      // Used only for `[data-src-line]` discovery in HIGHLIGHT_SRC_LINE.
      if (sel === '[data-src-line]') return elements;
      return [];
    },
    evaluate: () => ({ singleNodeValue: null }),
  };
  let pendingRaf: (() => void) | null = null;
  const fakeWindow = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      windowListeners.set(type, fn);
    },
    parent,
    requestAnimationFrame: (fn: () => void) => {
      pendingRaf = fn;
      return 1;
    },
  };
  const fakeSetInterval = () => 1;
  const sandbox = new Function(
    'window',
    'document',
    'console',
    'setInterval',
    `with (window) { ${OVERLAY_SCRIPT} }`,
  );
  sandbox(fakeWindow, fakeDocument, { warn: () => {} }, fakeSetInterval);
  return {
    windowListeners,
    parent,
    postedToParent: posted,
    runRaf: () => {
      const fn = pendingRaf;
      pendingRaf = null;
      if (fn) fn();
    },
  };
}

describe('OVERLAY_SCRIPT HIGHLIGHT_SRC_LINE', () => {
  it('picks the deepest [data-src-line] element in range and broadcasts its rect under __edit_cursor__', () => {
    // Two elements both within the requested range; the one with the higher
    // data-src-line is the deeper child and should win.
    const outer = makeSrcLineEl({ id: 'outer', line: 5, rect: makeRect(0, 0, 200, 200) });
    const inner = makeSrcLineEl({ id: 'inner', line: 8, rect: makeRect(40, 40, 60, 60) });
    const h = runOverlayForCursor([outer, inner]);

    h.windowListeners.get('message')?.({
      source: h.parent,
      data: { __codesign: true, type: 'HIGHLIGHT_SRC_LINE', startLine: 5, endLine: 10 },
    });
    h.runRaf();

    const rectMsg = h.postedToParent.find((m) => m['type'] === 'ELEMENT_RECTS');
    expect(rectMsg).toBeDefined();
    const entries = rectMsg?.['entries'] as Array<{
      selector: string;
      rect: Record<string, number>;
    }>;
    const cursorEntry = entries.find((e) => e.selector === '__edit_cursor__');
    expect(cursorEntry).toBeDefined();
    // Inner element wins (higher line in range).
    expect(cursorEntry?.rect).toMatchObject({ top: 40, left: 40, width: 60, height: 60 });
  });

  it('drops the cursor when no element falls within the requested range', () => {
    const el = makeSrcLineEl({ id: 'a', line: 100, rect: makeRect(0, 0, 10, 10) });
    const h = runOverlayForCursor([el]);

    h.windowListeners.get('message')?.({
      source: h.parent,
      data: { __codesign: true, type: 'HIGHLIGHT_SRC_LINE', startLine: 5, endLine: 10 },
    });
    h.runRaf();

    // No matching element → the broadcast contains no __edit_cursor__ entry.
    const rectMsg = h.postedToParent.find((m) => m['type'] === 'ELEMENT_RECTS');
    if (rectMsg !== undefined) {
      const entries = rectMsg['entries'] as Array<{ selector: string }>;
      expect(entries.find((e) => e.selector === '__edit_cursor__')).toBeUndefined();
    }
  });

  it('rejects HIGHLIGHT_SRC_LINE from non-parent sources (trust boundary)', () => {
    const el = makeSrcLineEl({ id: 'a', line: 7, rect: makeRect(0, 0, 10, 10) });
    const h = runOverlayForCursor([el]);

    // Forged source — not window.parent.
    h.windowListeners.get('message')?.({
      source: {},
      data: { __codesign: true, type: 'HIGHLIGHT_SRC_LINE', startLine: 5, endLine: 10 },
    });
    h.runRaf();

    expect(h.postedToParent).toHaveLength(0);
  });

  it('ignores malformed HIGHLIGHT_SRC_LINE (non-numeric lines)', () => {
    const el = makeSrcLineEl({ id: 'a', line: 7, rect: makeRect(0, 0, 10, 10) });
    const h = runOverlayForCursor([el]);

    h.windowListeners.get('message')?.({
      source: h.parent,
      data: { __codesign: true, type: 'HIGHLIGHT_SRC_LINE', startLine: 'oops', endLine: 10 },
    });
    h.runRaf();

    // Treated as no-op — cursor cleared, no broadcast posted (no watched selectors either).
    expect(h.postedToParent).toHaveLength(0);
  });
});
