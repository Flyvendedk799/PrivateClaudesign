import type { ChatMessageRow, ChatToolCallPayload } from '@open-codesign/shared';
import type Database from 'better-sqlite3';
import { listChatMessages } from './snapshots-db';

const MAX_BRIEF_LEN = 2000;
const MAX_RECAP_LEN = 1600;

export interface AbortContinuationRecap {
  decisionRecap: string;
  todoSnapshotSeq?: number;
  lastUserBrief?: string;
}

/**
 * 2026-05-07 — assemble the minimum context the renderer's resume flow
 * needs to rebuild a useful continuation prompt after an unplanned abort.
 *
 * Pulled from `chat_messages` only — no FS access, no IPC. Pure-ish: the
 * `db` arg is a better-sqlite3 handle but everything we read is the same
 * data the renderer already has via `listChatMessages`.
 *
 * Invariants:
 *  - `decisionRecap` is non-empty even when the design has no assistant
 *    text yet (falls back to a generic stub) so the row is always
 *    well-formed.
 *  - `lastUserBrief` skips literal resume verbs ("continue" / "resume")
 *    so the brief is the user's actual objective, not their resume cue.
 *  - `todoSnapshotSeq` is set only when a `set_todos` row exists; absent
 *    otherwise so callers don't have to guard against -1 sentinels.
 */
export function buildAbortContinuationRecap(
  db: Database.Database,
  designId: string,
): AbortContinuationRecap {
  const rows = listChatMessages(db, designId);
  return computeAbortContinuationRecap(rows);
}

const RESUME_VERB_RX = /^(continue|resume|keep going|proceed|go on)\.?$/i;

function takePrefix(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Pure-function variant for unit tests — operates on an already-loaded
 * row array. The DB-bound `buildAbortContinuationRecap` is a one-line
 * wrapper that calls `listChatMessages` and forwards.
 */
export function computeAbortContinuationRecap(
  rows: readonly ChatMessageRow[],
): AbortContinuationRecap {
  let lastAssistantText: string | undefined;
  let lastUserBrief: string | undefined;
  let todoSnapshotSeq: number | undefined;

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    if (todoSnapshotSeq === undefined && row.kind === 'tool_call') {
      const payload = row.payload as ChatToolCallPayload | null;
      if (payload && payload.toolName === 'set_todos') {
        todoSnapshotSeq = row.seq;
      }
    }
    if (lastAssistantText === undefined && row.kind === 'assistant_text') {
      const payload = row.payload as { text?: string } | null;
      const text = payload?.text;
      if (typeof text === 'string' && text.trim().length > 0) {
        lastAssistantText = text.trim();
      }
    }
    if (lastUserBrief === undefined && row.kind === 'user') {
      const payload = row.payload as { text?: string } | null;
      const text = payload?.text?.trim();
      if (typeof text === 'string' && text.length > 0 && !RESUME_VERB_RX.test(text)) {
        lastUserBrief = takePrefix(text, MAX_BRIEF_LEN);
      }
    }
    if (
      todoSnapshotSeq !== undefined &&
      lastAssistantText !== undefined &&
      lastUserBrief !== undefined
    ) {
      break;
    }
  }

  const decisionRecap =
    lastAssistantText !== undefined
      ? takePrefix(lastAssistantText, MAX_RECAP_LEN)
      : 'Run was interrupted before producing a final summary.';

  return {
    decisionRecap,
    ...(todoSnapshotSeq !== undefined ? { todoSnapshotSeq } : {}),
    ...(lastUserBrief !== undefined ? { lastUserBrief } : {}),
  };
}
