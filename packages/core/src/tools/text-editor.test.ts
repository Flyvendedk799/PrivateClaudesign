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
    // 24577 bytes — one byte over the 24 KB cap.
    const huge = 'x'.repeat(24577);
    const msg = await runAndCatch(() =>
      tool.execute('id-create-too-big', {
        command: 'create',
        path: 'index.html',
        file_text: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 24576-byte cap/);
    expect(msg).toMatch(/SKELETON tool/);
    expect(msg).toMatch(/str_replace/);
  });

  it('lets a 20 KB JSX skeleton through create (regression: backlog-2 #1 ceiling raise)', async () => {
    const tool = makeTextEditorTool(makeFs());
    // 20 KB — would have failed under the old 8 KB cap; passes the new 24 KB cap.
    const skeleton = `<!doctype html>\n<html>\n<body>\n<div id="root"></div>\n<script type="text/babel">\n${'function Tab() { return <div>tab</div>; }\n'.repeat(420)}</script>\n</body>\n</html>`;
    const res = await tool.execute('id-jsx-skeleton', {
      command: 'create',
      path: 'index.html',
      file_text: skeleton,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Created index\.html/);
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
    const huge = 'y'.repeat(24577); // 24577 = 24 KB + 1
    const msg = await runAndCatch(() =>
      tool.execute('id-replace-too-big', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '<App/>',
        new_str: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 24576-byte cap/);
    expect(msg).toMatch(/Split this into 2-3/);
  });

  it('lets sidecar files through with the relaxed 48KB str_replace cap', async () => {
    const fs = makeFs({ 'mindspace.js': '// engine v1' });
    const tool = makeTextEditorTool(fs);
    // 40 KB replacement — over the 24 KB index cap, under the 48 KB sidecar cap.
    const big = `// engine v2\n${'window.thing();\n'.repeat(2500)}`;
    const res = await tool.execute('id-js-ok', {
      command: 'str_replace',
      path: 'mindspace.js',
      old_str: '// engine v1',
      new_str: big,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Edited mindspace\.js/);
  });

  it('throws on insert when new_str exceeds the per-extension cap (backlog-2 #1 insert symmetry)', async () => {
    const fs = makeFs({ 'index.html': '<App/>' });
    const tool = makeTextEditorTool(fs);
    const huge = 'z'.repeat(24577);
    const msg = await runAndCatch(() =>
      tool.execute('id-insert-too-big', {
        command: 'insert',
        path: 'index.html',
        insert_line: 1,
        new_str: huge,
      }),
    );
    expect(msg).toMatch(/text_editor\.insert/);
    expect(msg).toMatch(/exceeds the 24576-byte cap/);
  });

  it('lets a typical insert through under the cap', async () => {
    const fs = makeFs({ 'index.html': '<App/>' });
    const tool = makeTextEditorTool(fs);
    const text = `<section>${'<p>x</p>'.repeat(50)}</section>`;
    const res = await tool.execute('id-insert-ok', {
      command: 'insert',
      path: 'index.html',
      insert_line: 1,
      new_str: text,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Inserted at index\.html:1/);
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

describe('text-editor view by symbol (backlog-2 #2)', () => {
  const sampleSrc = [
    'const TWEAK_DEFAULTS = {};',
    '',
    'function LessonScreen() {',
    '  return <div>lesson</div>;',
    '}',
    '',
    'function App() {',
    '  return <LessonScreen />;',
    '}',
  ].join('\n');

  it('returns the body of the named symbol with a header', async () => {
    const fs = makeFs({ 'index.html': sampleSrc });
    const tool = makeTextEditorTool(fs);
    const res = await tool.execute('id-sym', {
      command: 'view',
      path: 'index.html',
      symbol: 'LessonScreen',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/index\.html · symbol LessonScreen · lines 3-5/);
    expect(text).toMatch(/return <div>lesson<\/div>/);
  });

  it('throws with a candidate list when the symbol is unknown', async () => {
    const fs = makeFs({ 'index.html': sampleSrc });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('id-sym-miss', {
        command: 'view',
        path: 'index.html',
        symbol: 'NotThere',
      }),
    );
    expect(msg).toMatch(/symbol "NotThere" not found/);
    expect(msg).toMatch(/LessonScreen/);
    expect(msg).toMatch(/App/);
  });

  it('rejects an empty symbol string', async () => {
    const fs = makeFs({ 'index.html': sampleSrc });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('id-sym-empty', {
        command: 'view',
        path: 'index.html',
        symbol: '   ',
      }),
    );
    expect(msg).toMatch(/non-empty identifier/);
  });

  it('throws with line numbers on ambiguous symbols', async () => {
    const dupe = ['function Dup() {}', 'function Dup() {}'].join('\n');
    const fs = makeFs({ 'index.html': dupe });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('id-sym-dupe', {
        command: 'view',
        path: 'index.html',
        symbol: 'Dup',
      }),
    );
    expect(msg).toMatch(/declared 2 times/);
    expect(msg).toMatch(/line\(s\): 1, 2/);
  });
});
