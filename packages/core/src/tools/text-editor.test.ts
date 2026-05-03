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
      const next = cur.replace(oldStr, newStr);
      map.set(path, next);
      const newlinesBefore = (cur.slice(0, idx).match(/\n/g) ?? []).length;
      const startLine = newlinesBefore + 1;
      const newlinesInNew = (newStr.match(/\n/g) ?? []).length;
      const endLine = newStr.length === 0 ? startLine - 1 : startLine + newlinesInNew;
      const totalLines = next.split('\n').length;
      return { path, startLine, endLine, totalLines };
    },
    insert(path, line, text) {
      const cur = map.get(path) ?? '';
      const lines = cur.split('\n');
      const clamped = Math.max(0, Math.min(line, lines.length));
      lines.splice(clamped, 0, text);
      const next = lines.join('\n');
      map.set(path, next);
      const startLine = clamped + 1;
      const newlinesInText = (text.match(/\n/g) ?? []).length;
      return {
        path,
        startLine,
        endLine: startLine + newlinesInText,
        totalLines: next.split('\n').length,
      };
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

  it('Gameimprove §2 — surfaces the literal bytes when the miss is whitespace drift', async () => {
    // File has tabs, agent's old_str has spaces. Same content, different
    // whitespace. The error should surface the actual literal bytes so
    // the agent can copy-paste them on retry.
    const fileWithTabs = [
      'function startWave() {',
      '\tfor (let i = 0; i < count; i++) {',
      '\t\tspawn(i);',
      '\t}',
      '\tshowAnnounce("WAVE " + wave, 0x6366f1);',
      '}',
    ].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': fileWithTabs }));
    const msg = await runAndCatch(() =>
      tool.execute('id4', {
        command: 'str_replace',
        path: 'index.html',
        // 4-space indent instead of tabs — same logical content
        old_str: 'for (let i = 0; i < count; i++) {\n    spawn(i);\n}',
        new_str: 'for (let i = 0; i < count; i++) { spawn(i); }',
      }),
    );
    expect(msg).toMatch(/near-match exists at line/i);
    expect(msg).toMatch(/differs only in whitespace/i);
    // The literal bytes the file has — agent can copy these directly.
    expect(msg).toMatch(/literal bytes/i);
    // Diff hint pointing at the first differing char.
    expect(msg).toMatch(/at char \d+/);
    // Strong guidance to NOT keep guessing.
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

describe('text-editor success message includes post-edit position', () => {
  // Anchors the model's mental model of the file after each edit. Without
  // these line numbers the agent drifts after a few sequential str_replaces
  // and starts retrying with stale snippets — the 2026-04-29 production
  // trace showed a 14% str_replace miss rate that this should reduce.
  it('str_replace surfaces start/end line and total line count', async () => {
    const file = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': file }));
    const res = await tool.execute('id-pos-replace', {
      command: 'str_replace',
      path: 'index.html',
      old_str: 'line3',
      new_str: 'replaced3a\nreplaced3b',
    });
    const text = (res.content[0] as { text: string }).text;
    // "line3" sits at line 3; replacement spans 2 lines (3-4); file gains
    // one line (now 6 total).
    expect(text).toBe('Edited index.html. New content at lines 3-4 (file is now 6 lines).');
  });

  it('str_replace deletion (empty new_str) surfaces "Removed content"', async () => {
    const file = ['a', 'b', 'c', 'd'].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': file }));
    const res = await tool.execute('id-pos-delete', {
      command: 'str_replace',
      path: 'index.html',
      old_str: 'b\nc\n',
      new_str: '',
    });
    const text = (res.content[0] as { text: string }).text;
    // Anchor on what's left at the deletion's first line for readability.
    expect(text).toMatch(
      /^Edited index\.html\. Removed content at line 2 \(file is now \d+ lines\)\.$/,
    );
  });

  it('insert reports the post-edit range of the new content', async () => {
    const file = ['a', 'b', 'c'].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': file }));
    const res = await tool.execute('id-pos-insert', {
      command: 'insert',
      path: 'index.html',
      insert_line: 2,
      new_str: 'X\nY',
    });
    const text = (res.content[0] as { text: string }).text;
    // insert_line: 2 = before line 3 (1-indexed), spans 2 lines, total grows by 2.
    expect(text).toBe('Inserted at index.html:2. New content at lines 3-4 (file is now 5 lines).');
  });

  it('falls back to the headline when the FS impl omits position info', async () => {
    // Test that the formatter is tolerant of mocks that don't return positions
    // (older tests, third-party FS adapters). When fields are missing, we
    // emit the original short message rather than crashing.
    const map = new Map<string, string>([['index.html', '<h1>Hi</h1>']]);
    const tool = makeTextEditorTool({
      view: (p) => {
        const c = map.get(p);
        return c === undefined ? null : { content: c, numLines: c.split('\n').length };
      },
      create: (p, c) => {
        map.set(p, c);
        return { path: p };
      },
      strReplace: (p, oldStr, newStr) => {
        map.set(p, (map.get(p) ?? '').replace(oldStr, newStr));
        return { path: p };
      },
      insert: (p) => ({ path: p }),
      listDir: () => [],
    });
    const res = await tool.execute('id-pos-fallback', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<h1>Hi</h1>',
      new_str: '<h1>Hello</h1>',
    });
    expect((res.content[0] as { text: string }).text).toBe('Edited index.html.');
  });
});

describe('text-editor per-call size guards', () => {
  it('throws on text_editor.create when file_text exceeds the skeleton cap', async () => {
    const tool = makeTextEditorTool(makeFs());
    // 12289 bytes — one byte over the 12 KB skeleton cap. The 2026-04-29
    // traces showed 5/8 runs blowing the prior 24 KB cap with 37-45 KB
    // monolithic creates; tightening to 12 KB enforces the actual
    // skeleton-then-fills cadence.
    const huge = 'x'.repeat(12289);
    const msg = await runAndCatch(() =>
      tool.execute('id-create-too-big', {
        command: 'create',
        path: 'index.html',
        file_text: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 12288-byte cap/);
    expect(msg).toMatch(/SKELETON tool/);
    // The new error copy walks the model through a concrete recovery shape.
    expect(msg).toMatch(/Recover from this error in TWO calls/);
    expect(msg).toMatch(/str_replace/);
  });

  it('lets a typical 8 KB JSX skeleton through create (under the 12 KB cap)', async () => {
    const tool = makeTextEditorTool(makeFs());
    // ~8 KB skeleton: doctype + html shell + small App + tweak stub.
    // Real skeletons fit comfortably under 12 KB; the cap rejects only
    // monolithic dumps.
    const skeleton = `<!doctype html>\n<html>\n<body>\n<div id="root"></div>\n<script type="text/babel">\n${'function Tab() { return <div>tab</div>; }\n'.repeat(160)}</script>\n</body>\n</html>`;
    const res = await tool.execute('id-jsx-skeleton', {
      command: 'create',
      path: 'index.html',
      file_text: skeleton,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Created index\.html/);
  });

  it('plan0305 P2.2 — rejects the 46 KB monolithic create pattern from the a64f trace', async () => {
    // The 2026-04-29 a64f run (Futurematch B2B Dashboard) opened with a
    // 46 KB monolithic create that would have exceeded the per-turn output
    // budget mid-section. With the cap enforced, this shape is rejected
    // and the model is told to emit a skeleton-then-fill sequence instead.
    const tool = makeTextEditorTool(makeFs());
    const monolith = `<!doctype html>\n<html>\n<head>\n${'<style>.x{}</style>\n'.repeat(2400)}</head>\n<body><div id="root"/></body>\n</html>`;
    expect(monolith.length).toBeGreaterThan(46_000);
    const msg = await runAndCatch(() =>
      tool.execute('id-a64f-monolithic', {
        command: 'create',
        path: 'index.html',
        file_text: monolith,
      }),
    );
    expect(msg).toMatch(/exceeds the 12288-byte cap/);
    expect(msg).toMatch(/SKELETON tool/);
    expect(msg).toMatch(/Recover from this error in TWO calls/);
  });

  it('rejects a 20 KB JSX dump that would have passed the old 24 KB cap (regression guard)', async () => {
    // Captures the failure mode that motivated the 12 KB tightening: agent
    // tries to write the entire design in one create. Anything past 12 KB
    // is now a hard fail, no matter how plausible the contents look.
    const tool = makeTextEditorTool(makeFs());
    const dump = `<!doctype html>\n<html>\n<body>\n${'<div>section</div>\n'.repeat(1100)}</body>\n</html>`;
    const msg = await runAndCatch(() =>
      tool.execute('id-monolithic', {
        command: 'create',
        path: 'index.html',
        file_text: dump,
      }),
    );
    expect(msg).toMatch(/exceeds the 12288-byte cap/);
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

  it('gameplan A5 — Godot scenes (.tscn) accept up to 32 KB per create', async () => {
    const tool = makeTextEditorTool(makeFs());
    const scene = `[gd_scene format=3]\n${'[node name="N"]\n'.repeat(2000)}`;
    expect(scene.length).toBeGreaterThan(20_000);
    expect(scene.length).toBeLessThan(32_768);
    const res = await tool.execute('id-tscn-ok', {
      command: 'create',
      path: 'main.tscn',
      file_text: scene,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Created main\.tscn/);
  });

  it('gameplan A5 — Godot scenes throw with split-into-subscene guidance past 32 KB', async () => {
    const tool = makeTextEditorTool(makeFs());
    const huge = `[gd_scene]\n${'[node]\n'.repeat(5000)}`;
    const msg = await runAndCatch(() =>
      tool.execute('id-tscn-too-big', {
        command: 'create',
        path: 'main.tscn',
        file_text: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 32768-byte cap/);
    expect(msg).toMatch(/Godot scenes/);
    expect(msg).toMatch(/split the scene into a parent .tscn/);
  });

  it('gameplan A5 — game scripts (.gd / .py) accept up to 16 KB per create', async () => {
    const tool = makeTextEditorTool(makeFs());
    const script = `extends Node\n${'# pad\n'.repeat(2000)}`;
    expect(script.length).toBeLessThan(16_384);
    const res = await tool.execute('id-gd-ok', {
      command: 'create',
      path: 'player.gd',
      file_text: script,
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Created player\.gd/);
  });

  it('gameplan A5 — Python scripts throw with split-by-responsibility guidance past 16 KB', async () => {
    const tool = makeTextEditorTool(makeFs());
    const huge = `import pygame\n${'# pad\n'.repeat(3000)}`;
    const msg = await runAndCatch(() =>
      tool.execute('id-py-too-big', {
        command: 'create',
        path: 'main.py',
        file_text: huge,
      }),
    );
    expect(msg).toMatch(/exceeds the 16384-byte cap/);
    expect(msg).toMatch(/Game scripts/);
    expect(msg).toMatch(/split the script by responsibility/);
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
    // New copy walks the model toward the canonical "split into smaller
    // calls anchored to existing snippets" recovery shape.
    expect(msg).toMatch(/splitting THIS replace into 2-4 smaller/);
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
    // insert mirrors create, so the same 12 KB ceiling applies on
    // index.html. Keeps the four commands' size guarantees consistent.
    const fs = makeFs({ 'index.html': '<App/>' });
    const tool = makeTextEditorTool(fs);
    const huge = 'z'.repeat(12289);
    const msg = await runAndCatch(() =>
      tool.execute('id-insert-too-big', {
        command: 'insert',
        path: 'index.html',
        insert_line: 1,
        new_str: huge,
      }),
    );
    expect(msg).toMatch(/text_editor\.insert/);
    expect(msg).toMatch(/exceeds the 12288-byte cap/);
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
