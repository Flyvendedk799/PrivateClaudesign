import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `renderToStaticMarkup` runs through the SSR path of `useSyncExternalStore`,
// which by default returns React's "server snapshot" (the initial store
// state) — meaning calls to `useCodesignStore.setState({ ... })` from a test
// would be invisible to the rendered component. Mock the store hook directly
// to call `selector(getState())`, matching the pattern in FilesPanel.test.tsx.
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const mockStoreHook = vi.fn((selector: (s: unknown) => unknown) =>
    selector(actual.useCodesignStore.getState()),
  );
  Object.assign(mockStoreHook, actual.useCodesignStore);
  return {
    ...actual,
    useCodesignStore: mockStoreHook,
  };
});

import { useCodesignStore } from '../store';
import { EditCursorOverlay } from './EditCursorOverlay';

const initial = useCodesignStore.getState();

beforeEach(() => {
  useCodesignStore.setState({
    ...initial,
    editCursor: null,
    liveRects: {},
    previewZoom: 100,
  });
});

afterEach(() => {
  useCodesignStore.setState({
    ...initial,
    editCursor: null,
    liveRects: {},
    previewZoom: 100,
  });
});

describe('EditCursorOverlay', () => {
  it('renders nothing when editCursor is null', () => {
    const html = renderToStaticMarkup(<EditCursorOverlay />);
    expect(html).toBe('');
  });

  it('renders nothing when editCursor is set but no rect has arrived yet', () => {
    useCodesignStore.setState({
      editCursor: {
        key: 1,
        toolLabel: 'Editing line 42',
        startLine: 42,
        endLine: 42,
        expiresAt: performance.now() + 1400,
      },
      liveRects: {}, // no __edit_cursor__ key — overlay can't position the halo
    });
    const html = renderToStaticMarkup(<EditCursorOverlay />);
    expect(html).toBe('');
  });

  it('renders the halo + tool pill when both editCursor and __edit_cursor__ rect are present', () => {
    useCodesignStore.setState({
      editCursor: {
        key: 1,
        toolLabel: 'Editing line 412',
        startLine: 412,
        endLine: 419,
        expiresAt: performance.now() + 1400,
      },
      liveRects: {
        __edit_cursor__: { top: 100, left: 200, width: 80, height: 60 },
      },
    });
    const html = renderToStaticMarkup(<EditCursorOverlay />);
    expect(html).toContain('Editing line 412');
    // Halo container is pointer-events:none so it never intercepts iframe clicks.
    expect(html).toContain('pointer-events-none');
    // Halo border styling is present (color token + ring).
    expect(html).toContain('border-2');
  });

  it('scales the halo position by previewZoom (zoom=150% → 1.5× rect coords)', () => {
    useCodesignStore.setState({
      editCursor: {
        key: 1,
        toolLabel: 'Editing line 5',
        startLine: 5,
        endLine: 5,
        expiresAt: performance.now() + 1400,
      },
      liveRects: {
        // Iframe-coord rect: top=100, left=200, w=100, h=100
        __edit_cursor__: { top: 100, left: 200, width: 100, height: 100 },
      },
      previewZoom: 150,
    });
    const html = renderToStaticMarkup(<EditCursorOverlay />);
    // Element center in scaled coords:
    //   x = 200*1.5 + 150/2 = 300 + 75 = 375
    //   y = 100*1.5 + 150/2 = 150 + 75 = 225
    // Halo size = clamp(min(150,150)*0.4, 24, 64) = 60
    // Halo top = 225 - 30 = 195; halo left = 375 - 30 = 345
    expect(html).toContain('top:195px');
    expect(html).toContain('left:345px');
  });

  it('respects the minimum halo size for tiny elements (24px floor)', () => {
    // Tiny inline elements (e.g. a `<span>` of width 4) shouldn't produce a
    // 1.6px halo. The clamp keeps it visible at 24px floor.
    useCodesignStore.setState({
      editCursor: {
        key: 1,
        toolLabel: 'Editing line 9',
        startLine: 9,
        endLine: 9,
        expiresAt: performance.now() + 1400,
      },
      liveRects: { __edit_cursor__: { top: 0, left: 0, width: 4, height: 4 } },
    });
    const html = renderToStaticMarkup(<EditCursorOverlay />);
    expect(html).toContain('width:24px');
    expect(html).toContain('height:24px');
  });
});
