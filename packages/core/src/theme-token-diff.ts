/**
 * Phase 6 — theme-token diff (game-mode silent-camera-swap backport).
 *
 * Game-mode caught silent camera/config swaps with an explicit lock; in
 * design-mode the equivalent regression is "the model rewrote
 * --color-accent from #6f3 → #4a2 mid-edit and the user didn't ask for
 * a palette change". The differ scans CSS custom-property declarations
 * in two artifact snapshots and reports each token whose value changed.
 *
 * Pure parser — operates on raw CSS strings. The runtime can surface
 * each diff as a "Theme changed: brand-primary 6f3 → 4a2 — intentional?"
 * confirmation row at verify time.
 */

export interface TokenChange {
  name: string;
  before: string;
  after: string;
}

/** Regex to match `--name: value;` declarations within :root or any
 *  selector. Captures the name (without leading --) and value. */
const TOKEN_RE = /--([\w-]+)\s*:\s*([^;}]+?)\s*[;}]/g;

/** Extract all CSS custom-property declarations from a CSS-bearing
 *  string (full HTML or just `<style>` body). Returns name → value
 *  with the LAST occurrence winning (mirrors browser cascade for
 *  the simple case of repeated declarations on `:root`). */
export function extractCssTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
  while ((m = TOKEN_RE.exec(css)) !== null) {
    const name = m[1];
    const value = m[2]?.trim();
    if (name && value) out.set(name, value);
  }
  return out;
}

/** Diff two CSS strings. Returns the changed tokens. Tokens added or
 *  removed entirely are reported with `before` / `after` set to the
 *  empty string respectively. */
export function diffThemeTokens(before: string, after: string): TokenChange[] {
  const beforeTokens = extractCssTokens(before);
  const afterTokens = extractCssTokens(after);
  const allNames = new Set([...beforeTokens.keys(), ...afterTokens.keys()]);
  const changes: TokenChange[] = [];
  for (const name of allNames) {
    const b = beforeTokens.get(name) ?? '';
    const a = afterTokens.get(name) ?? '';
    if (a !== b) changes.push({ name, before: b, after: a });
  }
  return changes;
}
