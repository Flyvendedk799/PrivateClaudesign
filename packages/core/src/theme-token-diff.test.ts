import { describe, expect, it } from 'vitest';
import { diffThemeTokens, extractCssTokens } from './theme-token-diff';

describe('extractCssTokens (Phase 6)', () => {
  it('extracts simple :root declarations', () => {
    const css = ':root { --color-accent: #6f3; --radius-md: 8px; }';
    const t = extractCssTokens(css);
    expect(t.get('color-accent')).toBe('#6f3');
    expect(t.get('radius-md')).toBe('8px');
  });

  it('handles multi-line declarations and complex values', () => {
    const css = `:root {
      --gradient: linear-gradient(180deg, #fff, #eee);
      --shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }`;
    const t = extractCssTokens(css);
    expect(t.get('gradient')).toBe('linear-gradient(180deg, #fff, #eee)');
    expect(t.get('shadow')).toBe('0 4px 12px rgba(0, 0, 0, 0.1)');
  });

  it('last occurrence wins (mirrors cascade for repeated :root tokens)', () => {
    const css = `:root { --x: red } [data-theme="dark"] { --x: blue }`;
    expect(extractCssTokens(css).get('x')).toBe('blue');
  });

  it('returns empty map when no tokens are present', () => {
    expect(extractCssTokens('h1 { color: red }').size).toBe(0);
  });
});

describe('diffThemeTokens (Phase 6)', () => {
  it('reports values that changed', () => {
    const before = ':root { --color-accent: #6f3; --radius-md: 8px }';
    const after = ':root { --color-accent: #4a2; --radius-md: 8px }';
    const diff = diffThemeTokens(before, after);
    expect(diff).toEqual([{ name: 'color-accent', before: '#6f3', after: '#4a2' }]);
  });

  it('reports tokens removed (after = "")', () => {
    const before = ':root { --color-accent: #6f3; --depr: dead }';
    const after = ':root { --color-accent: #6f3 }';
    const diff = diffThemeTokens(before, after);
    expect(diff).toEqual([{ name: 'depr', before: 'dead', after: '' }]);
  });

  it('reports tokens added (before = "")', () => {
    const before = ':root { --color-accent: #6f3 }';
    const after = ':root { --color-accent: #6f3; --color-warning: orange }';
    const diff = diffThemeTokens(before, after);
    expect(diff).toEqual([{ name: 'color-warning', before: '', after: 'orange' }]);
  });

  it('returns empty list when no tokens differ', () => {
    const css = ':root { --a: 1; --b: 2 }';
    expect(diffThemeTokens(css, css)).toEqual([]);
  });

  it('FPS-run regression: silent --color-accent change is surfaced', () => {
    // Hypothetical: the fighting-game design swapped its accent mid-edit
    // without the user asking. The diff catches it so verify_artifact
    // can surface "Theme changed: color-accent 39f → c0f — intentional?"
    const before = '<style>:root { --color-accent: #39f }</style>';
    const after = '<style>:root { --color-accent: #c0f }</style>';
    const diff = diffThemeTokens(before, after);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({ name: 'color-accent', before: '#39f', after: '#c0f' });
  });
});
