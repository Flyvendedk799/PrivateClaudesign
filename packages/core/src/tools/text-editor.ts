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

export interface TextEditorFsCallbacks {
  view(path: string): { content: string; numLines: number } | null;
  create(path: string, content: string): Promise<{ path: string }> | { path: string };
  strReplace(
    path: string,
    oldStr: string,
    newStr: string,
  ): Promise<{ path: string }> | { path: string };
  insert(path: string, line: number, text: string): Promise<{ path: string }> | { path: string };
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
// Per-write byte ceilings. The 2026-04-27 mobile e-learning trace
// (backlog-2 §3) hit the old 8 KB / 12 KB caps and chunked a single
// 5-screen JSX skeleton into ~6 sliced str_replace calls, each preceded
// by a redundant context `view`. Bumping to 24 KB lets a one-shot
// skeleton land in one call without losing the "no monolithic dumps"
// signal — a 24 KB JSX module is still well under the per-turn output
// budget but covers the realistic upper bound of a complete mobile flow.
const MAX_CREATE_BYTES_INDEX = 24576;
const MAX_STR_REPLACE_NEW_BYTES_INDEX = 24576;
const MAX_CREATE_BYTES_SIDECAR = 65536;
const MAX_STR_REPLACE_NEW_BYTES_SIDECAR = 49152;

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

function maxCreateBytesFor(path: string): number {
  return isSidecarFile(path) ? MAX_CREATE_BYTES_SIDECAR : MAX_CREATE_BYTES_INDEX;
}

function maxStrReplaceBytesFor(path: string): number {
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
  const isSidecar = isSidecarFile(path);
  const guidance = isSidecar
    ? 'Sidecar files (.css, .js, .json) accept up to 65 KB per create. Even so, prefer splitting genuinely large modules across two creates (e.g. data + engine).'
    : 'create is a SKELETON tool for `index.html` — write the doctype + html shell + (for vanilla pattern) `<link>` and `<script src>` refs, then add section content via `str_replace`. Cramming the whole artifact into one call burns the per-turn output budget and truncates the response.';
  throw new Error(
    `text_editor.create("${path}", ...) was called with file_text=${byteLen} bytes, which exceeds the ${cap}-byte cap for this file type. ${guidance}`,
  );
}

function throwOversizedStrReplace(path: string, byteLen: number, cap: number): never {
  const isSidecar = isSidecarFile(path);
  const guidance = isSidecar
    ? `Sidecar files (.css, .js, .json) accept up to ${MAX_STR_REPLACE_NEW_BYTES_SIDECAR} bytes per str_replace. Split larger edits into two or three calls in the same turn — keep each tightly scoped.`
    : `${MAX_STR_REPLACE_NEW_BYTES_INDEX} bytes is a generous per-edit ceiling for index.html. Split this into 2-3 smaller \`str_replace\` calls across separate turns, one section at a time.`;
  throw new Error(
    `text_editor.str_replace on "${path}" was called with new_str=${byteLen} bytes, which exceeds the ${cap}-byte cap for this file type. A typical section is 1-3 KB. ${guidance}`,
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
      'Without view_range, repeated `view` of the same path within a single run returns only a short summary to protect context.',
    parameters: TextEditorParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<TextEditorDetails>> {
      const path = params.path;
      switch (params.command) {
        case 'view': {
          const file = fs.view(path);
          if (file !== null) {
            // Range view — narrow, always fresh, never capped. Agent should
            // prefer this after the first orientation read.
            if (params.view_range) {
              const [rawStart, rawEnd] = params.view_range;
              if (typeof rawStart !== 'number' || typeof rawEnd !== 'number') {
                throw new Error('view_range must be [startLine, endLine] as two numbers');
              }
              const lines = file.content.split('\n');
              const start = Math.max(1, Math.floor(rawStart));
              const end = rawEnd === -1 ? lines.length : Math.max(start, Math.floor(rawEnd));
              const clampedEnd = Math.min(end, lines.length);
              const slice = lines
                .slice(start - 1, clampedEnd)
                .map((ln, i) => `${String(start + i).padStart(4, ' ')}  ${ln}`)
                .join('\n');
              const header = `${path} · lines ${start}-${clampedEnd} of ${lines.length}\n`;
              return ok(header + slice, {
                command: 'view',
                path,
                result: { numLines: file.numLines, viewRange: [start, clampedEnd] },
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
            return ok(`Edited ${result.path}`, { command: 'str_replace', path, result });
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
          return ok(`Inserted at ${result.path}:${line}`, { command: 'insert', path, result });
        }
      }
    },
  };
}
