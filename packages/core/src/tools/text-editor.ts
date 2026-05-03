/**
 * Phase 2 — text_editor tool wired to the design_files virtual FS.
 *
 * Mirrors Anthropic's native `str_replace_based_edit_tool` shape so Claude
 * models recognize it without extra schema training. Other models that
 * support the OpenAI tool-call format see it as a regular custom tool.
 *
 * Tool implementation lives in `apps/desktop/src/main` (this file imports
 * the virtual-FS callbacks indirectly via dependency injection — the core
 * package must NOT depend on apps/desktop).
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { extractJsxSymbol, offsetsToLines, rangeToLineSpan } from './symbol-extractor.js';

/**
 * Result shape for write-class callbacks (`strReplace`, `insert`). The optional
 * `startLine` / `endLine` / `totalLines` fields let the tool surface "where
 * the edit landed" in the success message — the model's mental model of file
 * structure drifts as edits stack up, and a fresh post-edit line range cuts
 * the str_replace miss rate. Optional so test mocks can omit them.
 */
export interface EditResult {
  path: string;
  /** 1-indexed first line of the new content in the post-edit file.
   *  For an str_replace that empties a region (newStr=""), this is the line
   *  immediately AFTER the deletion (and `endLine === startLine - 1`). */
  startLine?: number;
  /** 1-indexed last line of the new content (inclusive). */
  endLine?: number;
  /** Total line count of the file after the edit. */
  totalLines?: number;
}

export interface TextEditorFsCallbacks {
  view(path: string): { content: string; numLines: number } | null;
  create(path: string, content: string): Promise<{ path: string }> | { path: string };
  strReplace(path: string, oldStr: string, newStr: string): Promise<EditResult> | EditResult;
  insert(path: string, line: number, text: string): Promise<EditResult> | EditResult;
  /** Optional: list files for `view` on a directory. Returns sorted paths. */
  listDir(dir: string): string[];
}

const TextEditorParams = Type.Object({
  command: Type.Union([
    Type.Literal('view'),
    Type.Literal('create'),
    Type.Literal('str_replace'),
    Type.Literal('insert'),
  ]),
  path: Type.String(),
  file_text: Type.Optional(Type.String()),
  old_str: Type.Optional(Type.String()),
  new_str: Type.Optional(Type.String()),
  insert_line: Type.Optional(Type.Number()),
  /** Optional `[startLine, endLine]` (1-indexed, inclusive) to narrow a view
   *  to a specific range instead of dumping the whole file. Either bound may
   *  be -1 to mean "end of file". Only valid with `command: 'view'`. Declared
   *  as a fixed-length number array (min/max = 2) because `Type.Tuple` emits
   *  legacy `items: [...]` which Anthropic's draft 2020-12 validator rejects. */
  view_range: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
  /** Optional JSX/JS top-level symbol name (e.g. `LessonScreen`, `App`,
   *  `TabBar`). When set, `view` returns the source range of that
   *  declaration's body instead of a line range — robust against edits
   *  that shift line numbers. Mutually exclusive with `view_range`. Only
   *  valid with `command: 'view'`. (backlog-2 #2) */
  symbol: Type.Optional(Type.String()),
});

export interface TextEditorDetails {
  command: 'view' | 'create' | 'str_replace' | 'insert';
  path: string;
  result?: unknown;
}

function ok(text: string, details: TextEditorDetails): AgentToolResult<TextEditorDetails> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

/**
 * Format a write-class success message with post-edit position so the model's
 * mental map of the file stays in sync. 2026-04-29 production trace had 3/21
 * str_replace failures where the model tried to anchor edits using line
 * numbers that had drifted by N lines from earlier edits — surfacing
 * "lines X-Y" each time it lands a write costs ~10 extra tokens per call
 * but anchors the agent's working memory to ground truth.
 */
function formatEditOk(headline: string, result: EditResult, isDeletion: boolean): string {
  const { path, startLine, endLine, totalLines } = result;
  const headlineWithPath = headline.endsWith('.') ? headline : `${headline} ${path}.`;
  if (startLine === undefined || endLine === undefined || totalLines === undefined) {
    return headlineWithPath;
  }
  if (isDeletion) {
    return `${headlineWithPath} Removed content at line ${startLine} (file is now ${totalLines} lines).`;
  }
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  return `${headlineWithPath} New content at ${range} (file is now ${totalLines} lines).`;
}

/**
 * Per-call size guards — enforce the AGENTIC_TOOL_GUIDANCE cadence ("skeleton
 * via create, then per-section str_replace") that Sonnet 4.6 routinely
 * ignores by jamming the entire artifact into a single tool call. The
 * 2026-04-26 production trace had a single str_replace whose tool-input
 * consumed all 32k output tokens, truncating the response mid-JSX.
 *
 * Caps are file-extension-aware. The original 8 KB / 12 KB cap is correct
 * for `index.html` (the JSX-pattern artifact MUST be a skeleton + section
 * fills). But Claude-Design-style multi-file designs ship 100+ KB of CSS
 * and 100+ KB of JS in dedicated files (Neurolayer.zip's mindspace.js is
 * 127 KB) — the same caps would block any meaningful vanilla-pattern work.
 * Sidecar files (.css, .js, .json) get a much more generous ceiling.
 *
 * Thresholds remain generous for legit one-shot writes; only the "write
 * everything in one tool call" anti-pattern trips them.
 */
// Per-write byte ceilings. Two distinct caps with different intent:
//
//  - `create` is a SKELETON tool. The 2026-04-29/04-30 production traces
//    showed 5 of 8 runs blowing the old 24 KB cap with 37-45 KB monolithic
//    `create` calls — the agent treats the slack as license to dump the
//    entire design in one shot. Tightening to 12 KB forces an actual
//    skeleton-then-fills cadence and reclaims the ~30s/violation retry
//    overhead. A real skeleton (doctype + html shell + empty App + tweak
//    stub + ReactDOM render) sits under 8 KB; the cap leaves headroom for
//    larger TWEAK_SCHEMA blobs without enabling whole-design dumps.
//
//  - `str_replace` keeps the 24 KB cap. Legitimate per-section fills
//    (a hero block, a multi-card grid) routinely run 4-12 KB; the cap
//    catches the same "shove it all in one call" anti-pattern without
//    forcing micro-sliced fills.
//
// Sidecar (.css, .js, .json) caps stay generous because Claude-Design-style
// vanilla artifacts ship 100+ KB of CSS/JS in dedicated files, and the
// skeleton-vs-section distinction doesn't apply there.
const MAX_CREATE_BYTES_INDEX = 12288;
const MAX_STR_REPLACE_NEW_BYTES_INDEX = 24576;
const MAX_CREATE_BYTES_SIDECAR = 65536;
const MAX_STR_REPLACE_NEW_BYTES_SIDECAR = 49152;

// gameplan §A5 / Q5 — game-mode files get per-extension caps. Godot scenes
// (.tscn) carry node trees that can legitimately exceed 16 KB; GDScript
// (.gd) and Python (.py) are scripts that sit between the index.html
// skeleton cap and the sidecar cap.
const MAX_CREATE_BYTES_TSCN = 32768;
const MAX_STR_REPLACE_NEW_BYTES_TSCN = 32768;
const MAX_CREATE_BYTES_GAME_SCRIPT = 16384;
const MAX_STR_REPLACE_NEW_BYTES_GAME_SCRIPT = 16384;

/** Sidecar files (CSS / JS / JSON) get the relaxed cap. The `index.html`
 *  and any other `.html` file stays on the tighter cap so the JSX-pattern
 *  skeleton-then-fills cadence is still enforced. */
function isSidecarFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.css') ||
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.json')
  );
}

function isGodotScene(path: string): boolean {
  return path.toLowerCase().endsWith('.tscn');
}

function isGameScript(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.gd') || lower.endsWith('.py');
}

function maxCreateBytesFor(path: string): number {
  if (isGodotScene(path)) return MAX_CREATE_BYTES_TSCN;
  if (isGameScript(path)) return MAX_CREATE_BYTES_GAME_SCRIPT;
  return isSidecarFile(path) ? MAX_CREATE_BYTES_SIDECAR : MAX_CREATE_BYTES_INDEX;
}

function maxStrReplaceBytesFor(path: string): number {
  if (isGodotScene(path)) return MAX_STR_REPLACE_NEW_BYTES_TSCN;
  if (isGameScript(path)) return MAX_STR_REPLACE_NEW_BYTES_GAME_SCRIPT;
  return isSidecarFile(path) ? MAX_STR_REPLACE_NEW_BYTES_SIDECAR : MAX_STR_REPLACE_NEW_BYTES_INDEX;
}

/** insert mirrors create semantics — it adds NEW content to a file —
 *  so the same per-extension cap as create makes the size guarantees
 *  symmetric across the four commands. Without a cap, an oversized
 *  insert would slip through where an equivalent create/str_replace
 *  would block (backlog-2 §3 noted this as an inconsistency). */
function maxInsertBytesFor(path: string): number {
  return maxCreateBytesFor(path);
}

function throwOversizedCreate(path: string, byteLen: number, cap: number): never {
  let guidance: string;
  if (isGodotScene(path)) {
    guidance =
      "Godot scenes (.tscn) accept up to 32 KB per create. Past that, split the scene into a parent .tscn that instantiates child scenes — one .tscn per logical sub-tree. Don't flatten everything into main.tscn.";
  } else if (isGameScript(path)) {
    guidance =
      'Game scripts (.gd / .py) accept up to 16 KB per create. Past that, split the script by responsibility — one file per entity / system / scene controller. Pull shared helpers into a `_shared.gd` / `shared.py` module.';
  } else if (isSidecarFile(path)) {
    guidance =
      'Sidecar files (.css, .js, .json) accept up to 65 KB per create. Even so, prefer splitting genuinely large modules across two creates (e.g. data + engine).';
  } else {
    guidance = [
      'create is a SKELETON tool for `index.html` — never the full design.',
      'Correct shape: ONE create with the doctype + html shell + empty App() + TWEAK_DEFAULTS/TWEAK_SCHEMA stubs + ReactDOM render (~6-10 KB), then ONE str_replace per section to fill the body.',
      'Recover from this error in TWO calls:',
      '  1. Re-issue create with a skeleton-only file_text under 12 KB — empty `<App/>` returning `<div id="root"/>` is fine.',
      '  2. Use sequential str_replace calls (each 4-10 KB) to add the hero, navigation, cards, footer, etc. one at a time.',
      'Each str_replace can be ~4-10 KB; 24 KB is its hard cap. Do NOT attempt to inline whole sections in the create call.',
    ].join(' ');
  }
  throw new Error(
    `text_editor.create("${path}", ...) was called with file_text=${byteLen} bytes, which exceeds the ${cap}-byte cap for this file type. ${guidance}`,
  );
}

function throwOversizedStrReplace(path: string, byteLen: number, cap: number): never {
  const isSidecar = isSidecarFile(path);
  const guidance = isSidecar
    ? `Sidecar files (.css, .js, .json) accept up to ${MAX_STR_REPLACE_NEW_BYTES_SIDECAR} bytes per str_replace. Split larger edits into two or three calls in the same turn — keep each tightly scoped.`
    : [
        `${MAX_STR_REPLACE_NEW_BYTES_INDEX} bytes is the per-edit ceiling for index.html.`,
        'A typical fill is 4-10 KB (one section: hero, nav, card grid, footer, …).',
        'Recover by splitting THIS replace into 2-4 smaller str_replace calls, each anchored to a different `old_str` snippet that already exists in the file.',
        'If you have not landed the skeleton yet, do that first (one create under 12 KB), then build sections via str_replace.',
      ].join(' ');
  throw new Error(
    `text_editor.str_replace on "${path}" was called with new_str=${byteLen} bytes, which exceeds the ${cap}-byte cap for this file type. ${guidance}`,
  );
}

function throwOversizedInsert(path: string, byteLen: number, cap: number): never {
  const isSidecar = isSidecarFile(path);
  const guidance = isSidecar
    ? `Sidecar files (.css, .js, .json) accept up to ${MAX_CREATE_BYTES_SIDECAR} bytes per insert. Split bigger inserts into smaller chunks.`
    : `${MAX_CREATE_BYTES_INDEX} bytes is the per-write ceiling for index.html. Split bigger inserts into smaller chunks anchored at sequential lines.`;
  throw new Error(
    `text_editor.insert on "${path}" was called with new_str=${byteLen} bytes, which exceeds the ${cap}-byte cap for this file type. ${guidance}`,
  );
}

/**
 * str_replace miss recovery — finds the lines in the live file where the FIRST
 * non-empty line of `old_str` actually appears, and surfaces them so the agent
 * can re-issue a focused `view_range` instead of blindly retrying. Production
 * traces showed agents wasting 3-5 round-trips guessing at drifted snippets;
 * one well-targeted view typically fixes it on the next call.
 *
 * Thrown — pi-agent-core's contract is "Throw on failure instead of encoding
 * errors in `content`": the message becomes the tool-result the model sees,
 * with isError=true wired by the runtime.
 */
function throwStrReplaceMiss(path: string, oldStr: string, fileContent: string): never {
  const firstLine = (oldStr.split('\n').find((ln) => ln.trim().length > 0) ?? '').trim();
  const lines = fileContent.split('\n');
  const candidateLines: number[] = [];
  if (firstLine.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]?.includes(firstLine)) candidateLines.push(i + 1);
      if (candidateLines.length >= 5) break;
    }
  }
  const firstLineSnippet = `${firstLine.slice(0, 60)}${firstLine.length > 60 ? '…' : ''}`;
  const head =
    candidateLines.length > 0
      ? `old_str not found in ${path}. The first non-empty line of your old_str ("${firstLineSnippet}") appears at line(s): ${candidateLines.join(', ')}.`
      : `old_str not found in ${path}. The first non-empty line of your old_str ("${firstLineSnippet}") does not appear anywhere in the current file.`;
  const guidance =
    candidateLines.length > 0
      ? `Next step: re-issue \`view\` with \`view_range: [${Math.max(1, (candidateLines[0] ?? 1) - 3)}, ${Math.min(lines.length, (candidateLines[0] ?? 1) + 20)}]\` to see the actual current text, then retry str_replace with the exact snippet you read back. Do NOT blindly retry with another guessed old_str — the file content has drifted from your memory and another guess will fail the same way.`
      : 'Next step: re-issue `view` with a small `view_range` covering the section you wanted to edit, then retry str_replace with the exact snippet you read back. Do NOT guess at another old_str — the file content has drifted from your memory.';
  throw new Error(`${head}\n\n${guidance}`);
}

function throwStrReplaceAmbiguous(oldStr: string, fileContent: string, originalMsg: string): never {
  const firstLine = (oldStr.split('\n').find((ln) => ln.trim().length > 0) ?? '').trim();
  const lines = fileContent.split('\n');
  const matchLines: number[] = [];
  if (firstLine.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]?.includes(firstLine)) matchLines.push(i + 1);
      if (matchLines.length >= 8) break;
    }
  }
  const head = `${originalMsg}${matchLines.length > 0 ? ` First-line matches at: ${matchLines.join(', ')}.` : ''}`;
  const guidance =
    'Next step: extend `old_str` with more surrounding context (1-3 extra lines above or below) so the snippet is unique, then retry. Do NOT shorten old_str — that makes ambiguity worse.';
  throw new Error(`${head}\n\n${guidance}`);
}

export function makeTextEditorTool(
  fs: TextEditorFsCallbacks,
): AgentTool<typeof TextEditorParams, TextEditorDetails> {
  // Per-run view budget: the full content of a file is returned on the FIRST
  // view of each path; subsequent views collapse to a short summary (line
  // count + head snippet + explicit reminder). Rationale: view accumulates in
  // the agent's context window — re-viewing a 2000-line index.html four times
  // has blown the 1M-token limit in production. AGENTIC_TOOL_GUIDANCE already
  // asks the agent to "view once, then work from memory"; this enforces it.
  const viewCountByPath = new Map<string, number>();

  // E3 — track when each path was last mutated so we can detect "view
  // immediately after str_replace on the same path with no intervening
  // tool calls". That pattern was seen 5+ times in the 2026-04-28 trace
  // moj4w21j: agent edits, then re-reads the entire file to verify the
  // edit landed. The verify is wasted tokens — the str_replace return
  // value already confirmed success. We track the LAST tool call sequence
  // counter so we can recognize "the very next thing after a write".
  let toolCallCounter = 0;
  const lastMutationByPath = new Map<string, { tick: number; size: number }>();

  return {
    name: 'str_replace_based_edit_tool',
    label: 'Text editor',
    description:
      'Read and edit files in the current design via view/create/str_replace/insert commands. ' +
      'Paths are relative to the design root (e.g. "index.html", "_starters/ios-frame.jsx"). ' +
      'Use create for new files; str_replace requires an exact match of old_str; ' +
      'view returns file content or directory listing. ' +
      'IMPORTANT: pass `view_range: [startLine, endLine]` (1-indexed, inclusive; either bound may be -1 for EOF) ' +
      'to read only a slice of the file — strongly preferred over full-file views after the file has grown past ~100 lines. ' +
      'Alternatively pass `symbol: "<JsxName>"` to read the body of a top-level function or const declaration by name ' +
      '(e.g. `symbol: "LessonScreen"`). Robust against edits that shift line numbers; mutually exclusive with view_range. ' +
      'Without view_range or symbol, repeated `view` of the same path within a single run returns only a short summary to protect context. ' +
      'CRITICAL for str_replace: `old_str` MUST be RAW file content. Do NOT include the line-number prefix that `view` ' +
      'prepends to its output. If view returned `   142  <button>Click</button>`, your old_str is just `<button>Click</button>` ' +
      '(strip the four-space-padded line number and the two trailing spaces). Including the prefix is the #1 cause of ' +
      '"old_str not found" errors — the file on disk has no line numbers, only the view tool adds them.',
    parameters: TextEditorParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<TextEditorDetails>> {
      toolCallCounter += 1;
      const tick = toolCallCounter;
      const path = params.path;
      switch (params.command) {
        case 'view': {
          const file = fs.view(path);
          if (file !== null) {
            // Symbol view — find a top-level function/const declaration by
            // name and return its body. Mutually exclusive with view_range;
            // when both are supplied, symbol wins (it's the more precise
            // intent). See backlog-2 #2.
            if (params.symbol !== undefined) {
              const symbol = params.symbol.trim();
              if (symbol.length === 0) {
                throw new Error('symbol must be a non-empty identifier');
              }
              const found = extractJsxSymbol(file.content, symbol);
              if (found.kind === 'missing') {
                const suggestion =
                  found.candidates.length > 0
                    ? `Available top-level symbols: ${found.candidates.join(', ')}.`
                    : 'No top-level function or const declarations found.';
                throw new Error(
                  `symbol "${symbol}" not found in ${path}. ${suggestion} You can also pass view_range: [startLine, endLine] to read by line number instead.`,
                );
              }
              if (found.kind === 'ambiguous') {
                const lines = offsetsToLines(file.content, found.offsets);
                throw new Error(
                  `symbol "${symbol}" is declared ${found.offsets.length} times in ${path} (line(s): ${lines.join(', ')}). Use view_range to disambiguate, or rename one of the declarations.`,
                );
              }
              const span = rangeToLineSpan(file.content, found.range);
              const slice = file.content
                .slice(found.range.start, found.range.end)
                .split('\n')
                .map((ln, idx) => `${String(span.startLine + idx).padStart(4, ' ')}  ${ln}`)
                .join('\n');
              const header = `${path} · symbol ${symbol} · lines ${span.startLine}-${span.endLine} of ${file.numLines}\n`;
              return ok(header + slice, {
                command: 'view',
                path,
                result: {
                  numLines: file.numLines,
                  symbol,
                  symbolRange: [span.startLine, span.endLine],
                },
              });
            }
            // Range view — narrow, always fresh. Soft-capped at
            // VIEW_RANGE_SOFT_CAP lines per call (E1) to keep cache-write
            // cost bounded. The agent CAN explicitly read more by issuing
            // a follow-up view with a different range, but a single call
            // can't pull the full file masquerading as a range — that
            // pattern was responsible for ~30 % of cache-write growth in
            // the 2026-04-28 traces. Capped reads return a hint pointing
            // at the next chunk so the agent can iterate cheaply.
            if (params.view_range) {
              const [rawStart, rawEnd] = params.view_range;
              if (typeof rawStart !== 'number' || typeof rawEnd !== 'number') {
                throw new Error('view_range must be [startLine, endLine] as two numbers');
              }
              const lines = file.content.split('\n');
              const start = Math.max(1, Math.floor(rawStart));
              const end = rawEnd === -1 ? lines.length : Math.max(start, Math.floor(rawEnd));
              const clampedEnd = Math.min(end, lines.length);
              const VIEW_RANGE_SOFT_CAP = 250;
              const requestedSpan = clampedEnd - start + 1;
              const capped = requestedSpan > VIEW_RANGE_SOFT_CAP;
              const effectiveEnd = capped ? start + VIEW_RANGE_SOFT_CAP - 1 : clampedEnd;
              const slice = lines
                .slice(start - 1, effectiveEnd)
                .map((ln, i) => `${String(start + i).padStart(4, ' ')}  ${ln}`)
                .join('\n');
              const truncationHint = capped
                ? `\n\n… range was capped at ${VIEW_RANGE_SOFT_CAP} lines (${requestedSpan} requested). To continue, issue another view with \`view_range: [${effectiveEnd + 1}, ${Math.min(effectiveEnd + VIEW_RANGE_SOFT_CAP, lines.length)}]\`. Or use \`symbol: "<JsxName>"\` to read a specific component without paging.`
                : '';
              const header = `${path} · lines ${start}-${effectiveEnd} of ${lines.length}${capped ? ' (capped)' : ''}\n`;
              return ok(header + slice + truncationHint, {
                command: 'view',
                path,
                result: {
                  numLines: file.numLines,
                  viewRange: [start, effectiveEnd] as [number, number],
                  ...(capped ? { capped: true, requestedSpan } : {}),
                },
              });
            }
            // E3 — post-write view stub. If the agent's IMMEDIATELY PREVIOUS
            // tool call was a successful write to this path AND the file
            // size hasn't changed since (i.e. nothing else has touched it),
            // serving the full content again is wasted tokens — the agent
            // already knows what it just wrote. Return a confirm-only stub
            // pointing the agent at view_range / symbol if they need to
            // re-orient. Only fires on the immediately following tool call
            // (tick === lastTick + 1) so an intentional view-after-other-
            // operations still works as expected.
            const lastMut = lastMutationByPath.get(path);
            if (
              lastMut !== undefined &&
              tick === lastMut.tick + 1 &&
              file.content.length === lastMut.size
            ) {
              const stub = `${path} was written in the previous tool call (${lastMut.size} bytes, ${file.numLines} lines). The full content the runtime saw is the same content you wrote. Re-issue \`view\` with \`view_range\` or \`symbol\` only if you need to inspect a SPECIFIC region — re-fetching the entire file you just wrote burns ~${Math.ceil(file.content.length / 4)} tokens of cache write for no new information. If you don't need a specific region, just continue with your next edit.`;
              return ok(stub, {
                command: 'view',
                path,
                result: { numLines: file.numLines, postWriteStub: true },
              });
            }
            const count = (viewCountByPath.get(path) ?? 0) + 1;
            viewCountByPath.set(path, count);
            if (count === 1) {
              return ok(file.content, {
                command: 'view',
                path,
                result: { numLines: file.numLines },
              });
            }
            // Second+ full-file view: return a tight summary. Agent should
            // switch to view_range for narrow inspections.
            const head = file.content.slice(0, 400);
            const ellipsis = file.content.length > 400 ? '…' : '';
            const summary = `${path} (already viewed ${count - 1} time(s) in this run — ${file.numLines} lines total)\n\nFirst 400 chars for orientation:\n${head}${ellipsis}\n\nTo see a specific region, re-issue view with \`view_range: [startLine, endLine]\` (1-indexed). Full-file re-views are disabled for the rest of this run to keep context from blowing up.`;
            return ok(summary, {
              command: 'view',
              path,
              result: { numLines: file.numLines, summarized: true },
            });
          }
          // Treat as directory if no file matches
          const entries = fs.listDir(path);
          if (entries.length === 0) {
            throw new Error(`Path not found: ${path}`);
          }
          return ok(entries.join('\n'), { command: 'view', path, result: { entries } });
        }
        case 'create': {
          const text = params.file_text ?? '';
          const byteLen = Buffer.byteLength(text, 'utf8');
          const createCap = maxCreateBytesFor(path);
          if (byteLen > createCap) throwOversizedCreate(path, byteLen, createCap);
          const result = await fs.create(path, text);
          // E3: record the mutation tick + size for post-write view stubbing.
          const sizeAfter = fs.view(path)?.content.length ?? 0;
          lastMutationByPath.set(path, { tick, size: sizeAfter });
          return ok(`Created ${result.path}`, { command: 'create', path, result });
        }
        case 'str_replace': {
          const oldStr = params.old_str ?? '';
          const newStr = params.new_str ?? '';
          if (oldStr.length === 0) throw new Error('str_replace requires non-empty old_str');
          const newBytes = Buffer.byteLength(newStr, 'utf8');
          const replaceCap = maxStrReplaceBytesFor(path);
          if (newBytes > replaceCap) {
            throwOversizedStrReplace(path, newBytes, replaceCap);
          }
          try {
            const result = await fs.strReplace(path, oldStr, newStr);
            const sizeAfter = fs.view(path)?.content.length ?? 0;
            lastMutationByPath.set(path, { tick, size: sizeAfter });
            return ok(formatEditOk('Edited', result, newStr.length === 0), {
              command: 'str_replace',
              path,
              result,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const file = fs.view(path);
            if (file !== null && /old_str not found/i.test(msg)) {
              throwStrReplaceMiss(path, oldStr, file.content);
            }
            if (file !== null && /ambiguous|matched \d+ times/i.test(msg)) {
              throwStrReplaceAmbiguous(oldStr, file.content, msg);
            }
            throw err;
          }
        }
        case 'insert': {
          const line = params.insert_line ?? 0;
          const text = params.new_str ?? '';
          const insertBytes = Buffer.byteLength(text, 'utf8');
          const insertCap = maxInsertBytesFor(path);
          if (insertBytes > insertCap) throwOversizedInsert(path, insertBytes, insertCap);
          const result = await fs.insert(path, line, text);
          const sizeAfter = fs.view(path)?.content.length ?? 0;
          lastMutationByPath.set(path, { tick, size: sizeAfter });
          // Insert always adds content, so deletion=false. Anchors the message
          // on the user's requested `insert_line` for continuity, then layers
          // the post-edit range on top so the model knows where the new
          // content actually lives.
          return ok(formatEditOk(`Inserted at ${result.path}:${line}.`, result, false), {
            command: 'insert',
            path,
            result,
          });
        }
      }
    },
  };
}
