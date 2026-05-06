/**
 * Phase 5 — diff classifier + line differ.
 *
 * The classifier inspects two HTML strings (or two source blobs of any
 * kind) and decides whether the change is structural, JS-only, or
 * CSS-only. The current PreviewSlot rebuilds srcdoc on every change; this
 * helper is the foundation for postMessage-based hot-patching of CSS or
 * single `<script>` blocks. Today it powers the per-turn diff view in
 * the chat — the load-bearing UX win.
 *
 * Heuristic boundaries are conservative: anything we can't *prove* is
 * scope-bounded falls through to `'structural'` so the existing full-
 * reload path still runs. False structural classifications cost a
 * reload (cosmetic flicker); false CSS/JS classifications would fail to
 * apply real DOM changes — strictly worse.
 */

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

function stripBlocks(html: string, re: RegExp): string {
  return html.replace(re, '');
}

function collectBlocks(html: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] ?? '');
  }
  return out;
}

export type DiffKind = 'identical' | 'css-only' | 'js-only' | 'structural';

export function classifyDiff(oldHtml: string, newHtml: string): DiffKind {
  if (oldHtml === newHtml) return 'identical';
  const oldStyleStripped = stripBlocks(oldHtml, STYLE_BLOCK_RE);
  const newStyleStripped = stripBlocks(newHtml, STYLE_BLOCK_RE);
  // Outside-of-<style> identical AND <style> count identical → CSS-only.
  if (oldStyleStripped === newStyleStripped) {
    const oldStyles = collectBlocks(oldHtml, STYLE_BLOCK_RE);
    const newStyles = collectBlocks(newHtml, STYLE_BLOCK_RE);
    if (oldStyles.length === newStyles.length) return 'css-only';
  }
  const oldScriptStripped = stripBlocks(oldHtml, SCRIPT_BLOCK_RE);
  const newScriptStripped = stripBlocks(newHtml, SCRIPT_BLOCK_RE);
  // Outside-of-<script> identical AND exactly one script block changed → JS-only.
  if (oldScriptStripped === newScriptStripped) {
    const oldScripts = collectBlocks(oldHtml, SCRIPT_BLOCK_RE);
    const newScripts = collectBlocks(newHtml, SCRIPT_BLOCK_RE);
    if (oldScripts.length === newScripts.length) {
      let changedCount = 0;
      for (let i = 0; i < oldScripts.length; i += 1) {
        if (oldScripts[i] !== newScripts[i]) changedCount += 1;
      }
      if (changedCount <= 1) return 'js-only';
    }
  }
  return 'structural';
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

/**
 * Hand-rolled minimal line differ. NOT a true LCS — uses a "common prefix
 * + common suffix" approach and emits the divergent middle as
 * remove-then-add. For str_replace results (small old_str / new_str pairs)
 * this is faithful AND ~80 LOC of zero-dep code, satisfying the lean
 * budget rule. For arbitrary diffs it can over-emit changed lines, which
 * is acceptable for a UI hint.
 *
 * Cap: maxLines bounds output for very long edits; truncated head/tail
 * markers tell the user content was elided.
 */
export function lineDiff(
  oldText: string,
  newText: string,
  opts: { context?: number; maxLines?: number } = {},
): DiffLine[] {
  const context = Math.max(0, opts.context ?? 2);
  const maxLines = Math.max(8, opts.maxLines ?? 200);
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const out: DiffLine[] = [];
  const ctxStart = Math.max(0, prefix - context);
  if (ctxStart > 0) {
    out.push({ kind: 'context', text: `… ${ctxStart} earlier line${ctxStart === 1 ? '' : 's'}` });
  }
  for (let i = ctxStart; i < prefix; i += 1) {
    out.push({ kind: 'context', text: oldLines[i] ?? '' });
  }
  for (const r of removed) out.push({ kind: 'remove', text: r });
  for (const a of added) out.push({ kind: 'add', text: a });
  const ctxEnd = Math.min(oldLines.length - suffix + context, oldLines.length);
  for (let i = oldLines.length - suffix; i < ctxEnd; i += 1) {
    out.push({ kind: 'context', text: oldLines[i] ?? '' });
  }
  const trailing = oldLines.length - ctxEnd;
  if (trailing > 0) {
    out.push({ kind: 'context', text: `… ${trailing} more line${trailing === 1 ? '' : 's'}` });
  }
  if (out.length > maxLines) {
    const head = out.slice(0, Math.floor(maxLines / 2));
    const tail = out.slice(-Math.floor(maxLines / 2));
    return [
      ...head,
      { kind: 'context', text: `… diff truncated (${out.length - maxLines} lines elided)` },
      ...tail,
    ];
  }
  return out;
}
