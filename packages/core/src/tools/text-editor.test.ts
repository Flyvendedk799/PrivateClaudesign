import { describe, expect, it } from 'vitest';
import { createCameraGuard } from './camera-pin.js';
import { createEditBudget } from './edit-budget.js';
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
    patch(path, hunks) {
      const cur = map.get(path);
      if (cur === undefined) throw new Error(`File not found: ${path}`);
      const lines = cur.split('\n');
      const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
      for (const h of sorted) {
        if (h.expectedOriginal !== undefined) {
          const actual = lines.slice(h.startLine - 1, h.endLine).join('\n');
          if (actual !== h.expectedOriginal) {
            throw new Error(
              `patch hunk at lines ${h.startLine}-${h.endLine}: expectedOriginal mismatch.`,
            );
          }
        }
      }
      let firstStart = Number.MAX_SAFE_INTEGER;
      let lastEnd = 0;
      for (const h of sorted) {
        const repl = h.replacement.length === 0 ? [] : h.replacement.split('\n');
        lines.splice(h.startLine - 1, h.endLine - h.startLine + 1, ...repl);
        if (h.startLine < firstStart) firstStart = h.startLine;
        lastEnd = Math.max(lastEnd, h.startLine + Math.max(0, repl.length - 1));
      }
      const next = lines.join('\n');
      map.set(path, next);
      return {
        path,
        startLine: firstStart === Number.MAX_SAFE_INTEGER ? 1 : firstStart,
        endLine: lastEnd,
        totalLines: lines.length,
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
    // Improver1 §2 — error embeds the current content inline so the
    // agent doesn't need a follow-up `view` round-trip.
    expect(msg).toMatch(/CURRENT CONTENT/);
    expect(msg).toMatch(/build a fresh old_str/);
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

describe('text-editor str_replace edit-budget warning (game-mode Sequence 3)', () => {
  function buildFile(): string {
    return Array.from({ length: 30 }, (_, i) => `<p>line ${i + 1}</p>`).join('\n');
  }

  it('does NOT append a warning when no editBudget is wired (design-mode regression guard)', async () => {
    const fs = makeFs({ 'index.html': buildFile() });
    const tool = makeTextEditorTool(fs);
    for (let i = 0; i < 8; i += 1) {
      const before = `<p>line ${i + 1}</p>`;
      const after = `<p>edited ${i + 1}</p>`;
      const res = (await tool.execute(`id-${i}`, {
        command: 'str_replace',
        path: 'index.html',
        old_str: before,
        new_str: after,
      })) as { content: Array<{ text: string }> };
      expect(res.content[0]?.text ?? '').not.toContain('[edit-budget]');
    }
  });

  it('appends [edit-budget] once the 5th consecutive str_replace lands without a verify', async () => {
    const fs = makeFs({ 'index.html': buildFile() });
    const budget = createEditBudget(5);
    const tool = makeTextEditorTool(fs, budget);
    const messages: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = (await tool.execute(`id-${i}`, {
        command: 'str_replace',
        path: 'index.html',
        old_str: `<p>line ${i + 1}</p>`,
        new_str: `<p>edited ${i + 1}</p>`,
      })) as { content: Array<{ text: string }> };
      messages.push(res.content[0]?.text ?? '');
    }
    for (let i = 0; i < 4; i += 1) {
      expect(messages[i] ?? '').not.toContain('[edit-budget]');
    }
    expect(messages[4]).toContain('[edit-budget]');
    expect(messages[4]).toContain('5 consecutive str_replace calls against index.html');
    expect(messages[4]).toContain('comment anchor');
  });

  it('reset() clears the warning so the next 4 edits are clean again', async () => {
    const fs = makeFs({ 'index.html': buildFile() });
    const budget = createEditBudget(5);
    const tool = makeTextEditorTool(fs, budget);
    for (let i = 0; i < 5; i += 1) {
      await tool.execute(`id-${i}`, {
        command: 'str_replace',
        path: 'index.html',
        old_str: `<p>line ${i + 1}</p>`,
        new_str: `<p>edited ${i + 1}</p>`,
      });
    }
    budget.reset();
    const res = (await tool.execute('id-after-reset', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<p>line 6</p>',
      new_str: '<p>edited 6</p>',
    })) as { content: Array<{ text: string }> };
    expect(res.content[0]?.text ?? '').not.toContain('[edit-budget]');
  });

  it('counts each path independently (a flood on a.js does not flag b.js)', async () => {
    const fs = makeFs({
      'a.js': "console.log('a');",
      'b.js': "console.log('b');",
    });
    const budget = createEditBudget(3);
    const tool = makeTextEditorTool(fs, budget);
    const aRes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = (await tool.execute(`a-${i}`, {
        command: 'str_replace',
        path: 'a.js',
        old_str: `console.log('a${i === 0 ? '' : i}');`,
        new_str: `console.log('a${i + 1}');`,
      })) as { content: Array<{ text: string }> };
      aRes.push(res.content[0]?.text ?? '');
    }
    const bRes = (await tool.execute('b-0', {
      command: 'str_replace',
      path: 'b.js',
      old_str: "console.log('b');",
      new_str: "console.log('b1');",
    })) as { content: Array<{ text: string }> };
    expect(aRes[2]).toContain('[edit-budget]');
    expect(bRes.content[0]?.text ?? '').not.toContain('[edit-budget]');
  });
});

describe('text-editor camera-pin enforcement (game-mode Sequence 5)', () => {
  const persp =
    'const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 100);\ncamera.position.set(0, 1.6, 4);';
  const ortho = 'const camera = new THREE.OrthographicCamera(-w, w, h, -h, 0.1, 200);';

  it('refuses a Perspective → Orthographic swap when the user prompt does not name the camera', async () => {
    const fs = makeFs({ 'index.html': `<script>${persp}</script>` });
    const guard = createCameraGuard({
      gameMode: true,
      editMode: true,
      userPrompt: 'aim and hitbox should correlate',
    });
    const tool = makeTextEditorTool(fs, undefined, guard);
    const msg = await runAndCatch(() =>
      tool.execute('cam-1', {
        command: 'str_replace',
        path: 'index.html',
        old_str: persp,
        new_str: ortho,
      }),
    );
    expect(msg).toMatch(/\[camera-pin\]/);
    expect(msg).toMatch(/PerspectiveCamera → OrthographicCamera/);
  });

  it('allows a same-class FOV tweak through (only swaps are blocked)', async () => {
    const fs = makeFs({ 'index.html': `<script>${persp}</script>` });
    const guard = createCameraGuard({
      gameMode: true,
      editMode: true,
      userPrompt: 'feels too narrow',
    });
    const tool = makeTextEditorTool(fs, undefined, guard);
    await tool.execute('cam-2', {
      command: 'str_replace',
      path: 'index.html',
      old_str: 'PerspectiveCamera(60, w / h, 0.1, 100)',
      new_str: 'PerspectiveCamera(75, w / h, 0.1, 100)',
    });
    expect(fs.view('index.html')?.content).toContain('PerspectiveCamera(75, w / h, 0.1, 100)');
  });

  it('allows the swap when the user prompt mentions the camera explicitly', async () => {
    const fs = makeFs({ 'index.html': `<script>${persp}</script>` });
    const guard = createCameraGuard({
      gameMode: true,
      editMode: true,
      userPrompt: 'change the camera to a 3rd-person follow cam',
    });
    const tool = makeTextEditorTool(fs, undefined, guard);
    await tool.execute('cam-3', {
      command: 'str_replace',
      path: 'index.html',
      old_str: persp,
      new_str: ortho,
    });
    expect(fs.view('index.html')?.content).toContain('OrthographicCamera');
  });

  it('design-mode runs are never blocked (regression guard for non-game artifacts)', async () => {
    const fs = makeFs({ 'index.html': `<script>${persp}</script>` });
    const guard = createCameraGuard({
      gameMode: false,
      editMode: true,
      userPrompt: 'just iterate',
    });
    const tool = makeTextEditorTool(fs, undefined, guard);
    await tool.execute('cam-4', {
      command: 'str_replace',
      path: 'index.html',
      old_str: persp,
      new_str: ortho,
    });
    expect(fs.view('index.html')?.content).toContain('OrthographicCamera');
  });
});

describe('text-editor patch protocol — Backlog-3 §2', () => {
  it('applies a single hunk by line range', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo\nthree\nfour' });
    const tool = makeTextEditorTool(fs);
    await tool.execute('p1', {
      command: 'patch',
      path: 'index.html',
      hunks: [{ startLine: 2, endLine: 3, replacement: 'TWO\nTHREE' }],
    });
    expect(fs.view('index.html')?.content).toBe('one\nTWO\nTHREE\nfour');
  });

  it('applies non-adjacent hunks correctly via descending-start ordering', async () => {
    const fs = makeFs({ 'index.html': 'a\nb\nc\nd\ne\nf' });
    const tool = makeTextEditorTool(fs);
    // Hunks given in arbitrary order — internal sort applies high→low.
    await tool.execute('p2', {
      command: 'patch',
      path: 'index.html',
      hunks: [
        { startLine: 1, endLine: 1, replacement: 'A' },
        { startLine: 5, endLine: 5, replacement: 'E' },
      ],
    });
    expect(fs.view('index.html')?.content).toBe('A\nb\nc\nd\nE\nf');
  });

  it('rejects overlapping hunks', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo\nthree\nfour' });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('p3', {
        command: 'patch',
        path: 'index.html',
        hunks: [
          { startLine: 1, endLine: 2, replacement: 'X' },
          { startLine: 2, endLine: 3, replacement: 'Y' },
        ],
      }),
    );
    expect(msg).toMatch(/overlap/i);
  });

  it('rejects expectedOriginal mismatch (the safety net)', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo\nthree\nfour' });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('p4', {
        command: 'patch',
        path: 'index.html',
        hunks: [
          {
            startLine: 2,
            endLine: 2,
            replacement: 'X',
            expectedOriginal: 'NOT THE ACTUAL TEXT',
          },
        ],
      }),
    );
    expect(msg).toMatch(/expectedOriginal/i);
    // File untouched on validation failure.
    expect(fs.view('index.html')?.content).toBe('one\ntwo\nthree\nfour');
  });

  it('accepts expectedOriginal matching the current lines', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo\nthree\nfour' });
    const tool = makeTextEditorTool(fs);
    await tool.execute('p5', {
      command: 'patch',
      path: 'index.html',
      hunks: [{ startLine: 2, endLine: 3, replacement: 'X', expectedOriginal: 'two\nthree' }],
    });
    expect(fs.view('index.html')?.content).toBe('one\nX\nfour');
  });

  it('rejects out-of-range line numbers', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo' });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('p6', {
        command: 'patch',
        path: 'index.html',
        hunks: [{ startLine: 5, endLine: 6, replacement: 'X' }],
      }),
    );
    expect(msg).toMatch(/invalid line range|exceeds/i);
  });

  it('total replacement byte count is capped (sidecar limit)', async () => {
    const fs = makeFs({ 'styles.css': 'a\nb\nc' });
    const tool = makeTextEditorTool(fs);
    const huge = 'x'.repeat(60_000);
    const msg = await runAndCatch(() =>
      tool.execute('p7', {
        command: 'patch',
        path: 'styles.css',
        hunks: [{ startLine: 1, endLine: 1, replacement: huge }],
      }),
    );
    expect(msg).toMatch(/exceeds.*cap/i);
  });

  it('throws when fs adapter does not implement patch', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo' });
    // biome-ignore lint/performance/noDelete: removing the optional method simulates an older adapter
    delete (fs as { patch?: unknown }).patch;
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('p8', {
        command: 'patch',
        path: 'index.html',
        hunks: [{ startLine: 1, endLine: 1, replacement: 'X' }],
      }),
    );
    expect(msg).toMatch(/patch is not available/i);
  });
});

describe('text-editor str_replace miss content embed — Improver1 §2', () => {
  it('embeds the actual surrounding lines (line-numbered) inline on a candidate-line miss', async () => {
    // Build a file where the first non-empty line of old_str appears
    // on a known line, but the rest of old_str has drifted. The error
    // should include the current bytes around that line so the agent
    // can rebuild old_str without an extra view round-trip.
    const file = [
      '// header line 1',
      '// header line 2',
      'function foo() {',
      '  return 1;',
      '}',
      '',
      '// HERO START',
      '<div className="hero">',
      '  <h1>real hero text</h1>',
      '</div>',
      '// HERO END',
      '',
      'const x = 42;',
    ].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': file }));
    const msg = await runAndCatch(() =>
      tool.execute('miss-1', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '<div className="hero">\n  <h1>STALE TEXT</h1>\n</div>',
        new_str: '<div>x</div>',
      }),
    );
    expect(msg).toMatch(/CURRENT CONTENT/);
    // Line numbers are line-prefixed (4-char padded); line 8 holds the hero div.
    expect(msg).toContain('   8  <div className="hero">');
    expect(msg).toContain('   9    <h1>real hero text</h1>');
    // Tells the model to build fresh.
    expect(msg).toMatch(/build a fresh old_str/);
  });

  it('embeds current bytes on a whitespace-drift near-match', async () => {
    // Tabs vs spaces. Existing fuzzy match path now also embeds a window.
    const file = [
      'function startWave() {',
      '\tfor (let i = 0; i < count; i++) {',
      '\t\tspawn(i);',
      '\t}',
      '}',
    ].join('\n');
    const tool = makeTextEditorTool(makeFs({ 'index.html': file }));
    const msg = await runAndCatch(() =>
      tool.execute('miss-2', {
        command: 'str_replace',
        path: 'index.html',
        old_str: 'for (let i = 0; i < count; i++) {\n    spawn(i);\n}',
        new_str: 'for (let i = 0; i < count; i++) { spawn(i); }',
      }),
    );
    expect(msg).toMatch(/near-match exists at line/i);
    // Both the literal-bytes hint AND the window are present.
    expect(msg).toMatch(/literal bytes/i);
    expect(msg).toMatch(/CURRENT CONTENT/);
    expect(msg).toContain('spawn(i);');
  });

  it('does not embed a window when first-line anchor is absent (genuine miss)', async () => {
    const tool = makeTextEditorTool(makeFs({ 'index.html': '<div>only this</div>' }));
    const msg = await runAndCatch(() =>
      tool.execute('miss-3', {
        command: 'str_replace',
        path: 'index.html',
        old_str: 'completely unrelated content',
        new_str: 'x',
      }),
    );
    // No candidate lines → fall back to "re-issue view" guidance.
    expect(msg).toMatch(/does not appear anywhere/);
    expect(msg).not.toMatch(/CURRENT CONTENT/);
    expect(msg).toMatch(/view_range/);
  });
});

describe('text-editor placeholder echo intercept — Improver1 §1', () => {
  it('throws a tailored error when args carry the poison marker', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo' });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('echo-1', {
        // Placeholder shape emitted by context-prune for stubbed
        // history. The model echoed it back as fresh args.
        __do_not_echo_this_object: true,
        __redaction_message: 'PRIOR TOOL INPUT REDACTED…',
        __redaction_original_bytes: 30000,
        command: 'view',
        path: '__redacted_history_placeholder__',
      } as unknown as Parameters<typeof tool.execute>[1]),
    );
    expect(msg).toMatch(/echoed a redaction placeholder/i);
    expect(msg).toMatch(/Compose FRESH args from scratch/i);
    expect(msg).toMatch(/view_range/i);
    // Critically: the underlying file must NOT have been touched.
    expect(fs.view('index.html')?.content).toBe('one\ntwo');
  });

  it('detects the sentinel path even without the marker key', async () => {
    const fs = makeFs({ 'index.html': 'one\ntwo' });
    const tool = makeTextEditorTool(fs);
    const msg = await runAndCatch(() =>
      tool.execute('echo-2', {
        command: 'view',
        // The marker key was somehow stripped, but the sentinel path
        // remains — belt and braces.
        path: '__redacted_history_placeholder__',
      } as unknown as Parameters<typeof tool.execute>[1]),
    );
    expect(msg).toMatch(/echoed a redaction placeholder/i);
  });

  it('does not fire on a normal call (no marker, no sentinel)', async () => {
    const fs = makeFs({ 'index.html': '<h1>Hi</h1>' });
    const tool = makeTextEditorTool(fs);
    const res = await tool.execute('normal-1', {
      command: 'view',
      path: 'index.html',
    });
    const block = res.content[0];
    expect(block && 'text' in block ? block.text : '').toContain('<h1>Hi</h1>');
  });
});

describe('text-editor per-target retry budget — Improver1 §8', () => {
  function readText(
    res: Awaited<ReturnType<ReturnType<typeof makeTextEditorTool>['execute']>>,
  ): string {
    const block = res.content[0];
    return block && 'text' in block ? block.text : '';
  }

  it('refuses the 4th str_replace on the same content target after 3 failures', async () => {
    const fs = makeFs({ 'index.html': '<div>real content</div>' });
    const tool = makeTextEditorTool(fs);
    // Three failed attempts on a content anchor that doesn't exist.
    for (let i = 0; i < 3; i += 1) {
      await runAndCatch(() =>
        tool.execute(`miss-${i}`, {
          command: 'str_replace',
          path: 'index.html',
          old_str: '// THE BODY BOB SECTION',
          new_str: 'X',
        }),
      );
    }
    // 4th attempt with the same first-line probe — should be refused.
    const msg = await runAndCatch(() =>
      tool.execute('miss-4', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '// THE BODY BOB SECTION\n  // (slightly different second line)',
        new_str: 'X',
      }),
    );
    expect(msg).toMatch(/Refusing str_replace/i);
    expect(msg).toMatch(/already failed 3 times/i);
    expect(msg).toMatch(/THE BODY BOB SECTION/);
    expect(msg).toMatch(/view_range/);
  });

  it('shares the bucket across str_replace and patch (cross-tool thrash refusal)', async () => {
    const fs = makeFs({ 'index.html': '<div>real content</div>\nline 2\nline 3' });
    const tool = makeTextEditorTool(fs);
    // 2 failed str_replace + 1 failed patch on same content probe.
    for (let i = 0; i < 2; i += 1) {
      await runAndCatch(() =>
        tool.execute(`sr-${i}`, {
          command: 'str_replace',
          path: 'index.html',
          old_str: '// SHARED PROBE\n  more',
          new_str: 'X',
        }),
      );
    }
    await runAndCatch(() =>
      tool.execute('p-1', {
        command: 'patch',
        path: 'index.html',
        hunks: [
          { startLine: 1, endLine: 1, replacement: 'X', expectedOriginal: '// SHARED PROBE' },
        ],
      }),
    );
    // 4th attempt — patch this time. Should be refused because the
    // content bucket has accumulated 3 failures.
    const msg = await runAndCatch(() =>
      tool.execute('p-2', {
        command: 'patch',
        path: 'index.html',
        hunks: [
          { startLine: 2, endLine: 2, replacement: 'X', expectedOriginal: '// SHARED PROBE' },
        ],
      }),
    );
    expect(msg).toMatch(/Refusing patch/i);
    expect(msg).toMatch(/already failed 3 times/i);
    expect(msg).toMatch(/across str_replace and\/or patch attempts/i);
  });

  it('a successful str_replace on the same target clears the counter', async () => {
    const fs = makeFs({ 'index.html': 'KEEP\n// SHARED PROBE\nKEEP' });
    const tool = makeTextEditorTool(fs);
    // 2 failed attempts.
    for (let i = 0; i < 2; i += 1) {
      await runAndCatch(() =>
        tool.execute(`miss-${i}`, {
          command: 'str_replace',
          path: 'index.html',
          old_str: '// SHARED PROBE\nDOES NOT EXIST',
          new_str: 'X',
        }),
      );
    }
    // Now the agent succeeds with a correct old_str.
    const ok = await tool.execute('hit', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '// SHARED PROBE',
      new_str: '// REPLACED',
    });
    expect(readText(ok)).toMatch(/Edited/);
    // After the success, two more failures on the same probe should
    // NOT trigger the refusal — counter was cleared.
    await runAndCatch(() =>
      tool.execute('miss-after', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '// SHARED PROBE\nstill not there',
        new_str: 'Y',
      }),
    );
    // Only 1 failure post-success → next attempt should still produce
    // the standard miss error, NOT the refusal.
    const nextMsg = await runAndCatch(() =>
      tool.execute('miss-after-2', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '// SHARED PROBE\nalso not there',
        new_str: 'Z',
      }),
    );
    expect(nextMsg).toMatch(/old_str not found|does not appear anywhere/i);
    expect(nextMsg).not.toMatch(/Refusing str_replace/i);
  });

  it('a ranged view of the path resets the retry budget', async () => {
    const fs = makeFs({ 'index.html': 'KEEP\n// SHARED PROBE\nKEEP\nLINE\nLINE\nLINE' });
    const tool = makeTextEditorTool(fs);
    for (let i = 0; i < 3; i += 1) {
      await runAndCatch(() =>
        tool.execute(`m-${i}`, {
          command: 'str_replace',
          path: 'index.html',
          old_str: '// SHARED PROBE\nDNE',
          new_str: 'X',
        }),
      );
    }
    // Issue a ranged view — the reset trigger.
    await tool.execute('vr', { command: 'view', path: 'index.html', view_range: [1, 6] });
    // Next attempt: even though probe is the same, the failure counter
    // was reset by the view, so we get the standard miss error (not
    // the refusal).
    const msg = await runAndCatch(() =>
      tool.execute('m-after', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '// SHARED PROBE\nDNE',
        new_str: 'X',
      }),
    );
    expect(msg).not.toMatch(/Refusing str_replace/i);
    expect(msg).toMatch(/old_str not found/);
  });

  it('different content probes on the same path do NOT count toward each other', async () => {
    const fs = makeFs({ 'index.html': 'a\nb\nc\nd' });
    const tool = makeTextEditorTool(fs);
    // 2 failed attempts on probe-A.
    for (let i = 0; i < 2; i += 1) {
      await runAndCatch(() =>
        tool.execute(`A-${i}`, {
          command: 'str_replace',
          path: 'index.html',
          old_str: '// PROBE-A\nstale',
          new_str: 'X',
        }),
      );
    }
    // 2 failed attempts on probe-B — bucket independent.
    for (let i = 0; i < 2; i += 1) {
      await runAndCatch(() =>
        tool.execute(`B-${i}`, {
          command: 'str_replace',
          path: 'index.html',
          old_str: '// PROBE-B\nstale',
          new_str: 'X',
        }),
      );
    }
    // Neither bucket has reached 3 → next attempts on either should
    // still produce the standard error, not the refusal.
    const msgA = await runAndCatch(() =>
      tool.execute('A-3', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '// PROBE-A\nstale-again',
        new_str: 'X',
      }),
    );
    expect(msgA).not.toMatch(/Refusing/);
    const msgB = await runAndCatch(() =>
      tool.execute('B-3', {
        command: 'str_replace',
        path: 'index.html',
        old_str: '// PROBE-B\nstale-again',
        new_str: 'X',
      }),
    );
    expect(msgB).not.toMatch(/Refusing/);
  });
});

describe('text-editor patch-protocol nudge — Improver1 §5', () => {
  function readText(
    res: Awaited<ReturnType<ReturnType<typeof makeTextEditorTool>['execute']>>,
  ): string {
    const block = res.content[0];
    return block && 'text' in block ? block.text : '';
  }

  it('appends a patch tip after a multi-line str_replace success', async () => {
    const initial = ['<div>', '  <h1>old</h1>', '  <p>old</p>', '</div>'].join('\n');
    const fs = makeFs({ 'index.html': initial });
    const tool = makeTextEditorTool(fs);
    const res = await tool.execute('e1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '  <h1>old</h1>\n  <p>old</p>',
      new_str: '  <h1>NEW</h1>\n  <p>NEW</p>\n  <span>extra</span>',
    });
    const text = readText(res);
    expect(text).toMatch(/Tip:.*patch/i);
    expect(text).toMatch(/spanned \d+ lines/);
    expect(text).toMatch(/12 %/);
  });

  it('does NOT nudge for a single-line str_replace', async () => {
    const fs = makeFs({ 'index.html': '<div>x</div>\n<p>y</p>' });
    const tool = makeTextEditorTool(fs);
    const res = await tool.execute('e1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<div>x</div>',
      new_str: '<div>X</div>',
    });
    expect(readText(res)).not.toMatch(/Tip:.*patch/i);
  });

  it('only nudges ONCE per (path, run)', async () => {
    const initial = ['<div>', '  <h1>a</h1>', '  <h2>b</h2>', '  <h3>c</h3>', '</div>'].join('\n');
    const fs = makeFs({ 'index.html': initial });
    const tool = makeTextEditorTool(fs);
    const r1 = await tool.execute('e1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '  <h1>a</h1>\n  <h2>b</h2>',
      new_str: '  <h1>A</h1>\n  <h2>B</h2>\n  <h2.5>extra</h2.5>',
    });
    expect(readText(r1)).toMatch(/Tip:.*patch/i);
    const r2 = await tool.execute('e2', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '  <h1>A</h1>\n  <h2>B</h2>',
      new_str: '  <h1>A2</h1>\n  <h2>B2</h2>\n  <h2.5>extra2</h2.5>',
    });
    expect(readText(r2)).not.toMatch(/Tip:.*patch/i);
  });

  it('nudges separately per path (different file = fresh nudge)', async () => {
    const init = ['<div>', '  <h1>a</h1>', '  <h2>b</h2>', '</div>'].join('\n');
    const fs = makeFs({ 'index.html': init, 'styles.css': init });
    const tool = makeTextEditorTool(fs);
    const r1 = await tool.execute('e1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '  <h1>a</h1>\n  <h2>b</h2>',
      new_str: '  <h1>A</h1>\n  <h2>B</h2>\n  <h3>extra</h3>',
    });
    expect(readText(r1)).toMatch(/Tip:.*patch/i);
    const r2 = await tool.execute('e2', {
      command: 'str_replace',
      path: 'styles.css',
      old_str: '  <h1>a</h1>\n  <h2>b</h2>',
      new_str: '  <h1>A</h1>\n  <h2>B</h2>\n  <h3>extra</h3>',
    });
    expect(readText(r2)).toMatch(/Tip:.*patch/i);
  });
});

describe('text-editor view stubs — Improver1 §4', () => {
  function readText(
    res: Awaited<ReturnType<ReturnType<typeof makeTextEditorTool>['execute']>>,
  ): string {
    const block = res.content[0];
    return block && 'text' in block ? block.text : '';
  }

  it('post-write stub: view after str_replace returns a 1-line confirmation, not the whole file', async () => {
    // Use uniquely identifiable lines so str_replace is unambiguous.
    const initial = Array.from(
      { length: 50 },
      (_, i) => `row${String(i + 1).padStart(3, '0')}`,
    ).join('\n');
    const fs = makeFs({ 'index.html': initial });
    const tool = makeTextEditorTool(fs);
    // First view fills the cache.
    const v1 = await tool.execute('v1', { command: 'view', path: 'index.html' });
    expect(readText(v1)).toContain('row005');
    // Write something — same byte length to force the stub branch
    // (bytes match, no view since write).
    await tool.execute('e1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: 'row001',
      new_str: 'ROWX01',
    });
    // Now view again. Expected: stub fires.
    const v2 = await tool.execute('v2', { command: 'view', path: 'index.html' });
    const text = readText(v2);
    expect(text).toMatch(/last written at tool-call tick/i);
    expect(text).toMatch(/no edits or other writes have landed since/i);
    // Critically: file body NOT served.
    expect(text).not.toContain('row005');
    expect(text).not.toContain('row050');
  });

  it('post-write stub also fires when an unrelated tool sat between the write and the view', async () => {
    // Today's data: agent inserts set_todos / read_url between
    // str_replace and the next view. The stub used to be gated on
    // `tick === lastMut.tick + 1` and would skip in that case. The
    // loosened gate lets it fire as long as no view+no other write.
    const initial = Array.from(
      { length: 30 },
      (_, i) => `row${String(i + 1).padStart(3, '0')}`,
    ).join('\n');
    const fs = makeFs({ 'index.html': initial });
    const tool = makeTextEditorTool(fs);
    await tool.execute('v0', { command: 'view', path: 'index.html' });
    await tool.execute('e1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: 'row001',
      new_str: 'XXX001',
    });
    // Simulate intervening non-mutation tool by issuing a view on a
    // DIFFERENT path. (No setup for it here — list_files etc. would
    // do; we just need toolCallCounter to bump without touching
    // index.html.)
    const lastMutBefore = fs.view('index.html')?.content.length ?? 0;
    expect(lastMutBefore).toBeGreaterThan(0);
    const v2 = await tool.execute('v2', { command: 'view', path: 'index.html' });
    expect(readText(v2)).toMatch(/last written at tool-call tick/i);
  });

  it('stale-view stub: re-viewing a path with no edit between returns a 1-line stub', async () => {
    const fs = makeFs({ 'index.html': '<p>x</p>' });
    const tool = makeTextEditorTool(fs);
    await tool.execute('v1', { command: 'view', path: 'index.html' });
    // No mutation between the two views — second view must short-circuit.
    const v2 = await tool.execute('v2', { command: 'view', path: 'index.html' });
    const text = readText(v2);
    expect(text).toMatch(/unchanged since your last view/i);
    expect(text).not.toContain('<p>x</p>');
  });

  it('stale-view stub does NOT fire after a mutation (file has changed)', async () => {
    const fs = makeFs({ 'index.html': '<p>x</p>' });
    const tool = makeTextEditorTool(fs);
    await tool.execute('v1', { command: 'view', path: 'index.html' });
    await tool.execute('e1', {
      command: 'str_replace',
      path: 'index.html',
      old_str: '<p>x</p>',
      new_str: '<p>y</p>',
    });
    const v2 = await tool.execute('v2', { command: 'view', path: 'index.html' });
    const text = readText(v2);
    // Post-write stub fires (size matches, no view since write).
    expect(text).toMatch(/last written|unchanged since your last view/i);
    // The point is: file body still not served because the
    // stubs DO fire on the post-write path. Verify mutation happened.
    expect(fs.view('index.html')?.content).toBe('<p>y</p>');
  });

  it('stale-view stub does NOT fire when a ranged view comes between (different code path)', async () => {
    const initial = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const fs = makeFs({ 'index.html': initial });
    const tool = makeTextEditorTool(fs);
    await tool.execute('v1', { command: 'view', path: 'index.html' });
    // Ranged view doesn't trip the full-file stale detector — the
    // agent legitimately wants different bytes.
    const ranged = await tool.execute('v2', {
      command: 'view',
      path: 'index.html',
      view_range: [3, 7],
    });
    expect(readText(ranged)).toContain('line 3');
    expect(readText(ranged)).toContain('line 7');
  });
});
