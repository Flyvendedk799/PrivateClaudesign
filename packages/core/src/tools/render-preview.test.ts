import { describe, expect, it, vi } from 'vitest';
import { type RenderPreviewer, makeRenderPreviewTool } from './render-preview.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

function makeFs(initial: Record<string, string> = {}): TextEditorFsCallbacks {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    view(path) {
      const c = map.get(path);
      return c === undefined ? null : { content: c, numLines: c.split('\n').length };
    },
    create(path, content) {
      map.set(path, content);
      return { path };
    },
    strReplace(path, oldStr, newStr) {
      const cur = map.get(path);
      if (cur === undefined) throw new Error('not found');
      map.set(path, cur.replace(oldStr, newStr));
      return { path };
    },
    insert(path) {
      return { path };
    },
    listDir() {
      return [];
    },
  };
}

const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

describe('makeRenderPreviewTool', () => {
  it('hands the artifact to the renderer with the requested viewport and surfaces text + image content', async () => {
    const renderer = vi.fn<RenderPreviewer>(async () => ({
      pngDataUrl: tinyPng,
      widthPx: 390,
      heightPx: 844,
    }));
    const fs = makeFs({ 'index.html': '<!doctype html><html></html>' });
    const tool = makeRenderPreviewTool(fs, renderer);
    const res = await tool.execute('id1', { viewport: 'iphone' });
    expect(renderer).toHaveBeenCalledWith({
      artifactSource: '<!doctype html><html></html>',
      viewport: 'iphone',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/Captured iphone preview at 390×844px/);
    const image = res.content[1] as { type: string; mimeType: string; data: string };
    expect(image.type).toBe('image');
    expect(image.mimeType).toBe('image/png');
    expect(image.data.length).toBeGreaterThan(0);
    expect(res.details.viewport).toBe('iphone');
    expect(res.details.widthPx).toBe(390);
    expect(res.details.heightPx).toBe(844);
  });

  it('defaults viewport to iphone and path to index.html', async () => {
    const renderer = vi.fn<RenderPreviewer>(async () => ({
      pngDataUrl: tinyPng,
      widthPx: 390,
      heightPx: 844,
    }));
    const fs = makeFs({ 'index.html': '<html></html>' });
    const tool = makeRenderPreviewTool(fs, renderer);
    await tool.execute('id2', {});
    expect(renderer).toHaveBeenCalledWith({
      artifactSource: '<html></html>',
      viewport: 'iphone',
    });
  });

  it('throws when the requested file is missing', async () => {
    const renderer = vi.fn<RenderPreviewer>(async () => ({
      pngDataUrl: tinyPng,
      widthPx: 0,
      heightPx: 0,
    }));
    const fs = makeFs({});
    const tool = makeRenderPreviewTool(fs, renderer);
    await expect(tool.execute('id3', { path: 'missing.html' })).rejects.toThrow(
      /file "missing\.html" not found/,
    );
    expect(renderer).not.toHaveBeenCalled();
  });

  it('propagates renderer errors as tool failures', async () => {
    const renderer = vi.fn<RenderPreviewer>(async () => {
      throw new Error('hidden window crashed');
    });
    const fs = makeFs({ 'index.html': '<html></html>' });
    const tool = makeRenderPreviewTool(fs, renderer);
    await expect(tool.execute('id4', {})).rejects.toThrow(/hidden window crashed/);
  });
});
