import { describe, expect, it } from 'vitest';
import {
  HEURISTIC_ADVISORY_SOURCES,
  HEURISTIC_FATAL_SOURCES,
  runHeuristics,
  scanA11yAdvisory,
  scanA11yBaseline,
  scanA11yFatal,
  scanContentQuality,
  scanHeadingHierarchy,
  scanInteractivity,
  scanLocalRefs,
  scanOrphanedJsModules,
  scanResponsiveSignals,
} from './done-heuristics.js';

describe('scanContentQuality', () => {
  it('flags Lorem ipsum', () => {
    const r = scanContentQuality('<p>Lorem ipsum dolor sit amet</p>');
    expect(r).toHaveLength(1);
    expect(r[0]?.source).toBe('content.placeholder');
    expect(r[0]?.message).toMatch(/Lorem/);
  });

  it('flags placeholder names like Jane Doe', () => {
    const r = scanContentQuality('<span>Jane Doe</span>');
    expect(r).toHaveLength(1);
    expect(r[0]?.message).toMatch(/Doe/);
  });

  it('flags free-floating "100%" copy', () => {
    const r = scanContentQuality('<h2>100% satisfaction guaranteed</h2>');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]?.source).toBe('content.placeholder');
  });

  it('does NOT flag legitimate CSS width: 100%', () => {
    const r = scanContentQuality('<div style="width: 100%; height: 50%">x</div>');
    // Could still match if our regex is too loose. Real test: width: 100% should be skipped.
    const widthHits = r.filter((e) => /100%/.test(e.message));
    expect(widthHits).toHaveLength(0);
  });

  it('flags placeholder dates like Jan 1 2020', () => {
    const r = scanContentQuality('<time>January 1, 2020</time>');
    expect(r.some((e) => /Jan/.test(e.message))).toBe(true);
  });

  it('returns empty for clean content', () => {
    const r = scanContentQuality('<p>Real product copy with specific dates Mar 14, 2026.</p>');
    expect(r).toHaveLength(0);
  });
});

describe('scanInteractivity', () => {
  it('flags zero interactive elements', () => {
    const r = scanInteractivity('<div><h1>Static page</h1><p>No interactivity here.</p></div>');
    expect(r).toHaveLength(1);
    expect(r[0]?.source).toBe('interactivity.minimum');
    expect(r[0]?.message).toMatch(/Only 0/);
  });

  it('flags one interactive element', () => {
    const r = scanInteractivity('<button onClick={fn}>Click</button>');
    expect(r).toHaveLength(1);
    expect(r[0]?.message).toMatch(/Only 1/);
  });

  it('passes when ≥2 interactive elements present', () => {
    const r = scanInteractivity('const [a, setA] = useState(); <button onClick={fn}>x</button>');
    expect(r).toHaveLength(0);
  });

  it('counts addEventListener as interactivity', () => {
    const r = scanInteractivity(
      'document.addEventListener("click", h); window.addEventListener("scroll", s);',
    );
    expect(r).toHaveLength(0);
  });
});

describe('scanA11yFatal', () => {
  it('flags <button> with no text and no aria-label as button_no_name', () => {
    const r = scanA11yFatal('<button class="x"><svg /></button>');
    expect(r.some((e) => e.source === 'a11y.button_no_name')).toBe(true);
  });

  it('does NOT flag <button> with aria-label', () => {
    expect(scanA11yFatal('<button aria-label="Close"><svg /></button>')).toHaveLength(0);
  });

  it('does NOT flag <button> with visible text content', () => {
    expect(scanA11yFatal('<button class="x">Click me</button>')).toHaveLength(0);
  });

  it('flags <input type="email"> without label as input_no_label', () => {
    const r = scanA11yFatal('<input type="email" name="email" />');
    expect(r.some((e) => e.source === 'a11y.input_no_label')).toBe(true);
  });

  it('does NOT flag <input> with matching <label for=>', () => {
    expect(
      scanA11yFatal('<label for="em">Email</label><input id="em" type="email" />'),
    ).toHaveLength(0);
  });

  it('does NOT flag <input type="hidden">', () => {
    expect(scanA11yFatal('<input type="hidden" name="csrf" />')).toHaveLength(0);
  });

  it('flags <a href> with no text and no aria-label as link_no_name', () => {
    const r = scanA11yFatal('<a href="/x"><svg /></a>');
    expect(r.some((e) => e.source === 'a11y.link_no_name')).toBe(true);
  });

  it('does NOT flag <a href> with text content', () => {
    expect(scanA11yFatal('<a href="/x">Read more</a>')).toHaveLength(0);
  });

  it('does NOT flag <a href> with <img alt> child', () => {
    expect(scanA11yFatal('<a href="/x"><img src="logo.png" alt="Home" /></a>')).toHaveLength(0);
  });

  it('does NOT flag <a> without href (anchor / fragment-only)', () => {
    expect(scanA11yFatal('<a name="top"><svg /></a>')).toHaveLength(0);
  });

  it('flags missing <title> on full HTML doc', () => {
    const r = scanA11yFatal('<html lang="en"><head></head><body><main>x</main></body></html>');
    expect(r.some((e) => e.source === 'a11y.no_document_title')).toBe(true);
  });

  it('flags missing lang on <html>', () => {
    const r = scanA11yFatal(
      '<html><head><title>t</title></head><body><main>x</main></body></html>',
    );
    expect(r.some((e) => e.source === 'a11y.no_html_lang')).toBe(true);
  });

  it('flags missing <main> landmark on full HTML doc', () => {
    const r = scanA11yFatal(
      '<html lang="en"><head><title>t</title></head><body><div>x</div></body></html>',
    );
    expect(r.some((e) => e.source === 'a11y.no_main_landmark')).toBe(true);
  });

  it('does NOT fire doc-level rules on JSX fragments without <html>', () => {
    const r = scanA11yFatal('<div><h1>Hi</h1></div>');
    expect(r.some((e) => e.source?.startsWith('a11y.no_'))).toBe(false);
  });

  it('all fatal sources are in HEURISTIC_FATAL_SOURCES (not advisory)', () => {
    const r = scanA11yFatal(
      '<html><head></head><body><button><svg /></button><input type="email" /><a href="/x"><svg /></a></body></html>',
    );
    for (const e of r) {
      expect(HEURISTIC_FATAL_SOURCES.has(e.source ?? '')).toBe(true);
      expect(HEURISTIC_ADVISORY_SOURCES.has(e.source ?? '')).toBe(false);
    }
  });
});

describe('scanA11yAdvisory', () => {
  it('flags <div onClick> without role="button"', () => {
    const r = scanA11yAdvisory('<div onClick={handler}>x</div>');
    expect(r.some((e) => e.source === 'a11y.div_click')).toBe(true);
  });

  it('does NOT flag <div onClick role="button">', () => {
    expect(scanA11yAdvisory('<div onClick={h} role="button" tabIndex={0}>x</div>')).toHaveLength(0);
  });
});

describe('scanA11yBaseline (back-compat shim)', () => {
  it('returns the union of fatal + advisory rules', () => {
    const src = '<button class="x"><svg /></button><div onClick={h}>x</div>';
    const r = scanA11yBaseline(src);
    expect(r.some((e) => e.source === 'a11y.button_no_name')).toBe(true);
    expect(r.some((e) => e.source === 'a11y.div_click')).toBe(true);
  });
});

describe('scanHeadingHierarchy', () => {
  it('passes for h1 → h2 → h3 progression', () => {
    const r = scanHeadingHierarchy('<h1>A</h1><h2>B</h2><h3>C</h3>');
    expect(r).toHaveLength(0);
  });

  it('flags h1 → h3 skip', () => {
    const r = scanHeadingHierarchy('<h1>A</h1><h3>C</h3>');
    expect(r.some((e) => /skip/.test(e.message))).toBe(true);
  });

  it('flags pages starting with h2', () => {
    const r = scanHeadingHierarchy('<h2>Top</h2><h3>Sub</h3>');
    expect(r.some((e) => /First heading is <h2>/.test(e.message))).toBe(true);
  });

  it('returns empty for no headings', () => {
    const r = scanHeadingHierarchy('<p>just paragraphs</p>');
    expect(r).toHaveLength(0);
  });
});

describe('scanLocalRefs', () => {
  it('flags <link href> pointing to a missing local CSS file', () => {
    const r = scanLocalRefs('<link rel="stylesheet" href="styles.css">', new Set());
    expect(r.some((e) => e.source === 'multifile.missing_ref')).toBe(true);
  });

  it('passes when the referenced local CSS file exists', () => {
    const r = scanLocalRefs('<link rel="stylesheet" href="styles.css">', new Set(['styles.css']));
    expect(r).toHaveLength(0);
  });

  it('flags <script src> pointing to a missing local JS file', () => {
    const r = scanLocalRefs('<script src="app.js"></script>', new Set(['data.js']));
    expect(r.some((e) => /app\.js.*does not exist/.test(e.message))).toBe(true);
  });

  it('flags <img src> pointing to a missing local asset', () => {
    const r = scanLocalRefs('<img src="assets/logo.png" alt="logo">', new Set());
    expect(r.some((e) => /logo\.png.*does not exist/.test(e.message))).toBe(true);
  });

  it('skips https:// CDN refs', () => {
    const r = scanLocalRefs(
      '<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>',
      new Set(),
    );
    expect(r).toHaveLength(0);
  });

  it('skips data: URLs', () => {
    const r = scanLocalRefs('<img src="data:image/png;base64,abc">', new Set());
    expect(r).toHaveLength(0);
  });

  it('skips fragment-only refs (#anchor) and protocol refs (mailto:)', () => {
    const r = scanLocalRefs('<a href="#top">top</a><a href="mailto:a@b.com">email</a>', new Set());
    // <a href> isn't checked by scanLocalRefs (only link/script/img); both still skipped.
    expect(r).toHaveLength(0);
  });

  it('strips leading ./ and query strings before matching the known set', () => {
    const r = scanLocalRefs(
      '<link href="./styles.css?v=1"><script src="./app.js"></script>',
      new Set(['styles.css', 'app.js']),
    );
    expect(r).toHaveLength(0);
  });

  it('emits multifile.missing_ref source which is in HEURISTIC_FATAL_SOURCES', () => {
    const r = scanLocalRefs('<link href="missing.css">', new Set());
    for (const e of r) {
      expect(HEURISTIC_FATAL_SOURCES.has(e.source ?? '')).toBe(true);
    }
  });
});

describe('scanOrphanedJsModules', () => {
  it('flags src/main.js when index.html does not load it', () => {
    const html = "<!doctype html><html><body><script>console.log('inline');</script></body></html>";
    const r = scanOrphanedJsModules(html, new Set(['src/main.js']));
    expect(r).toHaveLength(1);
    expect(r[0]?.source).toBe('multifile.orphan_module');
    expect(r[0]?.message).toMatch(/src\/main\.js/);
    expect(r[0]?.message).toMatch(/does not load it/);
  });

  it('passes when <script src="src/main.js"> is present', () => {
    const html = '<!doctype html><html><body><script src="src/main.js"></script></body></html>';
    const r = scanOrphanedJsModules(html, new Set(['src/main.js']));
    expect(r).toHaveLength(0);
  });

  it('passes when <script type="module" src="src/main.js"> is present', () => {
    const html =
      '<!doctype html><html><body><script type="module" src="src/main.js"></script></body></html>';
    const r = scanOrphanedJsModules(html, new Set(['src/main.js']));
    expect(r).toHaveLength(0);
  });

  it('passes when an inline script imports the file by basename', () => {
    // Common pattern: <script type="module">import { Audio } from './main.js';</script>
    const html =
      '<!doctype html><html><body><script type="module">import \'./main.js\';</script></body></html>';
    const r = scanOrphanedJsModules(html, new Set(['src/main.js']));
    // basename 'main.js' is mentioned — heuristic accepts as wired.
    expect(r).toHaveLength(0);
  });

  it('skips assets/ files (treated as data, not code)', () => {
    const html = '<!doctype html><html><body></body></html>';
    const r = scanOrphanedJsModules(html, new Set(['assets/data/levels.js']));
    expect(r).toHaveLength(0);
  });

  it('skips non-JS extensions', () => {
    const html = '<!doctype html><html><body></body></html>';
    const r = scanOrphanedJsModules(
      html,
      new Set(['src/styles.css', 'src/data.json', 'src/icon.svg']),
    );
    expect(r).toHaveLength(0);
  });

  it('flags multiple orphaned files independently', () => {
    const html = '<!doctype html><html><body></body></html>';
    const r = scanOrphanedJsModules(html, new Set(['src/main.js', 'src/entities.js']));
    expect(r).toHaveLength(2);
    const messages = r.map((e) => e.message).join('\n');
    expect(messages).toMatch(/src\/main\.js/);
    expect(messages).toMatch(/src\/entities\.js/);
  });

  it('source is in HEURISTIC_FATAL_SOURCES (drives the fix loop)', () => {
    const html = '<!doctype html><html><body></body></html>';
    const r = scanOrphanedJsModules(html, new Set(['src/main.js']));
    for (const e of r) {
      expect(HEURISTIC_FATAL_SOURCES.has(e.source ?? '')).toBe(true);
    }
  });

  it('production trace 2026-05-10 — Game2 brawler: src/main.js + src/entities.js orphaned', () => {
    // Reproduction of the exact failure mode: importmap got swapped for
    // legacy three.min.js (line 90 of the brawler index.html), removing
    // the <script type="module" src="src/main.js"> wiring; src/main.js
    // and src/entities.js still exist but no reference in the HTML.
    const html = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<title>Shadow Strike</title>',
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>',
      '<script>',
      '// inline brawler logic — pre-combat-improvement',
      'const player = { hp: 100 };',
      '</script>',
      '</head>',
      '<body><canvas id="c"></canvas></body>',
      '</html>',
    ].join('\n');
    const r = scanOrphanedJsModules(html, new Set(['src/main.js', 'src/entities.js']));
    expect(r).toHaveLength(2);
    expect(r.map((e) => e.message).join(' ')).toMatch(/src\/main\.js/);
    expect(r.map((e) => e.message).join(' ')).toMatch(/src\/entities\.js/);
  });
});

describe('scanDarkModeSupport', () => {
  it('flags artifacts with color rules but no dark-mode media query or dark: utility', async () => {
    const { scanDarkModeSupport } = await import('./done-heuristics.js');
    const r = scanDarkModeSupport('<style>body { background: #fff; color: #111; }</style>');
    expect(r).toHaveLength(1);
    expect(r[0]?.source).toBe('darkmode.no_support');
  });

  it('passes when @media (prefers-color-scheme: dark) is present', async () => {
    const { scanDarkModeSupport } = await import('./done-heuristics.js');
    expect(
      scanDarkModeSupport(
        '<style>body { background: #fff } @media (prefers-color-scheme: dark) { body { background: #111 } }</style>',
      ),
    ).toHaveLength(0);
  });

  it('passes when Tailwind dark: utility is present', async () => {
    const { scanDarkModeSupport } = await import('./done-heuristics.js');
    expect(scanDarkModeSupport('<div className="bg-white dark:bg-zinc-900">x</div>')).toHaveLength(
      0,
    );
  });

  it('skips early scaffolds with no color rules', async () => {
    const { scanDarkModeSupport } = await import('./done-heuristics.js');
    expect(scanDarkModeSupport('<div><h1>Hi</h1></div>')).toHaveLength(0);
  });
});

describe('scanResponsiveSignals', () => {
  it('flags HTML with no media queries or breakpoint utilities', () => {
    const r = scanResponsiveSignals('<div class="container"><h1>Hi</h1></div>');
    expect(r).toHaveLength(1);
    expect(r[0]?.source).toBe('responsive.no_signals');
  });

  it('passes when @media query present', () => {
    const r = scanResponsiveSignals(
      '<style>@media (min-width: 768px) { h1 { font-size: 2rem } }</style>',
    );
    expect(r).toHaveLength(0);
  });

  it('passes when Tailwind sm:/md:/lg: utility used', () => {
    const r = scanResponsiveSignals('<div className="text-sm md:text-base lg:text-lg">x</div>');
    expect(r).toHaveLength(0);
  });
});

describe('runHeuristics integration', () => {
  it('aggregates findings from every scanner including new fatal a11y rules', () => {
    const src = `
      <html><body>
        <h2>Lorem ipsum landing page</h2>
        <button class="icon"><svg /></button>
        <div onClick={h}>action</div>
      </body></html>
    `;
    const r = runHeuristics(src);
    const sources = new Set(r.map((e) => e.source));
    expect(sources.has('content.placeholder')).toBe(true);
    expect(sources.has('a11y.button_no_name')).toBe(true); // fatal
    expect(sources.has('a11y.div_click')).toBe(true); // advisory
    expect(sources.has('a11y.heading_skip')).toBe(true); // advisory
    expect(sources.has('a11y.no_document_title')).toBe(true); // fatal (full doc)
    expect(sources.has('a11y.no_html_lang')).toBe(true); // fatal (full doc)
    expect(sources.has('a11y.no_main_landmark')).toBe(true); // fatal (full doc)
    expect(sources.has('responsive.no_signals')).toBe(true);
  });

  it('returns empty for a clean JSX-fragment artifact', () => {
    const src = `
      <style>@media (min-width: 768px) { h1 { font-size: 2rem } }</style>
      <h1>Real headline</h1>
      <h2>Real sub</h2>
      <button aria-label="Close" onClick={a}>x</button>
      <button onClick={b}>Submit</button>
    `;
    expect(runHeuristics(src)).toHaveLength(0);
  });

  it('every emitted source is classified into exactly one of advisory or fatal', () => {
    // Belt-and-braces: any new scanner must add its source to one of the
    // allowlists, so done.ts can correctly classify it.
    const src = `
      <html><body>
        <h2>Lorem</h2>
        <button class="icon"><svg /></button>
        <input type="email" />
        <a href="/x"><svg /></a>
        <div onClick={h}>x</div>
      </body></html>
    `;
    const r = runHeuristics(src);
    for (const e of r) {
      const inAdvisory = HEURISTIC_ADVISORY_SOURCES.has(e.source ?? '');
      const inFatal = HEURISTIC_FATAL_SOURCES.has(e.source ?? '');
      expect(inAdvisory || inFatal).toBe(true);
      // Mutually exclusive — a source can't be both.
      expect(inAdvisory && inFatal).toBe(false);
    }
  });
});

describe('game artifact heuristics', () => {
  it('suppresses round-number 100% placeholder copy for canvas HUD math', () => {
    const src = '<style>.hp-fill { width: 100%; }</style><canvas id="game"></canvas>';
    const r = runHeuristics(src, new Set(), { artifactType: 'game' });
    expect(r.some((e) => e.source === 'content.placeholder' && /100%/.test(e.message))).toBe(false);
  });

  it('keeps other placeholder-content warnings for games', () => {
    const r = runHeuristics('<canvas></canvas><p>Lorem ipsum</p>', new Set(), {
      artifactType: 'game',
    });
    expect(r.some((e) => e.source === 'content.placeholder' && /Lorem/.test(e.message))).toBe(true);
  });

  it('suppresses responsive and document-outline advisories for canvas games', () => {
    const src = '<html lang="en"><head><title>Game</title></head><body><h2>HUD</h2></body></html>';
    const r = runHeuristics(src, new Set(), { artifactType: 'game' });
    const sources = new Set(r.map((e) => e.source));
    expect(sources.has('responsive.no_signals')).toBe(false);
    expect(sources.has('a11y.heading_skip')).toBe(false);
    expect(sources.has('a11y.no_main_landmark')).toBe(false);
  });

  it('keeps WCAG-A control failures for games with DOM controls', () => {
    const r = runHeuristics('<button><svg /></button><canvas></canvas>', new Set(), {
      artifactType: 'game',
    });
    expect(r.some((e) => e.source === 'a11y.button_no_name')).toBe(true);
  });
});
