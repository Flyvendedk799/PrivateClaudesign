---
"@open-codesign/desktop": patch
"@open-codesign/shared": patch
"@open-codesign/i18n": patch
---

Fix: resume after stream interruption + reasoning UX

- Stream-interrupted aborts (the upstream Anthropic stream closing on long runs) now classify as a new `STREAM_INTERRUPTED` code instead of a generic provider error, persist a `continuation_pending` chat row capturing the latest todos + the user's most recent brief, and surface a one-click Resume CTA via the existing run-paused row.
- `continueRun` eagerly loads chat history and passes it to `sendPrompt`, so resume works even when the renderer's in-memory `chatMessages` was cleared by an error path. Free-text "continue" / "resume" / "keep going" prompts auto-route through this flow when a fresh `continuation_pending` row exists.
- `buildHistoryFromChat` now logs and records a diagnostic event on failure instead of silently returning `[]`.
- Live chat UI: tool-only lulls no longer mislabel themselves as "Thinking…" — the placeholder now reads "Working…" and is suppressed entirely while a tool is running. Consecutive tool calls split into a new WorkingCard after a >30s wall-clock gap so long stalled buckets stop reading as one undifferentiated brick.
- Diagnostic logs added to the `reasoning_summary` rollup path so a future "no reasoning rows persisted" investigation can pinpoint whether the model is silent or the writer is failing.
