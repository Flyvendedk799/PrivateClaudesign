import { describe, expect, it } from 'vitest';
import { buildSrcdoc, extractAndUpgradeArtifact, inlineLocalRefs } from './index';

describe('buildSrcdoc', () => {
  it('strips CSP meta tags', () => {
    const html =
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src none"></head><body></body></html>';
    const out = buildSrcdoc(html);
    expect(out).not.toContain('Content-Security-Policy');
  });

  it('keeps legacy full-HTML documents as HTML but injects the preview overlay', () => {
    // Snapshots written before the JSX-only switchover contain raw HTML
    // documents. Wrapping those as JSX makes Babel bark on the DOCTYPE /
    // <html> tokens, so buildSrcdoc injects the preview overlay without
    // routing them through the React+Babel wrapper.
    const html = '<html><body><p>x</p></body></html>';
    const out = buildSrcdoc(html);
    expect(out).toContain('<p>x</p>');
    expect(out).toContain('CODESIGN_OVERLAY_SCRIPT');
    expect(out).toContain('ELEMENT_SELECTED');
    expect(out).not.toContain('AGENT_BODY_BEGIN');

    const doctyped = '<!DOCTYPE html><html><body><p>y</p></body></html>';
    const doctypedOut = buildSrcdoc(doctyped);
    expect(doctypedOut).toContain('<p>y</p>');
    expect(doctypedOut).toContain('CODESIGN_OVERLAY_SCRIPT');
    expect(doctypedOut).not.toContain('AGENT_BODY_BEGIN');
  });

  it('does not duplicate the overlay when a full-HTML document is rebuilt', () => {
    const once = buildSrcdoc('<html><body><p>x</p></body></html>');
    const twice = buildSrcdoc(once);
    expect(twice).toBe(once);
  });

  it('wraps a fragment via the JSX path (no legacy HTML branch)', () => {
    const out = buildSrcdoc('<div>plain</div>');
    expect(out).toContain('AGENT_BODY_BEGIN');
    expect(out).toContain('<script type="text/babel"');
    expect(out).toContain('<div>plain</div>');
  });
});

describe('buildSrcdoc — JSX path', () => {
  const jsxArtifact = `const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{"a":1}/*EDITMODE-END*/;
function App() { return <div>hi</div>; }
ReactDOM.createRoot(document.getElementById("root")).render(<App/>);`;

  it('routes JSX artifacts through the React+Babel template', () => {
    const out = buildSrcdoc(jsxArtifact);
    expect(out).toContain('AGENT_BODY_BEGIN');
    expect(out).toContain('AGENT_BODY_END');
    expect(out).toContain('text/babel');
    // Vendored runtime + frame snippets must be inlined.
    expect(out).toContain('IOSDevice');
    expect(out).toContain('DesignCanvas');
    // Overlay still present so element-selection / error reporting work.
    expect(out).toContain('ELEMENT_SELECTED');
    // The agent's payload is embedded between the markers.
    expect(out).toContain('TWEAK_DEFAULTS');
  });

  it('detects JSX via ReactDOM.createRoot signature even without EDITMODE', () => {
    const src = `function App() { return <div/>; } ReactDOM.createRoot(document.getElementById("root")).render(<App/>);`;
    const out = buildSrcdoc(src);
    expect(out).toContain('AGENT_BODY_BEGIN');
  });

  it('extractAndUpgradeArtifact wraps JSX payloads', () => {
    const wrapped = extractAndUpgradeArtifact(jsxArtifact);
    expect(wrapped).toContain('AGENT_BODY_BEGIN');
    expect(wrapped).toContain('TWEAK_DEFAULTS');
  });

  it('extractAndUpgradeArtifact also wraps bare HTML (JSX-only contract)', () => {
    const wrapped = extractAndUpgradeArtifact('<html><body>x</body></html>');
    expect(wrapped).toContain('AGENT_BODY_BEGIN');
    expect(wrapped).toContain('<script type="text/babel"');
  });

  it('extractAndUpgradeArtifact passes already-wrapped payloads through unchanged', () => {
    const wrapped = extractAndUpgradeArtifact(jsxArtifact);
    const wrappedTwice = extractAndUpgradeArtifact(wrapped);
    expect(wrappedTwice).toBe(wrapped);
  });

  it('buildSrcdoc passes already-wrapped payloads through unchanged', () => {
    const wrapped = buildSrcdoc(jsxArtifact);
    const wrappedTwice = buildSrcdoc(wrapped);
    expect(wrappedTwice).toBe(wrapped);
  });

  it('enables the transform-react-jsx-source plugin on the agent script', () => {
    // Plugin is required so React.createElement calls receive __source props
    // with line numbers — input to the data-src-line tagger that powers the
    // follow-the-edit cursor.
    const out = buildSrcdoc(jsxArtifact);
    expect(out).toContain('data-plugins="transform-react-jsx-source"');
  });

  it('injects the data-src-line tagger before the agent script (ordering matters)', () => {
    // The tagger patches React.createElement; if the agent's text/babel
    // script were transpiled and run first, the patch wouldn't see the
    // initial render's createElement calls. Order: tagger → babel → agent.
    const out = buildSrcdoc(jsxArtifact);
    const taggerIdx = out.indexOf('__codesignSrcLineWrapped');
    const agentScriptIdx = out.indexOf('AGENT_BODY_BEGIN');
    expect(taggerIdx).toBeGreaterThan(0);
    expect(agentScriptIdx).toBeGreaterThan(0);
    expect(taggerIdx).toBeLessThan(agentScriptIdx);
  });
});

describe('inlineLocalRefs (multi-file srcdoc fallback)', () => {
  it('inlines a relative <link rel="stylesheet" href="X.css">', () => {
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css" /></head><body></body></html>';
    const out = inlineLocalRefs(html, { 'styles.css': 'body{color:red}' });
    expect(out).toContain('<style');
    expect(out).toContain('body{color:red}');
    expect(out).not.toContain('href="styles.css"');
    expect(out).toContain('data-codesign-inlined-from="styles.css"');
  });

  it('inlines a relative <script src="X.js">', () => {
    const html =
      '<!doctype html><html><body><div id="app"></div><script src="app.js"></script></body></html>';
    const out = inlineLocalRefs(html, { 'app.js': 'console.log("ok")' });
    expect(out).toContain('console.log("ok")');
    expect(out).not.toContain('src="app.js"');
    expect(out).toContain('data-codesign-inlined-from="app.js"');
  });

  it('preserves CDN <script src="https://...">', () => {
    const html =
      '<!doctype html><html><body><script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script></body></html>';
    const out = inlineLocalRefs(html, { 'three.min.js': 'BUSTED' });
    // Absolute URL keys never match — leave the tag alone.
    expect(out).toContain('https://unpkg.com/three');
    expect(out).not.toContain('BUSTED');
  });

  it('leaves preconnect / preload <link> tags alone (only stylesheet rel matters)', () => {
    const html =
      '<!doctype html><html><head><link rel="preconnect" href="https://fonts.googleapis.com" /></head></html>';
    const out = inlineLocalRefs(html, { 'fonts.googleapis.com': 'X' });
    expect(out).toContain('rel="preconnect"');
    expect(out).not.toContain('<style');
  });

  it('leaves missing sidecars in place so the iframe surfaces a 404 path', () => {
    const html =
      '<!doctype html><html><body><script src="data.js"></script><script src="app.js"></script></body></html>';
    const out = inlineLocalRefs(html, { 'app.js': 'ok' });
    expect(out).toContain('src="data.js"');
    expect(out).toContain('ok');
  });

  it('strips type="module" semantics from inlined scripts', () => {
    const html =
      '<!doctype html><html><body><script type="module" src="main.js"></script></body></html>';
    const out = inlineLocalRefs(html, { 'main.js': 'export const x = 1;' });
    // The inlined tag must NOT carry type="module" — without a base URL
    // the import would fail anyway. Our replacement drops the original
    // attrs entirely.
    expect(out).not.toMatch(/<script[^>]*type=["']module["']/);
    expect(out).toContain('export const x = 1');
  });

  it('returns html unchanged when sidecars is empty', () => {
    const html = '<!doctype html><html><body><script src="app.js"></script></body></html>';
    expect(inlineLocalRefs(html, {})).toBe(html);
  });

  it('handles single-quote attribute values', () => {
    const html =
      "<!doctype html><html><head><link rel='stylesheet' href='styles.css' /></head></html>";
    const out = inlineLocalRefs(html, { 'styles.css': 'body{}' });
    expect(out).toContain('<style');
    expect(out).toContain('body{}');
  });

  it('refuses to inline game-files:// or design-files:// scheme refs', () => {
    const html =
      '<!doctype html><html><body><script src="design-files://designs/x/app.js"></script></body></html>';
    const out = inlineLocalRefs(html, { 'design-files://designs/x/app.js': 'BUSTED' });
    expect(out).toContain('design-files://');
    expect(out).not.toContain('BUSTED');
  });
});

describe('buildSrcdoc with sidecars option', () => {
  it('inlines local refs before injecting the overlay on legacy HTML', () => {
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css" /></head><body><script src="app.js"></script></body></html>';
    const out = buildSrcdoc(html, {
      sidecars: { 'styles.css': 'body{color:red}', 'app.js': 'console.log("ok")' },
    });
    expect(out).toContain('body{color:red}');
    expect(out).toContain('console.log("ok")');
    expect(out).toContain('CODESIGN_OVERLAY_SCRIPT');
  });

  it('is a no-op when sidecars is omitted (legacy callers unchanged)', () => {
    const html = '<!doctype html><html><body><p>x</p></body></html>';
    const before = buildSrcdoc(html);
    const after = buildSrcdoc(html, {});
    expect(before).toBe(after);
  });
});
