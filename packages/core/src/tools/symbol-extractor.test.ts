import { describe, expect, it } from 'vitest';
import { extractJsxSymbol, listTopLevelSymbols, rangeToLineSpan } from './symbol-extractor.js';

describe('extractJsxSymbol — function declarations', () => {
  it('finds a top-level function declaration with JSX body', () => {
    const src = [
      'const TWEAK_DEFAULTS = {};',
      '',
      'function LessonScreen() {',
      '  return <div>lesson</div>;',
      '}',
      '',
      'function App() { return <LessonScreen />; }',
    ].join('\n');
    const out = extractJsxSymbol(src, 'LessonScreen');
    expect(out.kind).toBe('found');
    if (out.kind !== 'found') return;
    const slice = src.slice(out.range.start, out.range.end);
    expect(slice).toMatch(/^function LessonScreen\(\)/);
    expect(slice).toMatch(/<div>lesson<\/div>/);
    expect(slice).toMatch(/}$/);
  });

  it('handles braces inside template literals without losing balance', () => {
    const src = [
      'function TabBar() {',
      '  const t = `nested ${`inner ${"${{}}"}`}`;',
      '  return <nav>{t}</nav>;',
      '}',
    ].join('\n');
    const out = extractJsxSymbol(src, 'TabBar');
    expect(out.kind).toBe('found');
    if (out.kind !== 'found') return;
    const slice = src.slice(out.range.start, out.range.end);
    expect(slice).toMatch(/return <nav>\{t\}<\/nav>;/);
  });
});

describe('extractJsxSymbol — const declarations', () => {
  it('finds an exported const arrow with brace body', () => {
    const src = ['export const Quiz = () => {', '  return <div>quiz</div>;', '};'].join('\n');
    const out = extractJsxSymbol(src, 'Quiz');
    expect(out.kind).toBe('found');
    if (out.kind !== 'found') return;
    const slice = src.slice(out.range.start, out.range.end);
    expect(slice).toMatch(/return <div>quiz<\/div>;/);
  });

  it('finds a const arrow with parenthesized expression body', () => {
    const src = ['const Logo = () => (', '  <span>logo</span>', ');'].join('\n');
    const out = extractJsxSymbol(src, 'Logo');
    expect(out.kind).toBe('found');
    if (out.kind !== 'found') return;
    const slice = src.slice(out.range.start, out.range.end);
    expect(slice).toMatch(/<span>logo<\/span>/);
  });
});

describe('extractJsxSymbol — miss / ambiguity / safety', () => {
  it('returns missing with a candidate list when the symbol is unknown', () => {
    const src = ['function Apple() { return null; }', 'const Banana = () => null;'].join('\n');
    const out = extractJsxSymbol(src, 'NotThere');
    expect(out.kind).toBe('missing');
    if (out.kind !== 'missing') return;
    expect(out.candidates).toEqual(expect.arrayContaining(['Apple', 'Banana']));
  });

  it('flags ambiguity when two top-level declarations share a name', () => {
    const src = ['function App() { return null; }', 'function App() { return <div/>; }'].join('\n');
    const out = extractJsxSymbol(src, 'App');
    expect(out.kind).toBe('ambiguous');
    if (out.kind !== 'ambiguous') return;
    expect(out.offsets).toHaveLength(2);
  });

  it('does NOT match identifiers inside line comments', () => {
    const src = ['// const Hidden = () => "";', 'function Visible() { return null; }'].join('\n');
    const out = extractJsxSymbol(src, 'Hidden');
    expect(out.kind).toBe('missing');
  });

  it('does NOT match member-access identifiers (foo.LessonScreen)', () => {
    const src = ['const obj = { LessonScreen: 1 };', 'const x = obj.LessonScreen;'].join('\n');
    const out = extractJsxSymbol(src, 'LessonScreen');
    expect(out.kind).toBe('missing');
  });

  it('rejects unsafe symbol names (no injection via regex chars)', () => {
    const src = 'function App() {}';
    const out = extractJsxSymbol(src, 'App\\W');
    expect(out.kind).toBe('missing');
    if (out.kind !== 'missing') return;
    expect(out.candidates).toEqual([]);
  });

  it('handles unicode identifiers', () => {
    const src = 'function 课程() { return null; }';
    // Unicode identifiers aren't covered by SAFE_IDENT (ASCII-only by
    // design — keeps the lexer fast and the test surface predictable).
    const out = extractJsxSymbol(src, '课程');
    expect(out.kind).toBe('missing');
  });
});

describe('listTopLevelSymbols / rangeToLineSpan', () => {
  it('lists top-level identifiers but not nested ones', () => {
    const src = [
      'function App() {',
      '  function nested() {}',
      '  const local = 1;',
      '  return null;',
      '}',
      'const Logo = () => null;',
    ].join('\n');
    const out = listTopLevelSymbols(src);
    expect(out).toContain('App');
    expect(out).toContain('Logo');
    expect(out).not.toContain('nested');
    expect(out).not.toContain('local');
  });

  it('rangeToLineSpan converts character offsets to 1-indexed line numbers', () => {
    const src = ['line1', 'line2', 'function X() {', '  return null;', '}', 'line6'].join('\n');
    const out = extractJsxSymbol(src, 'X');
    expect(out.kind).toBe('found');
    if (out.kind !== 'found') return;
    const span = rangeToLineSpan(src, out.range);
    expect(span.startLine).toBe(3);
    expect(span.endLine).toBe(5);
  });
});
