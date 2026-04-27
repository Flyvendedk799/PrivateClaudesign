import type { ChatToolCallPayload } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { summarizeToolCall } from './tool-narrative';

function call(partial: Partial<ChatToolCallPayload> & { toolName: string }): ChatToolCallPayload {
  return {
    toolName: partial.toolName,
    args: partial.args ?? {},
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? new Date().toISOString(),
    verbGroup: partial.verbGroup ?? 'Working',
    ...(partial.command !== undefined ? { command: partial.command } : {}),
    ...(partial.result !== undefined ? { result: partial.result } : {}),
  };
}

describe('summarizeToolCall', () => {
  it('narrates create of index.html as scaffold', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'create',
          args: { command: 'create', path: 'index.html' },
        }),
      ),
    ).toBe('Started the artifact scaffold');
  });

  it('narrates create of styles.css', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'create',
          args: { command: 'create', path: 'styles.css' },
        }),
      ),
    ).toBe('Added stylesheet styles.css');
  });

  it('narrates create of app.js', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'create',
          args: { command: 'create', path: 'app.js' },
        }),
      ),
    ).toBe('Added module app.js');
  });

  it('narrates view as Reading filename', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'view',
          args: { command: 'view', path: 'index.html' },
        }),
      ),
    ).toBe('Reading index.html');
  });

  it('narrates view with view_range', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'view',
          args: { command: 'view', path: 'index.html', view_range: [1, 50] },
        }),
      ),
    ).toBe('Reading index.html (lines 1-50)');
  });

  it('narrates str_replace adding a <section> as Added <heading>', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'str_replace',
          args: {
            command: 'str_replace',
            path: 'index.html',
            old_str: '<!-- placeholder -->',
            new_str: '<section><h2>Pricing</h2></section>',
          },
        }),
      ),
    ).toBe('Added Pricing');
  });

  it('narrates str_replace adding interactivity as Wired interactivity', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'str_replace',
          args: {
            command: 'str_replace',
            path: 'index.html',
            old_str: '<button>x</button>',
            new_str: '<button onClick={handleClick}>x</button>',
          },
        }),
      ),
    ).toMatch(/Wired interactivity/);
  });

  it('narrates net-negative str_replace as Trimmed', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'str_replace_based_edit_tool',
          command: 'str_replace',
          args: {
            command: 'str_replace',
            path: 'index.html',
            old_str: 'a'.repeat(200),
            new_str: 'a'.repeat(50),
          },
        }),
      ),
    ).toMatch(/^Trimmed index\.html/);
  });

  it('narrates set_todos with progress count', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'set_todos',
          args: {
            items: [
              { text: 'a', checked: true },
              { text: 'b', checked: true },
              { text: 'c', checked: false },
            ],
          },
        }),
      ),
    ).toBe('Updated plan: 2 / 3 todos done');
  });

  it('narrates done with status=ok as Verified — accepted', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'done',
          args: {},
          result: { status: 'ok', errors: [] },
        }),
      ),
    ).toBe('Verified — artifact accepted');
  });

  it('narrates done with status=has_errors with count', () => {
    expect(
      summarizeToolCall(
        call({
          toolName: 'done',
          args: {},
          result: { status: 'has_errors', errors: [{}, {}, {}] },
        }),
      ),
    ).toBe('Verifying — 3 issues to fix');
  });

  it('narrates list_design_skills', () => {
    expect(summarizeToolCall(call({ toolName: 'list_design_skills', args: {} }))).toBe(
      'Browsing the design library',
    );
  });

  it('narrates view_design_skill with skill name (without .jsx)', () => {
    expect(
      summarizeToolCall(
        call({ toolName: 'view_design_skill', args: { name: 'landing-page.jsx' } }),
      ),
    ).toBe('Loaded design skill: landing-page');
  });

  it('narrates view_frame', () => {
    expect(summarizeToolCall(call({ toolName: 'view_frame', args: { name: 'iphone.jsx' } }))).toBe(
      'Loaded device frame: iphone',
    );
  });

  it('narrates generate_image_asset with purpose', () => {
    expect(
      summarizeToolCall(
        call({ toolName: 'generate_image_asset', args: { purpose: 'hero', prompt: 'sunset' } }),
      ),
    ).toBe('Generating hero image');
  });

  it('falls back to verb-group + tool name for unknown tools', () => {
    expect(summarizeToolCall(call({ toolName: 'mystery_tool', verbGroup: 'Doing' }))).toBe(
      'Doing · mystery_tool',
    );
  });
});
