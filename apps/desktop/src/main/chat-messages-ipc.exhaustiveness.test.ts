import { ChatMessageKind } from '@open-codesign/shared';
/**
 * may9 Phase 15 follow-up #29 — VALID_KINDS exhaustiveness assertion.
 *
 * Repo memory: "open-codesign chat-kind validators drift quietly —
 * adding to ChatMessageKind requires updating chat-messages-ipc.ts
 * VALID_KINDS + ChatMessageList render branch in lockstep, else rows
 * drop silently."
 *
 * The IPC `appendChatMessage` validator rejects any `kind` not in
 * VALID_KINDS. The schema's CHECK constraint and the TS union are
 * authoritative; if VALID_KINDS falls behind, every row of the new
 * kind is silently rejected and the writer logs "appendChatMessage
 * failed" then moves on. Run mow70baw-4q4ni4 lost 30+ reasoning_summary
 * rows this way before the validator was caught up.
 *
 * This test reads VALID_KINDS through the runtime export and asserts
 * it is a SUPERSET of the Zod enum's options. A future contributor
 * adding a new kind to ChatMessageKind without touching VALID_KINDS
 * gets an immediate red test instead of silent row-drops in
 * production.
 */
import { describe, expect, it } from 'vitest';
import { _getValidKindsForTests } from './chat-messages-ipc';

describe('chat-messages-ipc VALID_KINDS exhaustiveness', () => {
  it('every member of the ChatMessageKind Zod enum appears in VALID_KINDS', () => {
    const enumOptions: readonly string[] = ChatMessageKind.options;
    const validKinds: readonly string[] = _getValidKindsForTests();
    const missing = enumOptions.filter((k) => !validKinds.includes(k));
    expect(missing, `VALID_KINDS is missing kinds: ${missing.join(', ')}`).toEqual([]);
  });

  it('VALID_KINDS does not contain values outside the Zod enum', () => {
    const enumOptions: readonly string[] = ChatMessageKind.options;
    const validKinds: readonly string[] = _getValidKindsForTests();
    const stray = validKinds.filter((k) => !enumOptions.includes(k));
    expect(
      stray,
      `VALID_KINDS contains values not in ChatMessageKind: ${stray.join(', ')}`,
    ).toEqual([]);
  });
});
