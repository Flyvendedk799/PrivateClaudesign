import { describe, expect, it } from 'vitest';
import { type TextEditorFsCallbacks, makeTextEditorTool } from './text-editor.js';

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
      if (cur === undefined) throw new Error(`File not found: ${path}`);
      const idx = cur.indexOf(oldStr);
      if (idx === -1) throw new Error(`old_str not found in ${path}`);
      const last = cur.lastIndexOf(oldStr);
      if (last !== idx) {
        let count = 0;
        let i = cur.indexOf(oldStr);
        while (i !== -1) {
          count += 1;
          i = cur.indexOf(oldStr, i + oldStr.length);
        }
        throw new Error(`old_str matched ${count} times in ${path}; must be unique`);
      }
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

async function runAndCatch(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to throw, but it resolved');
}

describe('text-editor str_replace miss handling', () => {
  it('throws with candidate line numbers when old_str cannot be located', async () => {
    const file = [
      '<div className="hero">',
      '  <h1>Welcome</h1>',
      '  <p>Body</p>',
      '</div>',
      '<div className="cta">',
      '  <h1>Welcome</h1>',
      '  <button>Go</button>',
      '</div>',
    ].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': file }));
    const msg = await runAndCatch(() =>
      tool.execute('id1', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '  <h1>Welcome</h1>\n  <span>this line never existed</span>',
        new_str: '  <h1>Hello</h1>',
      }),
    );
    expect(msg).toMatch(/old_str not found/);
    // Both lines 2 and 6 contain `<h1>Welcome</h1>`, the first non-empty
    // line of old_str. The agent should be told both are candidates.
    expect(msg).toContain('2, 6');
    expect(msg).toMatch(/view_range/);
    expect(msg).toMatch(/Do NOT/);
  });

  it('throws with match line numbers + extend-context guidance when old_str is ambiguous', async () => {
    const file = ['<p>repeat</p>', '<p>repeat</p>', '<p>repeat</p>'].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': file }));
    const msg = await runAndCatch(() =>
      tool.execute('id2', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '<p>repeat</p>',
        new_str: '<p>once</p>',
      }),
    );
    expect(msg).toMatch(/matched 3 times/);
    expect(msg).toContain('1, 2, 3');
    expect(msg).toMatch(/extend `old_str`/);
    expect(msg).toMatch(/Do NOT shorten/);
  });

  it('throws with a generic message when old_str has no overlap with the file', async () => {
    const tool = makeTextEditorTool(makeFs({ 'index.html': '<div>only this</div>' }));
    const msg = await runAndCatch(() =>
      tool.execute('id3', {
        command: 'str_replace',
        path: 'index.html',
        old_str: 'completely unrelated content',
        new_str: 'x',
      }),
    );
    expect(msg).toMatch(/does not appear anywhere/);
    expect(msg).toMatch(/Do NOT guess/);
  });

  it('successful str_replace returns ok payload', async () => {
    const tool = makeTextEditorTool(makeFs({ 'index.html': '<h1>Hi</h1>' }));
    const res = await tool.execute('id4', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<h1>Hi</h1>',
      new_str: '<h1>Hello</h1>',
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Edited index\.html/);
  });
});

describe('text-editor per-call size guards', () => {
  it('throws on text_editor.create when file_text exceeds the skeleton cap', async () => {
    const tool = makeTextEditorTool(makeFs());
    // 8193 bytes — one byte over the 8 KB cap.
    const huge = 'x'.repeat(8193);
    const msg = await runAndCatch(() =>
      tool.execute('id-create-too-big', {
        command: 'create',
        path: 'index.html',
        file_text: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 8192-byte cap/);
    expect(msg).toMatch(/SKELETON tool/);
    expect(msg).toMatch(/str_replace/);
  });

  it('lets sidecar files (.css / .js) through with the relaxed 64KB create cap', async () => {
    const tool = makeTextEditorTool(makeFs());
    // 50 KB CSS — over the 8 KB index.html cap, well under the 64 KB sidecar cap.
    const big = `/* huge css */\n${'.x{color:red}\n'.repeat(3500)}`;
    const res = await tool.execute('id-css-ok', {
      command: 'create',
      path: 'styles.css',
      file_text: big,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Created styles\.css/);
  });

  it('still throws on sidecar files when create exceeds the 64KB sidecar cap', async () => {
    const tool = makeTextEditorTool(makeFs());
    const huge = 'x'.repeat(65537); // 64 KB + 1
    const msg = await runAndCatch(() =>
      tool.execute('id-css-too-big', {
        command: 'create',
        path: 'styles.css',
        file_text: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 65536-byte cap/);
    expect(msg).toMatch(/Sidecar files/);
  });

  it('lets a generously-sized skeleton through create', async () => {
    const tool = makeTextEditorTool(makeFs());
    // 4 KB skeleton — clearly under the 8 KB cap.
    const skeleton = `// skeleton\n${'/* pad */\n'.repeat(400)}`;
    const res = await tool.execute('id-create-ok', {
      command: 'create',
      path: 'index.html',
      file_text: skeleton,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Created index\.html/);
  });

  it('throws on str_replace when new_str exceeds the per-edit cap', async () => {
    const fs = makeFs({ 'index.html': '<App/>' });
    const tool = makeTextEditorTool(fs);
    const huge = 'y'.repeat(12289); // 12289 = 12 KB + 1
    const msg = await runAndCatch(() =>
      tool.execute('id-replace-too-big', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '<App/>',
        new_str: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 12288-byte cap/);
    expect(msg).toMatch(/Split this into 2-3/);
  });

  it('lets sidecar files through with the relaxed 32KB str_replace cap', async () => {
    const fs = makeFs({ 'mindspace.js': '// engine v1' });
    const tool = makeTextEditorTool(fs);
    // 30 KB replacement — over the 12 KB index cap, under the 32 KB sidecar cap.
    const big = `// engine v2\n${'window.thing();\n'.repeat(1900)}`;
    const res = await tool.execute('id-js-ok', {
      command: 'str_replace',
      path: 'mindspace.js',
      old_str: '// engine v1',
      new_str: big,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Edited mindspace\.js/);
  });

  it('lets a typical section-sized str_replace through', async () => {
    const fs = makeFs({ 'index.html': '<App/>' });
    const tool = makeTextEditorTool(fs);
    // 3 KB chunk — typical "one section" size.
    const section = `<section>${'<p>x</p>'.repeat(380)}</section>`;
    const res = await tool.execute('id-replace-ok', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<App/>',
      new_str: section,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Edited index\.html/);
  });
});
