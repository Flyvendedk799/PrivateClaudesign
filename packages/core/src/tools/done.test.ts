import { describe, expect, it, vi } from 'vitest';
import { HEURISTIC_ADVISORY_SOURCES } from './done-heuristics.js';
import { makeDoneTool } from './done.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

/** Strip out the (always-advisory) heuristic warnings so a "no fatal errors"
 *  assertion isn't broken by content/a11y/responsive guidance that fires
 *  on every minimal test fixture. */
function fatalErrors(errors: ReadonlyArray<{ source?: string }>) {
  return errors.filter(
    (e) => e.source !== 'console.warning' && !HEURISTIC_ADVISORY_SOURCES.has(e.source ?? ''),
  );
}

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

describe('done tool', () => {
  it('returns ok when index.html parses cleanly', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('id1', { summary: 'shipped' });
    expect(res.details.status).toBe('ok');
    expect(fatalErrors(res.details.errors)).toHaveLength(0);
    expect(res.details.summary).toBe('shipped');
  });

  it('reports has_errors with line numbers when tags are unbalanced', async () => {
    const fs = makeFs({
      'index.html': '<!doctype html><html><body>\n<section>\n<div>\n</body></html>',
    });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('id2', {});
    expect(res.details.status).toBe('has_errors');
    expect(res.details.errors.some((e) => /Unclosed/.test(e.message))).toBe(true);
  });

  it('reports has_errors when target file is missing', async () => {
    const fs = makeFs();
    const tool = makeDoneTool(fs);
    const res = await tool.execute('id3', {});
    expect(res.details.status).toBe('has_errors');
    expect(res.details.errors[0]?.message).toMatch(/File not found/);
  });

  it('flags duplicate ids and missing alt', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html><body><div id="x"></div><div id="x"></div><img src="a.png"></body></html>',
    });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('id4', {});
    expect(res.details.status).toBe('has_errors');
    expect(res.details.errors.some((e) => /Duplicate id/.test(e.message))).toBe(true);
    expect(res.details.errors.some((e) => /alt/.test(e.message))).toBe(true);
  });

  it('merges runtime verifier errors with static lint output', async () => {
    // Syntactically clean HTML — static lint passes — but runtime verifier
    // (host-injected stub here) reports a ReferenceError as if the JSX
    // failed at mount time. Assert both make it into the merged result.
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const runtimeVerify = vi.fn(async () => [
      {
        message: 'ReferenceError: TWEAK_DEFAULT is not defined',
        source: 'console.error',
        lineno: 12,
      },
    ]);
    const tool = makeDoneTool(fs, runtimeVerify);
    const res = await tool.execute('id5', { summary: 'shipped' });
    expect(runtimeVerify).toHaveBeenCalledOnce();
    expect(res.details.status).toBe('has_errors');
    expect(res.details.errors.some((e) => /ReferenceError/.test(e.message))).toBe(true);
    expect(res.details.errors.some((e) => e.source === 'console.error')).toBe(true);
  });

  it('returns ok when runtime verifier reports no errors', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const runtimeVerify = vi.fn(async () => []);
    const tool = makeDoneTool(fs, runtimeVerify);
    const res = await tool.execute('id6', {});
    expect(res.details.status).toBe('ok');
    expect(fatalErrors(res.details.errors)).toHaveLength(0);
    expect(res.content[0]?.type).toBe('text');
  });

  it('first ok call returns terminal-stop text (not the old polite "ok — no issues" line)', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('id-first-ok', {});
    expect(res.details.status).toBe('ok');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^ACCEPTED/);
    expect(text).toContain('Do NOT call `done`');
  });

  it('second call after ok throws with explicit stop guidance', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const tool = makeDoneTool(fs);
    const first = await tool.execute('id-call-1', {});
    expect(first.details.status).toBe('ok');
    await expect(tool.execute('id-call-2', {})).rejects.toThrow(/already accepted/i);
    await expect(tool.execute('id-call-3', {})).rejects.toThrow(/do not call/i);
  });

  it('acceptance fires at the FIRST ok, even after preceding has_errors calls', async () => {
    let runtimeOk = false;
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const tool = makeDoneTool(fs, async () =>
      runtimeOk ? [] : [{ message: 'console error 1', source: 'console.error' }],
    );

    const r1 = await tool.execute('c1', {});
    expect(r1.details.status).toBe('has_errors');

    const r2 = await tool.execute('c2', {});
    expect(r2.details.status).toBe('has_errors');

    runtimeOk = true;
    const r3 = await tool.execute('c3', {});
    expect(r3.details.status).toBe('ok');
    expect((r3.content[0] as { text: string }).text).toMatch(/^ACCEPTED/);

    // Any further call should fast-fail.
    await expect(tool.execute('c4', {})).rejects.toThrow(/already accepted/i);
  });

  it('separate makeDoneTool instances each get their own acceptance state', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const toolA = makeDoneTool(fs);
    const toolB = makeDoneTool(fs);
    await toolA.execute('a1', {});
    await expect(toolA.execute('a2', {})).rejects.toThrow(/already accepted/i);
    const b1 = await toolB.execute('b1', {});
    expect(b1.details.status).toBe('ok'); // tool B starts fresh — own counter
  });

  // Removed 2026-04-28: the static "Unexpected content after ReactDOM..."
  // and bracket-balance heuristics ran on the WHOLE file (HTML + JSX) and
  // produced repeated false positives on valid artifacts — JSX text content
  // and the trailing `</script></body></html>` confused both checks. Babel
  // is the actual parser at runtime; real syntax errors surface via
  // console.error in the BrowserWindow verifier. See findJsxStructuralIssues
  // in done.ts for the rationale.

  it('does NOT flag a valid JSX artifact wrapped in HTML even though the source ends with </html>', async () => {
    const fs = makeFs({
      'index.html': `<!doctype html><html lang="en"><body>
<div id="root"></div>
<script type="text/babel">
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{}/*EDITMODE-END*/;
function App() { return <div>Hi</div>; }
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script>
</body></html>`,
    });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('id-jsx-html-wrapper', {});
    // No "Unexpected content", no "Unbalanced parens/braces" — this is the
    // exact shape the agent emits for the iPhone-frame template (see
    // 2026-04-28 trace moix9ivu) which previously caused 3 retry loops.
    expect(res.details.errors.some((e) => /Unexpected content after/.test(e.message))).toBe(false);
    expect(res.details.errors.some((e) => /Unbalanced/.test(e.message))).toBe(false);
  });

  it('flags missing ReactDOM.createRoot call when content is JSX-shaped', async () => {
    const fs = makeFs({
      'index.html': `const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{}/*EDITMODE-END*/;
function App() { return <div>Hi</div>; }`,
    });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('id-syntax-no-root', {});
    expect(res.details.status).toBe('has_errors');
    expect(res.details.errors.some((e) => /Missing ReactDOM\.createRoot/.test(e.message))).toBe(
      true,
    );
  });

  it('treats console.warning runtime errors as advisory (status stays ok)', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const runtimeVerify = vi.fn(async () => [
      { message: 'componentWillMount is deprecated', source: 'console.warning', lineno: 5 },
    ]);
    const tool = makeDoneTool(fs, runtimeVerify);
    const res = await tool.execute('id-warning-only', {});
    expect(res.details.status).toBe('ok');
    // The warning still appears in errors[] for transparency, just not fatal.
    // Heuristic advisories also fire on this minimal fixture, so filter to the
    // warning we explicitly seeded via the runtime verifier.
    const consoleWarnings = res.details.errors.filter((e) => e.source === 'console.warning');
    expect(consoleWarnings).toHaveLength(1);
    expect((res.content[0] as { text: string }).text).toMatch(/Non-fatal warning/i);
  });

  it('mixes advisory warning with fatal error — fatal still flips status to has_errors', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const runtimeVerify = vi.fn(async () => [
      { message: 'deprecated API', source: 'console.warning' },
      { message: 'ReferenceError: X is not defined', source: 'console.error' },
    ]);
    const tool = makeDoneTool(fs, runtimeVerify);
    const res = await tool.execute('id-mixed', {});
    expect(res.details.status).toBe('has_errors');
    // Only the fatal one shows in the response text body.
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/ReferenceError/);
    expect(text).not.toMatch(/deprecated API/);
  });

  it('force-accepts after MAX_HAS_ERRORS_ROUNDS (3) fatal rounds', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const runtimeVerify = vi.fn(async () => [
      { message: 'persistent runtime error', source: 'console.error' },
    ]);
    const tool = makeDoneTool(fs, runtimeVerify);

    // Three has_errors rounds — model "fixed" but verifier still fails.
    for (let i = 0; i < 3; i += 1) {
      const r = await tool.execute(`r${i}`, {});
      expect(r.details.status).toBe('has_errors');
    }
    // The 4th call force-accepts.
    const r4 = await tool.execute('r4', {});
    expect(r4.details.status).toBe('ok');
    const text = (r4.content[0] as { text: string }).text;
    expect(text).toMatch(/best-effort/);
    expect(text).toMatch(/persistent runtime error/);
    // Subsequent calls fast-fail per the existing terminal-stop guard.
    await expect(tool.execute('r5', {})).rejects.toThrow(/already accepted/i);
  });

  it('emits structured force_accept telemetry when the threshold trips', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const runtimeVerify = vi.fn(async () => [
      { message: 'unfixable error', source: 'console.error' },
    ]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tool = makeDoneTool(fs, runtimeVerify, logger);

    // 3 has_errors → no log yet.
    for (let i = 0; i < 3; i += 1) {
      await tool.execute(`fa${i}`, {});
    }
    expect(logger.warn).not.toHaveBeenCalledWith('done.force_accept', expect.anything());

    // 4th call force-accepts and emits.
    await tool.execute('fa3', {});
    expect(logger.warn).toHaveBeenCalledWith(
      'done.force_accept',
      expect.objectContaining({
        path: 'index.html',
        hasErrorsRounds: 3,
        totalCalls: 4,
        fatalCount: expect.any(Number),
        unresolvedSample: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('unfixable error') }),
        ]),
      }),
    );
  });

  it('treats missing local refs (multi-file pattern) as fatal via scanLocalRefs', async () => {
    // Vanilla pattern: index.html references styles.css and app.js but only
    // styles.css exists in the fs. done should flag app.js as missing and
    // return has_errors so the model creates the file before re-running.
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>Hi</h1><script src="app.js"></script></main></body></html>',
      'styles.css': 'body { background: #fff; color: #111; }',
    });
    // Override the test fs's listDir so it surfaces the staged files.
    const realListDir = fs.listDir;
    fs.listDir = () => ['index.html', 'styles.css'];
    const tool = makeDoneTool(fs);
    const res = await tool.execute('mf-missing', {});
    expect(res.details.status).toBe('has_errors');
    expect(
      res.details.errors.some(
        (e) => e.source === 'multifile.missing_ref' && /app\.js/.test(e.message),
      ),
    ).toBe(true);
    fs.listDir = realListDir;
  });

  it('passes when every referenced local file exists in the design fs', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>Hi</h1><script src="app.js"></script></main></body></html>',
      'styles.css': 'body { background: #fff; color: #111; }',
      'app.js': 'console.log("ok");',
    });
    fs.listDir = () => ['index.html', 'styles.css', 'app.js'];
    const tool = makeDoneTool(fs);
    const res = await tool.execute('mf-ok', {});
    expect(res.details.errors.some((e) => e.source === 'multifile.missing_ref')).toBe(false);
  });

  it('escalates the throw message once total calls exceed the runaway cap', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const tool = makeDoneTool(fs);
    // First call accepts; calls 2-6 throw the short "already accepted" message.
    const ok = await tool.execute('e1', {});
    expect(ok.details.status).toBe('ok');
    for (let i = 2; i <= 6; i += 1) {
      await expect(tool.execute(`e${i}`, {})).rejects.toThrow(/already accepted/i);
    }
    // Call #7 escalates to RUNAWAY.
    await expect(tool.execute('e7', {})).rejects.toThrow(/RUNAWAY/);
  });

  it('warns the agent on the last attempt before force-accept fires', async () => {
    const fs = makeFs({
      'index.html':
        '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>',
    });
    const runtimeVerify = vi.fn(async () => [{ message: 'broken', source: 'console.error' }]);
    const tool = makeDoneTool(fs, runtimeVerify);
    const r1 = await tool.execute('w1', {});
    expect((r1.content[0] as { text: string }).text).toMatch(/2 fix attempts remaining/);
    const r2 = await tool.execute('w2', {});
    expect((r2.content[0] as { text: string }).text).toMatch(/1 fix attempt remaining/);
    const r3 = await tool.execute('w3', {});
    expect((r3.content[0] as { text: string }).text).toMatch(/LAST fix attempt/);
  });
});

describe('Babel-aware static lint (backlog-1 #10)', () => {
  it('skips findUnclosedTags for JSX (self-closing component tags are not HTML)', async () => {
    // Component-style self-closing <Header /> would be flagged as unclosed
    // by findUnclosedTags before #10 — the agent then "fixes" perfectly
    // valid JSX into a state that breaks Babel. Skipping the HTML check
    // for JSX artifacts stops the loop.
    const jsx = [
      '<!doctype html><html><body><div id="root"></div>',
      '<script type="text/babel">',
      'function App() { return <Header /> }',
      'ReactDOM.createRoot(document.getElementById("root")).render(<App />);',
      '</script></body></html>',
    ].join('\n');
    const fs = makeFs({ 'index.html': jsx });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('jsx-self', {});
    expect(res.details.errors.some((e) => /Unclosed/.test(e.message))).toBe(false);
  });

  it('skips findMissingAlt for JSX (component <Image/> is not an HTML <img>)', async () => {
    const jsx = [
      '<!doctype html><html><body><div id="root"></div>',
      '<script type="text/babel">',
      'function App() { return <Image src="hero.png" /> }',
      'ReactDOM.createRoot(document.getElementById("root")).render(<App />);',
      '</script></body></html>',
    ].join('\n');
    const fs = makeFs({ 'index.html': jsx });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('jsx-img', {});
    expect(res.details.errors.some((e) => /alt/.test(e.message))).toBe(false);
  });

  it('still flags duplicate ids inside JSX (the rule is valid in either runtime)', async () => {
    const jsx = [
      '<!doctype html><html><body><div id="root"></div>',
      '<script type="text/babel">',
      'function App() {',
      '  return <div><span id="dup">a</span><span id="dup">b</span></div>;',
      '}',
      'ReactDOM.createRoot(document.getElementById("root")).render(<App />);',
      '</script></body></html>',
    ].join('\n');
    const fs = makeFs({ 'index.html': jsx });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('jsx-dup', {});
    expect(res.details.errors.some((e) => /Duplicate id/.test(e.message))).toBe(true);
  });

  it('pure HTML still gets the HTML-only checks (regression guard)', async () => {
    const html = '<!doctype html><html><body>\n<section>\n<div>\n</body></html>';
    const fs = makeFs({ 'index.html': html });
    const tool = makeDoneTool(fs);
    const res = await tool.execute('html-unclosed', {});
    expect(res.details.errors.some((e) => /Unclosed/.test(e.message))).toBe(true);
  });
});
