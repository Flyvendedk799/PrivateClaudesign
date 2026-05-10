/**
 * Static heuristics layered on top of the existing `done` static lint.
 *
 * Two severity tiers:
 *
 * 1. ADVISORY (in `HEURISTIC_ADVISORY_SOURCES`) — surfaced for the model's
 *    awareness, never trip `has_errors`. Catches subjective quality misses
 *    (placeholder copy, missing breakpoints, single-state designs) where
 *    forcing a fix loop would be over-eager.
 *
 * 2. FATAL (in `HEURISTIC_FATAL_SOURCES`) — clear WCAG 2.1 Level A failures
 *    that any auditor would flag and any user with a screen reader hits
 *    immediately. Treated like syntax errors: the agent must fix them
 *    before `done` accepts. Subset of axe-core's most-violated rules,
 *    hand-rolled because the project license policy (MIT-compatible only)
 *    rules out axe-core's MPL-2.0 dep.
 *
 * Sources used:
 *   advisory:
 *     content.placeholder    — Lorem ipsum, "100%", round-number dates
 *     interactivity.minimum  — fewer than 2 user-interactive elements
 *     a11y.heading_skip      — heading hierarchy jumps a level
 *     a11y.div_click         — onClick on non-button without role="button"
 *     responsive.no_signals  — no media queries or Tailwind breakpoint utils
 *   fatal (WCAG A):
 *     a11y.button_no_name    — <button> with neither text nor aria-label
 *     a11y.input_no_label    — form <input> with no <label> or aria-label
 *     a11y.link_no_name      — <a href> with no text or aria-label
 *     a11y.no_main_landmark  — full-page artifact with no <main>
 *     a11y.no_document_title — full HTML doc with no <title>
 *     a11y.no_html_lang      — full HTML doc with no lang attr on <html>
 */
import type { DoneError } from './done.js';

export type HeuristicArtifactType = 'design' | 'game' | 'motion';

const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string; gameSuppress?: boolean }> = [
  { re: /\bLorem ipsum\b/i, label: 'Lorem ipsum text' },
  { re: /\bplaceholder text\b/i, label: 'literal "placeholder text"' },
  { re: /\b(jane |john )?doe\b/i, label: 'placeholder name (Jane/John Doe)' },
  // "100%" standalone (not a CSS width value like `width: 100%`). The lookbehind
  // skips style attributes / CSS rules; this catches "100% satisfaction" copy.
  {
    re: /(?<![\w:-])100%(?!\s*[;,)}])/i,
    label: 'round-number "100%" placeholder copy',
    gameSuppress: true,
  },
  // Round-number dates that scream stub data.
  { re: /\b(Jan|January) 1,?\s*2020\b/i, label: 'placeholder date Jan 1 2020' },
  { re: /\b2020-01-01\b/, label: 'placeholder date 2020-01-01' },
  { re: /\$1\.00\b/, label: 'placeholder price $1.00' },
];

export function scanContentQuality(
  src: string,
  options: { artifactType?: HeuristicArtifactType } = {},
): DoneError[] {
  const out: DoneError[] = [];
  for (const { re, label, gameSuppress } of PLACEHOLDER_PATTERNS) {
    if (
      (options.artifactType === 'game' || options.artifactType === 'motion') &&
      gameSuppress === true
    )
      continue;
    const m = re.exec(src);
    if (m === null) continue;
    const lineno = src.slice(0, m.index).split('\n').length;
    out.push({
      message: `Placeholder content detected: ${label} — replace with real-feeling copy.`,
      source: 'content.placeholder',
      lineno,
    });
  }
  return out;
}

const INTERACTIVITY_TOKENS = [
  /\bonClick\s*=/g,
  /\bonChange\s*=/g,
  /\bonSubmit\s*=/g,
  /\baddEventListener\s*\(/g,
  /\buseState\s*\(/g,
  /\bsetState\s*\(/g,
  /\busePopover\s*\(/g, // common in design-skills
];

export function scanInteractivity(src: string): DoneError[] {
  let count = 0;
  for (const re of INTERACTIVITY_TOKENS) {
    const matches = src.match(re);
    if (matches) count += matches.length;
  }
  if (count >= 2) return [];
  return [
    {
      message: `Only ${count} interactive state change${count === 1 ? '' : 's'} detected — aim for ≥2 (clicks, toggles, form interactions) so the prototype feels live.`,
      source: 'interactivity.minimum',
    },
  ];
}

/**
 * Hand-rolled subset of axe-core's WCAG 2.1 A rules. These are FATAL — clear
 * accessibility failures any auditor would flag.
 */
export function scanA11yFatal(src: string): DoneError[] {
  const out: DoneError[] = [];
  // <button> with neither text nor aria-label — axe button-name (WCAG 4.1.2 A).
  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let bm = buttonRe.exec(src);
  while (bm !== null) {
    const attrs = bm[1] ?? '';
    const inner = bm[2] ?? '';
    const hasLabel = /\baria-label\s*=/i.test(attrs) || /\baria-labelledby\s*=/i.test(attrs);
    const visible = inner.replace(/<[^>]*>/g, '').trim();
    if (!hasLabel && visible.length === 0) {
      const lineno = src.slice(0, bm.index).split('\n').length;
      out.push({
        message:
          '<button> has neither visible text nor aria-label — screen readers cannot announce its purpose (WCAG 4.1.2 A).',
        source: 'a11y.button_no_name',
        lineno,
      });
    }
    bm = buttonRe.exec(src);
  }
  // <input> (text-like) without label association — axe label (WCAG 1.3.1 A).
  const inputRe = /<input\b([^>]*)\/?>/gi;
  let im = inputRe.exec(src);
  while (im !== null) {
    const attrs = im[1] ?? '';
    const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = typeMatch?.[1]?.toLowerCase() ?? 'text';
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') {
      im = inputRe.exec(src);
      continue;
    }
    const hasLabel = /\baria-label\s*=/i.test(attrs) || /\baria-labelledby\s*=/i.test(attrs);
    const idMatch = /\bid\s*=\s*["']([^"']+)/i.exec(attrs);
    if (!hasLabel && idMatch?.[1]) {
      const id = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const labelFor = new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*["']${id}["']`, 'i');
      if (labelFor.test(src)) {
        im = inputRe.exec(src);
        continue;
      }
    }
    if (!hasLabel) {
      const lineno = src.slice(0, im.index).split('\n').length;
      out.push({
        message: `<input type="${type}"> has no associated <label> or aria-label (WCAG 1.3.1 A).`,
        source: 'a11y.input_no_label',
        lineno,
      });
    }
    im = inputRe.exec(src);
  }
  // <a href> with no text content and no aria-label — axe link-name (WCAG 2.4.4 A).
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let lm = linkRe.exec(src);
  while (lm !== null) {
    const attrs = lm[1] ?? '';
    const hasHref = /\bhref\s*=/i.test(attrs);
    if (!hasHref) {
      lm = linkRe.exec(src);
      continue;
    }
    const inner = lm[2] ?? '';
    const hasLabel = /\baria-label\s*=/i.test(attrs) || /\baria-labelledby\s*=/i.test(attrs);
    // Strip nested tags and anything that looks like an icon-only <svg/img>.
    const visible = inner.replace(/<[^>]*>/g, '').trim();
    // Allow links containing <img alt="…"> — alt text counts as accessible name.
    const hasImgAlt = /<img\b[^>]*\balt\s*=\s*["'][^"']+["']/i.test(inner);
    if (!hasLabel && !hasImgAlt && visible.length === 0) {
      const lineno = src.slice(0, lm.index).split('\n').length;
      out.push({
        message:
          '<a href> has no text content, aria-label, or <img alt> — screen readers will read the URL (WCAG 2.4.4 A).',
        source: 'a11y.link_no_name',
        lineno,
      });
    }
    lm = linkRe.exec(src);
  }
  // Document-level checks fire only on full HTML artifacts (i.e. `<html>`
  // present). JSX fragments without a wrapping html tag skip these.
  const isFullDoc = /<html\b/i.test(src);
  if (isFullDoc) {
    if (!/<title\b[^>]*>[\s\S]*?<\/title>/i.test(src)) {
      out.push({
        message:
          'Document has no <title> — required by WCAG 2.4.2 A and shown in browser tabs / bookmarks.',
        source: 'a11y.no_document_title',
      });
    }
    if (!/<html\b[^>]*\blang\s*=/i.test(src)) {
      out.push({
        message:
          'Document <html> has no lang attribute — screen readers cannot pick the right pronunciation (WCAG 3.1.1 A).',
        source: 'a11y.no_html_lang',
      });
    }
    if (!/<main\b/i.test(src)) {
      out.push({
        message:
          'Page has no <main> landmark — assistive tech users cannot jump to primary content (WCAG 1.3.1 A / best practice).',
        source: 'a11y.no_main_landmark',
      });
    }
  }
  // De-dup by message+lineno so a repeated pattern only flags once each spot.
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.lineno ?? ''}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Soft a11y nudges — not WCAG failures, just patterns that screen readers
 * handle worse than alternatives. Advisory.
 */
export function scanA11yAdvisory(src: string): DoneError[] {
  const out: DoneError[] = [];
  const divClickRe = /<(div|span)\b([^>]*)>/gi;
  let dm = divClickRe.exec(src);
  while (dm !== null) {
    const attrs = dm[2] ?? '';
    if (/\bonClick\s*=/i.test(attrs) && !/\brole\s*=\s*["']button["']/i.test(attrs)) {
      const lineno = src.slice(0, dm.index).split('\n').length;
      out.push({
        message: `<${dm[1]} onClick> needs role="button" + tabIndex={0} for keyboard accessibility, or use a real <button> instead.`,
        source: 'a11y.div_click',
        lineno,
      });
    }
    dm = divClickRe.exec(src);
  }
  return out;
}

/** Back-compat shim — old name kept so external tests / callers don't break. */
export function scanA11yBaseline(src: string): DoneError[] {
  return [...scanA11yFatal(src), ...scanA11yAdvisory(src)];
}

export function scanHeadingHierarchy(src: string): DoneError[] {
  const out: DoneError[] = [];
  const headingRe = /<h([1-6])\b/gi;
  const levels: Array<{ level: number; lineno: number }> = [];
  let hm: RegExpExecArray | null;
  hm = headingRe.exec(src);
  while (hm !== null) {
    const level = Number(hm[1]);
    const lineno = src.slice(0, hm.index).split('\n').length;
    levels.push({ level, lineno });
    hm = headingRe.exec(src);
  }
  const first = levels[0];
  if (first === undefined) return out;
  if (first.level !== 1) {
    out.push({
      message: `First heading is <h${first.level}>, not <h1>. Pages should start with an h1 for screen readers + SEO.`,
      source: 'a11y.heading_skip',
      lineno: first.lineno,
    });
  }
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1];
    const curr = levels[i];
    if (prev === undefined || curr === undefined) continue;
    if (curr.level > prev.level + 1) {
      out.push({
        message: `Heading level skip: <h${prev.level}> → <h${curr.level}> at line ${curr.lineno}. Use <h${prev.level + 1}> instead.`,
        source: 'a11y.heading_skip',
        lineno: curr.lineno,
      });
    }
  }
  return out;
}

const RESPONSIVE_TOKENS: RegExp[] = [
  /@media\s*\(\s*(?:min|max)-width/i,
  // Tailwind breakpoint utility classes (sm:/md:/lg:/xl:/2xl:) appearing in
  // a className string.
  /\bclassName\s*=\s*["'`][^"'`]*\b(?:sm|md|lg|xl|2xl):[a-z-]+/,
  // Plain class= variant for vanilla HTML.
  /\bclass\s*=\s*["'`][^"'`]*\b(?:sm|md|lg|xl|2xl):[a-z-]+/,
  /\bcontainer\s*\(\s*type\s*:\s*inline-size\s*\)/i, // CSS container queries
];

export function scanResponsiveSignals(src: string): DoneError[] {
  for (const re of RESPONSIVE_TOKENS) {
    if (re.test(src)) return [];
  }
  return [
    {
      message:
        'No responsive breakpoints detected (no @media queries, no Tailwind sm:/md:/lg: classes, no container queries). Mobile users will see the desktop layout.',
      source: 'responsive.no_signals',
    },
  ];
}

/**
 * Multi-file reference integrity — for VANILLA-pattern artifacts that ship
 * multiple files, every local `<link href>`, `<script src>`, and `<img src>`
 * referenced from `index.html` must be either an absolute https:// URL (CDN)
 * OR a file that actually exists in the design's virtual fs. Missing local
 * refs are FATAL: the preview iframe will show a half-broken design and the
 * agent should be forced to either create the file or remove the reference
 * before `done` accepts.
 */
export function scanLocalRefs(src: string, knownFiles: Set<string>): DoneError[] {
  const out: DoneError[] = [];
  const checks: Array<{ re: RegExp; tag: string; attr: string }> = [
    { re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, tag: 'link', attr: 'href' },
    { re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, tag: 'script', attr: 'src' },
    { re: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, tag: 'img', attr: 'src' },
  ];
  for (const { re, tag, attr } of checks) {
    re.lastIndex = 0;
    let m = re.exec(src);
    while (m !== null) {
      const ref = m[1] ?? '';
      // Skip absolute URLs (CDN), data: / blob: URLs, and fragment-only refs.
      if (
        ref.startsWith('http://') ||
        ref.startsWith('https://') ||
        ref.startsWith('//') ||
        ref.startsWith('data:') ||
        ref.startsWith('blob:') ||
        ref.startsWith('#') ||
        ref.startsWith('mailto:') ||
        ref.startsWith('tel:')
      ) {
        m = re.exec(src);
        continue;
      }
      // Strip leading ./ and any query string / hash to match the storage key.
      const normalised = ref.replace(/^\.\//, '').split(/[?#]/)[0] ?? '';
      if (normalised === '' || knownFiles.has(normalised)) {
        m = re.exec(src);
        continue;
      }
      const lineno = src.slice(0, m.index).split('\n').length;
      out.push({
        message: `<${tag} ${attr}="${ref}"> points to a file that does not exist. Either create the file (text_editor.create) or remove the reference.`,
        source: 'multifile.missing_ref',
        lineno,
      });
      m = re.exec(src);
    }
  }
  return out;
}

/**
 * Static dark-mode hint: if the artifact uses fixed light backgrounds + no
 * `prefers-color-scheme` query, dark-mode users on macOS / iOS see flashing
 * white. Also catches the inverse: deep dark backgrounds with no light theme
 * support. Treated as advisory — many marketing pages legitimately ship
 * single-theme.
 */
export function scanDarkModeSupport(src: string): DoneError[] {
  const hasMediaQuery = /@media\s*\(\s*prefers-color-scheme/i.test(src);
  if (hasMediaQuery) return [];
  // Tailwind's `dark:` prefix is the other escape hatch.
  if (/\bdark:[a-z-]+/.test(src)) return [];
  // Check whether the artifact even cares about colors. CSS-less artifacts
  // (early-stage scaffolds) don't need this nudge.
  const hasColorRules =
    /\bbackground(-color)?\s*:/i.test(src) || /\bcolor\s*:\s*#?[a-fA-F0-9]/i.test(src);
  if (!hasColorRules) return [];
  return [
    {
      message:
        'No `prefers-color-scheme: dark` media query and no Tailwind `dark:` utilities — users on dark-mode systems see the light theme regardless. Add a dark variant or accept this as design intent.',
      source: 'darkmode.no_support',
    },
  ];
}

/** Run all heuristic scans against a source. Pure function — no I/O.
 *  Returns advisory + fatal mixed; done.ts splits them via the source sets.
 *  `knownFiles` is the set of paths in the design's virtual fs (excluding
 *  the file being scanned), used by scanLocalRefs to validate cross-file
 *  references. Pass an empty Set when not running in a multi-file context. */
export function runHeuristics(
  src: string,
  knownFiles: Set<string> = new Set(),
  options: { artifactType?: HeuristicArtifactType } = {},
): DoneError[] {
  const isGame = options.artifactType === 'game';
  const isMotion = options.artifactType === 'motion';
  // Motion compositions don't have HTML semantic landmarks (they render
  // React inside Remotion's frame stream); skip the same a11y / heading /
  // responsive checks we already skip for game.
  const skipHtmlSemantic = isGame || isMotion;
  const fatalA11y = skipHtmlSemantic
    ? scanA11yFatal(src).filter((e) => e.source !== 'a11y.no_main_landmark')
    : scanA11yFatal(src);
  return [
    ...scanContentQuality(src, options),
    ...scanInteractivity(src),
    ...fatalA11y,
    ...(skipHtmlSemantic ? [] : scanA11yAdvisory(src)),
    ...(skipHtmlSemantic ? [] : scanHeadingHierarchy(src)),
    ...(skipHtmlSemantic ? [] : scanResponsiveSignals(src)),
    ...(isMotion ? [] : scanDarkModeSupport(src)),
    ...scanLocalRefs(src, knownFiles),
    // Skipped for motion (Remotion bundles modules its own way; the
    // bundler enforces reachability statically). Game + design HTML
    // both load JS via plain <script> tags, so the orphan-module heuristic
    // applies uniformly.
    ...(isMotion ? [] : scanOrphanedJsModules(src, knownFiles)),
  ];
}

/**
 * Detect `.js` / `.mjs` files in the project that the rendered HTML
 * doesn't load. Catches the failure mode where the agent extracts logic
 * out of an inline `<script>` block into `src/main.js` (or similar) but
 * forgets to add a `<script type="module" src="src/main.js">` tag — or
 * later removes it during an unrelated edit. The agent then keeps
 * editing the orphaned file thinking it's the source of truth, while
 * the rendered game/page still runs the inline copy. Production trace
 * 2026-05-10: 5+ "improve combat" prompts edited `src/main.js` while
 * `index.html` ran a stale inline script — the user reported "changes
 * didn't implement in game" and the diagnosis took 30 minutes.
 *
 * Heuristic: the file's path or basename must appear somewhere in the
 * rendered HTML (covers `<script src="...">`, `<script type="module"
 * src="...">`, importmap entries, and inline `import './foo.js'`
 * strings). Anything not mentioned is flagged as a fatal error so the
 * `done` accept gate refuses until the wiring is restored.
 *
 * Scoped narrow on purpose:
 *   - Only `.js` / `.mjs` / `.cjs` files (not `.css`, `.json`, etc.)
 *   - Skips files under `assets/` (data, not code; loaded on demand)
 *   - Skips `_schema.json`-style metadata regardless
 *   - Skips when the project is single-file (no siblings) — JSX / vanilla
 *     React patterns don't have separate JS modules
 *
 * Limited intentionally: only checks top-level reachability from the
 * rendered HTML. A `.js` file imported only from another `.js` file is
 * still flagged because the heuristic doesn't follow transitive imports
 * (would need fs read access). In practice the agent's first fix is
 * almost always at the entrypoint, and the next verify pass catches
 * any remaining orphans.
 */
export function scanOrphanedJsModules(src: string, knownFiles: Set<string>): DoneError[] {
  if (knownFiles.size === 0) return [];
  const orphaned: string[] = [];
  for (const path of knownFiles) {
    if (!/\.(m?js|cjs)$/i.test(path)) continue;
    if (path.startsWith('assets/')) continue;
    // Reference forms we tolerate as "wired up":
    //   <script src="src/main.js"></script>
    //   <script type="module" src="src/main.js"></script>
    //   importmap: { "main": "./src/main.js" }
    //   inline: import './main.js'
    //   inline: import { ... } from './src/main.js'
    // The basename catches the `import './entities.js'` form when the
    // agent puts entities.js next to main.js and uses a bare relative
    // path. We don't want false positives for files whose names happen
    // to appear in user-visible text ("main.js" mentioned in a tutorial),
    // so the basename check is gated on the path NOT being mentioned —
    // i.e. the basename match is the fallback, not the primary signal.
    if (src.includes(path)) continue;
    const slashIdx = path.lastIndexOf('/');
    const basename = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
    if (basename !== path && src.includes(basename)) continue;
    orphaned.push(path);
  }
  return orphaned.map((path) => ({
    message:
      // Single template literal — Biome's noUnusedTemplateLiteral lint
      // wants either pure interpolation or pure string. The agent reads
      // this end-to-end so the long form is intentional.
      `'${path}' is in the project but the rendered HTML does not load it (no \`<script src=\` or \`<script type="module" src=\` tag, no importmap entry, no inline import). Either wire it in (e.g. \`<script type="module" src="${path}"></script>\` after the inline blocks), inline its content into an existing \`<script>\` block, or delete the file. Editing this file currently has no effect on the rendered output.`,
    source: 'multifile.orphan_module',
  }));
}

/** Sources that are advisory — surface to the model but never trip has_errors. */
export const HEURISTIC_ADVISORY_SOURCES = new Set<string>([
  'content.placeholder',
  'interactivity.minimum',
  'a11y.heading_skip',
  'a11y.div_click',
  'a11y.missing_label', // legacy — kept for any external rule that still emits it
  'responsive.no_signals',
  'darkmode.no_support',
]);

/** Sources that are FATAL — clear WCAG A failures or hard-broken references
 *  that would crash the preview. Drive the fix loop. */
export const HEURISTIC_FATAL_SOURCES = new Set<string>([
  'a11y.button_no_name',
  'a11y.input_no_label',
  'a11y.link_no_name',
  'a11y.no_main_landmark',
  'a11y.no_document_title',
  'a11y.no_html_lang',
  'multifile.missing_ref',
  'multifile.orphan_module',
]);
