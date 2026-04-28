/**
 * Find a JSX/JS top-level symbol (function declaration or const arrow) by
 * name and return the source range of its body. Used by the text_editor
 * `view` command's `symbol` parameter (backlog-2 #2) so the agent can ask
 * for "the LessonScreen component" instead of guessing line numbers that
 * shift after every str_replace.
 *
 * Hand-rolled lexer (no Babel/Acorn dependency — CLAUDE.md lean budget).
 * String/comment-aware so JSX inside template literals doesn't fool the
 * counter; mirrors the same state machine `findJsxStructuralIssues` in
 * `done.ts` already ships.
 */
export interface SymbolRange {
  /** 0-indexed character offset of the FIRST character of the declaration
   *  (the 'f' in `function …` or the 'c' in `const …`). */
  start: number;
  /** 0-indexed character offset ONE PAST the LAST character of the
   *  matching outer brace/paren/expression. */
  end: number;
}

export type ExtractResult =
  | { kind: 'found'; range: SymbolRange }
  | { kind: 'ambiguous'; offsets: number[] }
  | { kind: 'missing'; candidates: string[] };

const IDENT = /[A-Za-z_$][\w$]*/;
const SAFE_IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Walk forward from `body[at]` until we close the brace that starts here
 * (or hit a paren-only arrow body). Returns the index ONE PAST the
 * closing terminator. String / comment / regex states are tracked so an
 * unbalanced `{` inside a JSX attribute expression or template literal
 * doesn't blow up the counter.
 */
function findMatchingClose(src: string, openIdx: number, opener: '{' | '('): number {
  const closer = opener === '{' ? '}' : ')';
  let depth = 0;
  let inStr: '"' | "'" | '`' | null = null;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

interface DeclarationMatch {
  /** Where the declaration starts in source. */
  start: number;
  /** The offset of the `{` (function body) or `(` (arrow expression body)
   *  or the start of the assigned RHS for arrow bodies that aren't
   *  blocks/parenthesized. */
  bodyStart: number;
  /** Whether the body is a brace block (`{ ... }`), a parenthesized
   *  expression (`( ... )`), or neither (an immediate value). */
  bodyKind: 'block' | 'paren' | 'expr';
}

function findCommentEnd(src: string, idx: number): number {
  if (src[idx] === '/' && src[idx + 1] === '/') {
    const nl = src.indexOf('\n', idx);
    return nl === -1 ? src.length : nl + 1;
  }
  if (src[idx] === '/' && src[idx + 1] === '*') {
    const close = src.indexOf('*/', idx + 2);
    return close === -1 ? src.length : close + 2;
  }
  return idx;
}

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[\w$]/.test(c);
}

/** Find every top-level (column-0) declaration of `symbol` in `src`. The
 *  pure data — no errors thrown — so the caller can decide what to do
 *  with 0 / 1 / many matches. */
function findDeclarations(src: string, symbol: string): DeclarationMatch[] {
  if (!SAFE_IDENT.test(symbol)) return [];
  const out: DeclarationMatch[] = [];
  let inStr: '"' | "'" | '`' | null = null;
  let escaped = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (inStr) {
      if (ch === '\\') escaped = true;
      else if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = findCommentEnd(src, i);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch as '"' | "'" | '`';
      i += 1;
      continue;
    }
    // Match must begin at start-of-line (ignoring whitespace) so a
    // sub-string match inside a JSX attribute or another scope doesn't
    // count. Also skip when the identifier is preceded by `.` (member
    // access) or another identifier character.
    const prev = i > 0 ? src[i - 1] : undefined;
    if (prev !== undefined && (isIdentChar(prev) || prev === '.')) {
      i += 1;
      continue;
    }
    // function declaration:  function <ident>(
    if (src.startsWith('function', i)) {
      const after = i + 'function'.length;
      const sliceFromAfter = src.slice(after);
      const wsMatch = /^\s+/.exec(sliceFromAfter);
      if (wsMatch) {
        const idStart = after + wsMatch[0].length;
        const idMatch = src.slice(idStart).match(/^([A-Za-z_$][\w$]*)/);
        if (idMatch && idMatch[1] === symbol) {
          // skip past the parameter list, find the body `{`.
          const parenIdx = src.indexOf('(', idStart + symbol.length);
          if (parenIdx !== -1) {
            const parenClose = findMatchingClose(src, parenIdx, '(');
            if (parenClose !== -1) {
              const braceIdx = src.indexOf('{', parenClose);
              if (braceIdx !== -1) {
                out.push({ start: i, bodyStart: braceIdx, bodyKind: 'block' });
                i = braceIdx + 1;
                continue;
              }
            }
          }
        }
      }
    }
    // const/let/var declaration:  const <ident> = … or  const <ident> = (...) => …
    if (src.startsWith('const', i) || src.startsWith('let', i) || src.startsWith('var', i)) {
      const kw = src.startsWith('const', i) ? 'const' : src.startsWith('let', i) ? 'let' : 'var';
      const after = i + kw.length;
      const wsMatch = /^\s+/.exec(src.slice(after));
      if (wsMatch) {
        const idStart = after + wsMatch[0].length;
        const idMatch = src.slice(idStart).match(/^([A-Za-z_$][\w$]*)/);
        if (idMatch && idMatch[1] === symbol) {
          const eqIdx = src.indexOf('=', idStart + symbol.length);
          if (eqIdx !== -1) {
            // Skip `==` / `===` (comparison, not assignment).
            if (src[eqIdx + 1] === '=') {
              i = eqIdx + 2;
              continue;
            }
            // Step over assignment whitespace.
            let j = eqIdx + 1;
            while (j < src.length && /\s/.test(src[j] ?? '')) j += 1;
            // If the RHS starts with `(`, walk past the parameter list and
            // look for `=>` — that's the arrow's actual body. Otherwise
            // accept the RHS as the body directly (function expression,
            // object literal, identifier, etc.).
            let bodyStart = j;
            if (src[j] === '(') {
              const parenClose = findMatchingClose(src, j, '(');
              if (parenClose !== -1) {
                let k = parenClose;
                while (k < src.length && /\s/.test(src[k] ?? '')) k += 1;
                if (src[k] === '=' && src[k + 1] === '>') {
                  // Skip over the arrow.
                  let m2 = k + 2;
                  while (m2 < src.length && /\s/.test(src[m2] ?? '')) m2 += 1;
                  bodyStart = m2;
                } else {
                  // Parenthesized expression assigned directly.
                  out.push({ start: i, bodyStart: j, bodyKind: 'paren' });
                  i = parenClose;
                  continue;
                }
              }
            } else if (src[j] === '=') {
              // Bare arrow without parens (no `(` ident `)`): single-arg
              // form `const X = arg => …`. We landed on the `=` of `=>`.
              if (src[j + 1] === '>') {
                let m2 = j + 2;
                while (m2 < src.length && /\s/.test(src[m2] ?? '')) m2 += 1;
                bodyStart = m2;
              }
            }
            const c = src[bodyStart];
            if (c === '{') {
              out.push({ start: i, bodyStart, bodyKind: 'block' });
              i = bodyStart + 1;
              continue;
            }
            if (c === '(') {
              out.push({ start: i, bodyStart, bodyKind: 'paren' });
              i = bodyStart + 1;
              continue;
            }
            out.push({ start: i, bodyStart, bodyKind: 'expr' });
            i = bodyStart;
            continue;
          }
        }
      }
    }
    i += 1;
  }
  return out;
}

/** All top-level identifiers declared via `function` / `const` / `let` /
 *  `var` — used as the candidate list when a `symbol` lookup misses.
 *  Only declarations that start at column 0 (no leading whitespace) count
 *  as "top-level" — anything indented is, by convention, nested inside
 *  another scope and should not surface as a candidate. */
export function listTopLevelSymbols(src: string): string[] {
  const out = new Set<string>();
  const declRe = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null = declRe.exec(src);
  while (m !== null) {
    if (m[1]) out.add(m[1]);
    m = declRe.exec(src);
  }
  return [...out];
}

/**
 * Find the `symbol` declaration in `src` and return its source range.
 * Returns `{ kind: 'missing', candidates }` with up to 12 nearby symbol
 * names when `symbol` isn't declared anywhere; `{ kind: 'ambiguous',
 * offsets }` when more than one top-level declaration of the same name
 * exists.
 */
export function extractJsxSymbol(src: string, symbol: string): ExtractResult {
  if (!SAFE_IDENT.test(symbol)) {
    return { kind: 'missing', candidates: [] };
  }
  const decls = findDeclarations(src, symbol);
  if (decls.length === 0) {
    return { kind: 'missing', candidates: listTopLevelSymbols(src).slice(0, 12) };
  }
  if (decls.length > 1) {
    return { kind: 'ambiguous', offsets: decls.map((d) => d.start) };
  }
  const decl = decls[0];
  if (!decl) return { kind: 'missing', candidates: [] };
  let end: number;
  if (decl.bodyKind === 'block') {
    end = findMatchingClose(src, decl.bodyStart, '{');
  } else if (decl.bodyKind === 'paren') {
    end = findMatchingClose(src, decl.bodyStart, '(');
  } else {
    // Expression body — terminate at the next `;` / newline followed by
    // another top-level declaration / EOF.
    let j = decl.bodyStart;
    let inS: '"' | "'" | '`' | null = null;
    let esc = false;
    while (j < src.length) {
      const ch = src[j];
      if (esc) {
        esc = false;
        j += 1;
        continue;
      }
      if (inS) {
        if (ch === '\\') esc = true;
        else if (ch === inS) inS = null;
        j += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inS = ch as '"' | "'" | '`';
        j += 1;
        continue;
      }
      if (ch === ';') {
        end = j + 1;
        return { kind: 'found', range: { start: decl.start, end } };
      }
      if (ch === '\n') {
        // Look ahead — if the next non-whitespace is a top-level keyword,
        // we've left this declaration.
        let k = j + 1;
        while (k < src.length && /[ \t]/.test(src[k] ?? '')) k += 1;
        const rest = src.slice(k, k + 16);
        if (/^(export\s+|function\s+|const\s+|let\s+|var\s+|class\s+)/.test(rest)) {
          end = j;
          return { kind: 'found', range: { start: decl.start, end } };
        }
      }
      j += 1;
    }
    end = src.length;
  }
  if (end === -1) {
    return { kind: 'missing', candidates: listTopLevelSymbols(src).slice(0, 12) };
  }
  return { kind: 'found', range: { start: decl.start, end } };
}

/** Return the line numbers (1-indexed) for the start and end of a range. */
export function rangeToLineSpan(
  src: string,
  range: SymbolRange,
): { startLine: number; endLine: number } {
  const startLine = src.slice(0, range.start).split('\n').length;
  const endLine = src.slice(0, Math.max(range.start, range.end)).split('\n').length;
  return { startLine, endLine };
}

/** Convert character offsets to line numbers for a list of decl starts. */
export function offsetsToLines(src: string, offsets: number[]): number[] {
  return offsets.map((off) => src.slice(0, off).split('\n').length);
}

void IDENT;
