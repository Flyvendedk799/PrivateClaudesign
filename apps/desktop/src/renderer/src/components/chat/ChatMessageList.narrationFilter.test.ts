/**
 * plan0305 P2.1 — narration filter for inter-tool assistant_text rows.
 *
 * The 2026-04-29 → 2026-05-03 production traces showed Claude emitting short
 * transitional prose between tool batches ("Now adding…", "Let me try…",
 * "Good, now…") that persisted as `assistant_text` rows and rendered as
 * chat bubbles. This filter recognises the pattern and suppresses it,
 * while preserving the deliverable summary at the end of each turn.
 */

import type { ChatMessageRow } from '@open-codesign/shared';
import { describe, expect, it } from 'vitest';
import { MAX_NARRATION_CHARS, isInterToolNarration } from './ChatMessageList';

function row(seq: number, kind: ChatMessageRow['kind'], payload: unknown): ChatMessageRow {
  return {
    designId: 'd1',
    seq,
    kind,
    payload: payload as ChatMessageRow['payload'],
    createdAt: new Date(seq * 1000).toISOString(),
  } as ChatMessageRow;
}

describe('isInterToolNarration (plan0305 P2.1)', () => {
  it('suppresses a 60-char narration sandwiched between tool_calls (run 490a seq 8)', () => {
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'create an animation' }),
      row(1, 'tool_call', { toolName: 'set_todos' }),
      row(2, 'tool_call', { toolName: 'str_replace_based_edit_tool' }),
      row(3, 'assistant_text', { text: 'Now adding the keyframes CSS and first components:' }),
      row(4, 'tool_call', { toolName: 'str_replace_based_edit_tool' }),
      row(5, 'tool_call', { toolName: 'str_replace_based_edit_tool' }),
    ];
    expect(isInterToolNarration(messages, 3)).toBe(true);
  });

  it('keeps the long deliverable summary at the end of a turn (run 490a seq 24)', () => {
    const longSummary =
      'The animation runs in 5 timed phases over ~6 seconds: a cold-dark open → SVG key logo self-draws stroke-by-stroke inside a glowing hex frame → brand name "KEYFORGE" slams in with a two-layer RGB glitch split → tagline letter-spacing compresses into view → a shimmer load bar progresses through game-catalog-specific copy → the ENTER STORE CTA bounces in.';
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'create' }),
      row(1, 'tool_call', { toolName: 'done' }),
      row(2, 'assistant_text', { text: longSummary }),
      row(3, 'artifact_delivered', { filename: 'index.html' }),
    ];
    expect(longSummary.length).toBeGreaterThan(MAX_NARRATION_CHARS);
    expect(isInterToolNarration(messages, 2)).toBe(false);
  });

  it('keeps a short text that is followed by artifact_delivered (final delivery)', () => {
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'go' }),
      row(1, 'tool_call', { toolName: 'done' }),
      row(2, 'assistant_text', { text: 'All done.' }),
      row(3, 'artifact_delivered', { filename: 'index.html' }),
    ];
    expect(isInterToolNarration(messages, 2)).toBe(false);
  });

  it('keeps a short text at the very end with no following messages (live tail)', () => {
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'go' }),
      row(1, 'tool_call', { toolName: 'set_todos' }),
      row(2, 'assistant_text', { text: 'thinking…' }),
    ];
    expect(isInterToolNarration(messages, 2)).toBe(false);
  });

  it('keeps a short text right before the next user message (no further tool_calls)', () => {
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'go' }),
      row(1, 'tool_call', { toolName: 'done' }),
      row(2, 'assistant_text', { text: 'Done.' }),
      row(3, 'user', { text: 'Now make it dark' }),
    ];
    expect(isInterToolNarration(messages, 2)).toBe(false);
  });

  it('suppresses chained narration: short text → tool_call → short text → tool_call', () => {
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'go' }),
      row(1, 'tool_call', { toolName: 'set_todos' }),
      row(2, 'assistant_text', { text: 'Let me try a targeted approach:' }),
      row(3, 'tool_call', { toolName: 'str_replace_based_edit_tool' }),
      row(4, 'assistant_text', { text: 'Good, now let me remove the old duplicate input:' }),
      row(5, 'tool_call', { toolName: 'str_replace_based_edit_tool' }),
    ];
    expect(isInterToolNarration(messages, 2)).toBe(true);
    expect(isInterToolNarration(messages, 4)).toBe(true);
  });

  it('keeps a long-form mid-turn explanation (>180 chars even if followed by tool_calls)', () => {
    const explanation =
      'The str_replace encoding issues are preventing me from removing the duplicate. Let me try a fresh rebuild of just the chatbot input area using the symbol approach to view the ChatInput component instead of guessing at line ranges that have drifted out of sync with the current file.';
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'go' }),
      row(1, 'tool_call', { toolName: 'set_todos' }),
      row(2, 'assistant_text', { text: explanation }),
      row(3, 'tool_call', { toolName: 'str_replace_based_edit_tool' }),
    ];
    expect(explanation.length).toBeGreaterThan(MAX_NARRATION_CHARS);
    expect(isInterToolNarration(messages, 2)).toBe(false);
  });

  it('does not suppress when an error or artifact_delivered appears in the window', () => {
    const messages: ChatMessageRow[] = [
      row(0, 'user', { text: 'go' }),
      row(1, 'tool_call', { toolName: 'set_todos' }),
      row(2, 'assistant_text', { text: 'Now adding the keyframes:' }),
      row(3, 'error', { message: 'something went wrong' }),
      row(4, 'tool_call', { toolName: 'str_replace_based_edit_tool' }),
    ];
    expect(isInterToolNarration(messages, 2)).toBe(false);
  });

  it('returns false for non-assistant_text rows (defensive)', () => {
    const messages: ChatMessageRow[] = [row(0, 'user', { text: 'go' })];
    expect(isInterToolNarration(messages, 0)).toBe(false);
  });
});
