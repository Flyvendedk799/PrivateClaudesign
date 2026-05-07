import type { ChatToolCallPayload } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { buildRows } from '../WorkingCard';

function call(
  p: Partial<ChatToolCallPayload> & Pick<ChatToolCallPayload, 'toolName'>,
): ChatToolCallPayload {
  return {
    args: {},
    status: 'done',
    startedAt: '2026-04-20T00:00:00.000Z',
    verbGroup: 'Working',
    ...p,
  };
}

describe('WorkingCard.buildRows', () => {
  it('merges consecutive str_replace edits to the same path into one row', () => {
    const calls = [
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html' },
      }),
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html' },
      }),
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html' },
      }),
    ];
    const rows = buildRows(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe('index.html');
    expect(rows[0]?.editCount).toBe(3);
    expect(rows[0]?.label).toBe('edit');
  });

  it('merges legacy text-editor calls without command field', () => {
    // Old chat_messages rows persisted before `command` was plumbed.
    const calls = [
      call({ toolName: 'str_replace_based_edit_tool', args: { path: 'index.html' } }),
      call({ toolName: 'str_replace_based_edit_tool', args: { path: 'index.html' } }),
      call({ toolName: 'str_replace_based_edit_tool', args: { path: 'index.html' } }),
    ];
    const rows = buildRows(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.editCount).toBe(3);
    // Should not leak the verbose tool name into the label.
    expect(rows[0]?.label).toBe('edit');
  });

  it('keeps the merge run across an in-between set_todos call', () => {
    const calls = [
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html' },
      }),
      call({
        toolName: 'set_todos',
        args: { items: [{ text: 'wrap header', checked: true }] },
      }),
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html' },
      }),
    ];
    const rows = buildRows(calls);
    // 1 merged edit row + 1 todos row.
    expect(rows).toHaveLength(2);
    const editRow = rows.find((r) => r.detail === 'index.html');
    expect(editRow?.editCount).toBe(2);
  });

  it('keeps separate rows for different paths', () => {
    const calls = [
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'a.html' },
      }),
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'b.html' },
      }),
    ];
    const rows = buildRows(calls);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.detail)).toEqual(['a.html', 'b.html']);
  });

  it('promotes any running edit status to the merged row', () => {
    const calls = [
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html' },
        status: 'done',
      }),
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html' },
        status: 'running',
      }),
    ];
    const rows = buildRows(calls);
    expect(rows[0]?.status).toBe('running');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Plan 2026-05-08 P2 — inline +N/−M diff stats on every Edit/Create row.
//
// The row already carries a `diffPayload` so `DiffBlock` can render the
// full diff on click. The user wants the totals visible at-a-glance next
// to the path so they don't have to expand every row to see edit size.
// `buildRows` must compute the totals by feeding `oldText`/`newText`
// through `lineDiff` (context: 0, maxLines: very large) and counting kinds.
// ─────────────────────────────────────────────────────────────────────────

describe('WorkingCard.buildRows — diffStats (plan 2026-05-08 P2)', () => {
  it('attaches diffStats with line-add/remove counts to a str_replace row', () => {
    const oldText = 'line 1\nline 2\nline 3';
    const newText = 'line 1\nline 2 changed\nline 3\nline 4 added';
    // lineDiff is prefix/suffix-anchored. Prefix = 'line 1' (1 line); the
    // trailing anchor breaks because newText's last line ('line 4 added')
    // doesn't match oldText's last line ('line 3'). So the algorithm
    // collapses lines 2-3 of oldText into "removed" and lines 2-4 of
    // newText into "added". → added=3, removed=2.
    const rows = buildRows([
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html', old_str: oldText, new_str: newText },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diffStats).toEqual({ added: 3, removed: 2 });
  });

  it('attaches diffStats to a create row (oldText empty)', () => {
    const newText = 'line 1\nline 2\nline 3';
    const rows = buildRows([
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'create',
        args: { path: 'index.html', file_text: newText },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diffStats).toEqual({ added: 3, removed: 0 });
  });

  it('does not attach diffStats when the call has no diff payload (e.g. a `view`)', () => {
    const rows = buildRows([
      call({ toolName: 'str_replace_based_edit_tool', command: 'view', args: { path: 'x.html' } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diffStats).toBeUndefined();
  });

  it('uses the most-recent diff payload when consecutive str_replaces are merged', () => {
    const calls = [
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: { path: 'index.html', old_str: 'a', new_str: 'b' },
      }),
      call({
        toolName: 'str_replace_based_edit_tool',
        command: 'str_replace',
        args: {
          path: 'index.html',
          old_str: 'foo\nbar',
          new_str: 'foo\nbar\nbaz\nqux',
        },
      }),
    ];
    const rows = buildRows(calls);
    // Merged into 1 row; diffStats reflects the latest call (added 2 lines).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.editCount).toBe(2);
    expect(rows[0]?.diffStats).toEqual({ added: 2, removed: 0 });
  });
});
