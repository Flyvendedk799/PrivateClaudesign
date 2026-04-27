/**
 * Vanilla-pattern multi-source-file inliner + asset-ref resolver.
 * Pure-functional helpers extracted from `./index.ts` so unit tests
 * can import them without booting Electron's `app` module.
 *
 * Used by the runtime FS to transform the agent-written `index.html`
 * (which references `<link href="styles.css">` / `<script src="app.js">`
 * the way Claude Design's exports do) into a self-contained iframe
 * srcdoc — local sidecar files inlined as `<style>` / `<script>`
 * blocks, `assets/*` refs replaced with their data: URLs, CDN refs
 * (https://...) passed through unchanged.
 */

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace `assets/<path>` substrings in `source` with the matching
 *  data: URL from `files`. Skips entries that don't start with `data:` —
 *  the assets gen path always pre-encodes images to data URLs (see
 *  `allocateAssetPath` / generate-image-asset tool), so anything else
 *  in `assets/` is intentionally left alone. */
export function resolveLocalAssetRefs(source: string, files: Map<string, string>): string {
  let resolved = source;
  for (const [path, content] of files.entries()) {
    if (!path.startsWith('assets/') || !content.startsWith('data:')) continue;
    resolved = resolved.replace(new RegExp(escapeRegExp(path), 'g'), content);
  }
  return resolved;
}

/** Returns true for any href/src value that points to an external (CDN
 *  or absolute) resource, so the inliner leaves it alone. */
function isExternalRef(ref: string): boolean {
  return (
    ref.startsWith('http://') ||
    ref.startsWith('https://') ||
    ref.startsWith('//') ||
    ref.startsWith('data:') ||
    ref.startsWith('blob:')
  );
}

/** Strip an optional ?cache-bust suffix so `styles.css?v=3` resolves to
 *  the `styles.css` key in fsMap. The suffix is preserved by Claude
 *  Design's exporter — we tolerate it here for parity. */
function normalizeLocalRef(ref: string): string {
  const q = ref.indexOf('?');
  return q >= 0 ? ref.slice(0, q) : ref;
}

/** Escape a string so it can safely live inside an inline `<script>` or
 *  `<style>` block — specifically prevents `</script>` or `</style>` in
 *  content from terminating the synthetic block early. */
function escapeForInlineTag(content: string, kind: 'script' | 'style'): string {
  const closeTag = kind === 'script' ? '</script' : '</style';
  return content.split(closeTag).join(`<\\/${kind === 'script' ? 'script' : 'style'}`);
}

/**
 * Vanilla-pattern multi-file inliner. Replaces local
 * `<link rel="stylesheet" href="X.css">` with `<style>...</style>` and
 * `<script src="Y.js"></script>` with `<script>...</script>`, pulling
 * content from `files`. CDN refs (https://, //, data:) pass through
 * unchanged so Three.js etc. still load over the network.
 *
 * Safe to call on JSX-pattern HTML too: that HTML has no `<link>` or
 * `<script src=>` to local files, so the function is a no-op.
 *
 * The injected blocks carry `data-inlined="<original-path>"` for
 * debugging — view-source in the preview shows where each chunk came
 * from.
 */
export function inlineLocalSidecars(html: string, files: Map<string, string>): string {
  let out = html.replace(
    /<link\s+([^>]*?)rel\s*=\s*["']stylesheet["']([^>]*?)>/gi,
    (full, before: string, after: string) => {
      const all = `${before} ${after}`;
      const hrefMatch = all.match(/href\s*=\s*["']([^"']+)["']/i);
      if (!hrefMatch || !hrefMatch[1]) return full;
      const href = hrefMatch[1];
      if (isExternalRef(href)) return full;
      const key = normalizeLocalRef(href);
      const css = files.get(key);
      if (css === undefined) return full;
      return `<style data-inlined="${key}">\n${escapeForInlineTag(css, 'style')}\n</style>`;
    },
  );
  out = out.replace(
    /<script\s+([^>]*?)src\s*=\s*["']([^"']+)["']([^>]*?)>\s*<\/script>/gi,
    (full, _before: string, src: string, _after: string) => {
      if (isExternalRef(src)) return full;
      const key = normalizeLocalRef(src);
      const js = files.get(key);
      if (js === undefined) return full;
      return `<script data-inlined="${key}">\n${escapeForInlineTag(js, 'script')}\n</script>`;
    },
  );
  return out;
}
