/**
 * may9 Phase 8b follow-up #28 — done.ts surfaces destructive-edit
 * advisory in the result text.
 *
 * The pure check has its own test in destructive-edit.test.ts; this
 * suite verifies the wiring through the done tool:
 *  - 40%+ shrink + no remove-intent prompt -> advisory appears
 *  - shrink + remove-intent prompt -> advisory suppressed
 *  - design mode -> advisory never fires
 *  - no parent (initial run) -> advisory never fires
 *  - host did not wire getParentArtifactBytes -> advisory never fires
 */
import { describe, expect, it, vi } from 'vitest';
import { makeDoneTool } from './done';
import type { TextEditorFsCallbacks } from './text-editor';

function fakeFs(content: string): TextEditorFsCallbacks {
  return {
    view: vi.fn(() => ({ content, numLines: content.split('\n').length })),
    create: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    listDir: vi.fn(() => ['index.html']),
  };
}

describe('done — destructive-edit advisory wiring', () => {
  it('surfaces advisory when current source shrunk 80% with no remove-intent', async () => {
    const tool = makeDoneTool(
      fakeFs('<html><canvas></canvas></html>'), // ~30 bytes
      undefined,
      undefined,
      'game',
      () => 200, // prior was 200 bytes -> 85% shrink
      'Implement a holographic reload UI', // no remove-intent
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('DESTRUCTIVE-EDIT WARNING');
    expect(text).toContain('Source shrank');
  });

  it('does NOT fire when prompt contains remove-intent', async () => {
    const tool = makeDoneTool(
      fakeFs('<html></html>'), // small
      undefined,
      undefined,
      'game',
      () => 200,
      'Remove the post-processing filter — its making the screen unreadable',
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('DESTRUCTIVE-EDIT WARNING');
  });

  it('does NOT fire on design-mode runs', async () => {
    const tool = makeDoneTool(
      fakeFs('<html></html>'),
      undefined,
      undefined,
      'design',
      () => 200,
      'add HUD',
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('DESTRUCTIVE-EDIT WARNING');
  });

  it('does NOT fire when there is no parent (initial run)', async () => {
    const tool = makeDoneTool(
      fakeFs('<html></html>'),
      undefined,
      undefined,
      'game',
      () => null, // first run, no parent
      'add HUD',
    );
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('DESTRUCTIVE-EDIT WARNING');
  });

  it('does NOT fire when getParentArtifactBytes is undefined', async () => {
    const tool = makeDoneTool(fakeFs('<html></html>'), undefined, undefined, 'game');
    const res = await tool.execute('id-1', { path: 'index.html' });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('DESTRUCTIVE-EDIT WARNING');
  });
});
