/**
 * Tests for `inlineLocalSidecars` (vanilla-pattern multi-source-file
 * inliner). Cross-checked against real Claude Design exports
 * (Neurolayer.zip): minimal index.html that references styles.css and
 * multiple .js files, plus external CDN refs (Three.js from unpkg, fonts
 * from Google).
 */

import { describe, expect, it } from 'vitest';
import { inlineLocalSidecars, resolveLocalAssetRefs } from './sidecar-inliner';

describe('inlineLocalSidecars — vanilla-pattern multi-file inliner', () => {
  it('inlines a local <link rel="stylesheet"> as a <style> block', () => {
    const html = `<head><link rel="stylesheet" href="styles.css"></head><body></body>`;
    const fs = new Map([['styles.css', 'body { color: red; }']]);
    const out = inlineLocalSidecars(html, fs);
    expect(out).toContain('<style data-inlined="styles.css">');
    expect(out).toContain('body { color: red; }');
    expect(out).not.toContain('<link rel="stylesheet" href="styles.css">');
  });

  it('inlines a local <script src=> as an inline <script>', () => {
    const html = `<body><script src="app.js"></script></body>`;
    const fs = new Map([['app.js', 'console.log("hi")']]);
    const out = inlineLocalSidecars(html, fs);
    expect(out).toContain('<script data-inlined="app.js">');
    expect(out).toContain('console.log("hi")');
    expect(out).not.toContain('<script src="app.js">');
  });

  it('preserves multiple scripts in source order', () => {
    const html = `<body>
<script src="data.js"></script>
<script src="app.js"></script>
</body>`;
    const fs = new Map([
      ['data.js', '/* DATA */'],
      ['app.js', '/* APP */'],
    ]);
    const out = inlineLocalSidecars(html, fs);
    const dataIdx = out.indexOf('/* DATA */');
    const appIdx = out.indexOf('/* APP */');
    expect(dataIdx).toBeGreaterThan(0);
    expect(appIdx).toBeGreaterThan(dataIdx);
  });

  it('leaves CDN <script src="https://...">  untouched', () => {
    const html = `<body><script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script></body>`;
    const out = inlineLocalSidecars(html, new Map());
    expect(out).toContain('https://unpkg.com/three@0.160.0/build/three.min.js');
    expect(out).not.toContain('data-inlined');
  });

  it('leaves protocol-relative // refs untouched', () => {
    const html = `<body><script src="//cdn.example.com/x.js"></script></body>`;
    const out = inlineLocalSidecars(html, new Map());
    expect(out).toContain('//cdn.example.com/x.js');
  });

  it('leaves Google Fonts <link href="https://fonts...">  untouched', () => {
    const html = `<head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>`;
    const out = inlineLocalSidecars(html, new Map());
    expect(out).toContain('fonts.googleapis.com');
    expect(out).not.toContain('data-inlined');
  });

  it('tolerates ?cache-bust query suffix on local refs (Claude-Design parity)', () => {
    const html = `<head><link rel="stylesheet" href="styles.css?v=51"></head>`;
    const fs = new Map([['styles.css', 'body{}']]);
    const out = inlineLocalSidecars(html, fs);
    expect(out).toContain('<style data-inlined="styles.css">');
    expect(out).toContain('body{}');
  });

  it('escapes </script> inside inlined JS to prevent block escape', () => {
    const html = `<body><script src="naughty.js"></script></body>`;
    // A string containing the literal `</script>` would, if not escaped,
    // terminate the inline block early and dump the rest as HTML.
    const fs = new Map([['naughty.js', `const html = '</script><b>oops</b>';`]]);
    const out = inlineLocalSidecars(html, fs);
    expect(out).toContain('<\\/script>');
    expect(out).not.toContain("'</script>");
  });

  it('escapes </style> inside inlined CSS', () => {
    const html = `<head><link rel="stylesheet" href="styles.css"></head>`;
    const fs = new Map([['styles.css', `body::before { content: "</style>"; }`]]);
    const out = inlineLocalSidecars(html, fs);
    expect(out).toContain('<\\/style>');
  });

  it('is a no-op on JSX-pattern HTML (no <link> or <script src> to local files)', () => {
    const jsx = `<!doctype html>
<html><head><script>window.x = 1</script></head>
<body><div id="root"></div></body></html>`;
    const out = inlineLocalSidecars(jsx, new Map([['some-other-file.css', 'ignored']]));
    expect(out).toBe(jsx);
  });

  it('skips local refs missing from fsMap (leaves the tag alone)', () => {
    const html = `<head><link rel="stylesheet" href="missing.css"></head>`;
    const out = inlineLocalSidecars(html, new Map());
    expect(out).toContain('<link rel="stylesheet" href="missing.css">');
  });

  it('handles the canonical Claude Design index.html shape end-to-end', () => {
    // Modeled on Neurolayer.zip's Mindspace.html: external Google Fonts +
    // local stylesheet + Three.js CDN + multiple local scripts.
    const html = `<!doctype html>
<html><head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
  <link rel="stylesheet" href="styles.css?v=51">
</head><body>
  <div id="stage"></div>
  <script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
  <script src="case-data.js?v=53"></script>
  <script src="mindspace.js?v=53"></script>
  <script src="ui.js?v=53"></script>
</body></html>`;
    const fs = new Map([
      ['styles.css', '/* tokens */'],
      ['case-data.js', 'window.CASE = {}'],
      ['mindspace.js', 'window.START = () => {}'],
      ['ui.js', 'window.UI = {}'],
    ]);
    const out = inlineLocalSidecars(html, fs);
    // External refs preserved
    expect(out).toContain('fonts.googleapis.com');
    expect(out).toContain('unpkg.com/three');
    // Local refs inlined
    expect(out).toContain('<style data-inlined="styles.css">');
    expect(out).toContain('/* tokens */');
    expect(out).toContain('<script data-inlined="case-data.js">');
    expect(out).toContain('window.CASE = {}');
    expect(out).toContain('<script data-inlined="mindspace.js">');
    expect(out).toContain('<script data-inlined="ui.js">');
    // Order preserved (Three.js before case-data before mindspace before ui)
    const threeIdx = out.indexOf('unpkg.com/three');
    const caseIdx = out.indexOf('window.CASE');
    const startIdx = out.indexOf('window.START');
    const uiIdx = out.indexOf('window.UI');
    expect(threeIdx).toBeGreaterThan(0);
    expect(caseIdx).toBeGreaterThan(threeIdx);
    expect(startIdx).toBeGreaterThan(caseIdx);
    expect(uiIdx).toBeGreaterThan(startIdx);
  });
});

describe('inlineLocalSidecars + resolveLocalAssetRefs interaction', () => {
  it('resolves assets/ refs INSIDE inlined CSS (e.g. background: url(assets/bg.png))', () => {
    const html = `<head><link rel="stylesheet" href="styles.css"></head>`;
    const fs = new Map([
      ['styles.css', `body { background: url('assets/bg.png') }`],
      ['assets/bg.png', 'data:image/png;base64,IGNORED'],
    ]);
    // Mirror the order used in main: inline first, then resolveLocalAssetRefs.
    const out = resolveLocalAssetRefs(inlineLocalSidecars(html, fs), fs);
    expect(out).toContain('data:image/png;base64,IGNORED');
    expect(out).not.toContain("'assets/bg.png'");
  });
});
