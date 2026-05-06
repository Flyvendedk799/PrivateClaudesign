import { describe, expect, it } from 'vitest';
import { classifyDiff, lineDiff } from './preview-diff';

describe('classifyDiff', () => {
  it('identical strings', () => {
    expect(classifyDiff('<p>x</p>', '<p>x</p>')).toBe('identical');
  });

  it('css-only when only the <style> block content changes', () => {
    const a = '<html><head><style>.a{color:red}</style></head><body>X</body></html>';
    const b = '<html><head><style>.a{color:blue}</style></head><body>X</body></html>';
    expect(classifyDiff(a, b)).toBe('css-only');
  });

  it('js-only when one <script> block content changes', () => {
    const a = '<html><body>X<script>console.log(1)</script></body></html>';
    const b = '<html><body>X<script>console.log(2)</script></body></html>';
    expect(classifyDiff(a, b)).toBe('js-only');
  });

  it('structural when DOM body content changes', () => {
    const a = '<html><body><h1>old</h1></body></html>';
    const b = '<html><body><h1>new</h1></body></html>';
    expect(classifyDiff(a, b)).toBe('structural');
  });

  it('structural when number of style blocks changes', () => {
    const a = '<html><head><style>.a{}</style></head><body>X</body></html>';
    const b = '<html><head><style>.a{}</style><style>.b{}</style></head><body>X</body></html>';
    expect(classifyDiff(a, b)).toBe('structural');
  });

  it('structural when both CSS and JS change together', () => {
    const a = '<html><head><style>.a{}</style></head><body><script>1</script></body></html>';
    const b = '<html><head><style>.a{c:r}</style></head><body><script>2</script></body></html>';
    // Both classes of change present → cannot apply via either CSS-only
    // or JS-only fast-path; the conservative answer is structural.
    expect(classifyDiff(a, b)).toBe('structural');
  });
});

describe('lineDiff', () => {
  it('emits remove + add for a single-line change with context', () => {
    const a = 'line1\nline2\nline3';
    const b = 'line1\nlineTWO\nline3';
    const out = lineDiff(a, b, { context: 1 });
    const removes = out.filter((l) => l.kind === 'remove').map((l) => l.text);
    const adds = out.filter((l) => l.kind === 'add').map((l) => l.text);
    expect(removes).toEqual(['line2']);
    expect(adds).toEqual(['lineTWO']);
  });

  it('preserves prefix and suffix as context', () => {
    const a = 'a\nb\nc\nd\ne';
    const b = 'a\nb\nX\nd\ne';
    const out = lineDiff(a, b, { context: 1 });
    const ctx = out.filter((l) => l.kind === 'context').map((l) => l.text);
    // 1 line of context on each side: "b" before, "d" after.
    expect(ctx.some((t) => t === 'b')).toBe(true);
    expect(ctx.some((t) => t === 'd')).toBe(true);
  });

  it('truncates very long diffs while keeping head and tail', () => {
    const longOld = Array.from({ length: 500 }, (_, i) => `o${i}`).join('\n');
    const longNew = Array.from({ length: 500 }, (_, i) => `n${i}`).join('\n');
    const out = lineDiff(longOld, longNew, { context: 0, maxLines: 50 });
    expect(out.length).toBeLessThanOrEqual(51); // 50 + 1 truncation marker
    expect(out.some((l) => l.text.includes('truncated'))).toBe(true);
  });
});
