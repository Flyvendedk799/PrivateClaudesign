/**
 * Integration A — verify_artifact wires planPlaytest + diffThemeTokens.
 *
 * Tests the runArtifactChecks options-shape overload AND the in-tool
 * lastVerifiedContent tracking via two sequential verify calls.
 */

import { describe, expect, it } from 'vitest';
import { makeVerifyArtifactTool, runArtifactChecks } from './done.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

const noopFs = (files: Record<string, string>): TextEditorFsCallbacks => ({
  view(path) {
    const content = files[path];
    if (content === undefined) return null;
    return { content, numLines: content.split('\n').length };
  },
  create() {
    throw new Error('not used');
  },
  strReplace() {
    throw new Error('not used');
  },
  insert() {
    throw new Error('not used');
  },
  listDir() {
    return Object.keys(files);
  },
});

describe('runArtifactChecks — Phase 6 advisories', () => {
  it('emits a theme-advisory when previousContent shows a token swap', async () => {
    const before = '<style>:root { --color-accent: #6f3 }</style><h1>hi</h1>';
    const after = '<style>:root { --color-accent: #4a2 }</style><h1>hi</h1>';
    const fs = noopFs({ 'index.html': after });
    const result = await runArtifactChecks(fs, undefined, 'index.html', {
      artifactType: 'design',
      previousContent: before,
    });
    const advisory = result.errors.find((e) => e.source === 'theme-advisory');
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain('color-accent');
    expect(advisory?.message).toContain('#6f3');
    expect(advisory?.message).toContain('#4a2');
  });

  it('emits a playtest-advisory when the artifact has interactivity', async () => {
    const html = `<form><input name="email" type="email"></form>`;
    const fs = noopFs({ 'index.html': html });
    const result = await runArtifactChecks(fs, undefined, 'index.html', {
      artifactType: 'design',
    });
    const advisory = result.errors.find((e) => e.source === 'playtest-advisory');
    expect(advisory).toBeDefined();
    expect(advisory?.message).toMatch(/playtest plan: \d+ steps/);
  });

  it('does NOT emit playtest-advisory on a static artifact', async () => {
    const html = '<h1>just text</h1>';
    const fs = noopFs({ 'index.html': html });
    const result = await runArtifactChecks(fs, undefined, 'index.html', {
      artifactType: 'design',
    });
    expect(result.errors.find((e) => e.source === 'playtest-advisory')).toBeUndefined();
  });

  it('skips theme-advisory + playtest-advisory in game mode (game has its own pipelines)', async () => {
    const html = `<style>:root { --color-accent: #6f3 }</style><form><input name="x"/></form>`;
    const fs = noopFs({ 'index.html': html });
    const result = await runArtifactChecks(fs, undefined, 'index.html', {
      artifactType: 'game',
      previousContent: '<style>:root { --color-accent: #fff }</style>',
    });
    expect(result.errors.find((e) => e.source === 'theme-advisory')).toBeUndefined();
    expect(result.errors.find((e) => e.source === 'playtest-advisory')).toBeUndefined();
  });

  it('first verify (no previousContent) is silent on theme-advisory', async () => {
    const html = '<style>:root { --color-accent: #6f3 }</style>';
    const fs = noopFs({ 'index.html': html });
    const result = await runArtifactChecks(fs, undefined, 'index.html', {
      artifactType: 'design',
    });
    expect(result.errors.find((e) => e.source === 'theme-advisory')).toBeUndefined();
  });

  it('back-compat: legacy string-arg signature still works', async () => {
    const html = '<h1>hi</h1>';
    const fs = noopFs({ 'index.html': html });
    const result = await runArtifactChecks(fs, undefined, 'index.html', 'design');
    expect(result.found).toBe(true);
  });
});

describe('makeVerifyArtifactTool — sequential verifies surface theme drift', () => {
  it('the SECOND verify catches a token swap the first verify did not', async () => {
    let html = '<style>:root { --color-accent: #6f3 }</style><h1>hi</h1>';
    const fs: TextEditorFsCallbacks = {
      view(path) {
        if (path !== 'index.html') return null;
        return { content: html, numLines: html.split('\n').length };
      },
      create() {
        throw new Error('not used');
      },
      strReplace() {
        throw new Error('not used');
      },
      insert() {
        throw new Error('not used');
      },
      listDir() {
        return ['index.html'];
      },
    };
    const tool = makeVerifyArtifactTool(fs, undefined, undefined, 'design');
    // First verify — establishes the anchor.
    const r1 = await tool.execute('1', {});
    const advisory1 = r1.details.errors.find((e) => e.source === 'theme-advisory');
    expect(advisory1).toBeUndefined();
    // Mutate the file — the model just patched a token.
    html = '<style>:root { --color-accent: #c0f }</style><h1>hi</h1>';
    // Second verify — sees the drift and surfaces it as advisory.
    const r2 = await tool.execute('2', {});
    const advisory2 = r2.details.errors.find((e) => e.source === 'theme-advisory');
    expect(advisory2).toBeDefined();
    expect(advisory2?.message).toContain('color-accent');
    expect(advisory2?.message).toContain('#6f3');
    expect(advisory2?.message).toContain('#c0f');
    // Status stays ok — advisory rows never trip has_errors.
    expect(r2.details.status).toBe('ok');
  });
});
