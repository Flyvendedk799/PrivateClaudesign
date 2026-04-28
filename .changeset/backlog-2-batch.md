---
"@open-codesign/desktop": minor
"@open-codesign/core": minor
"@open-codesign/templates": minor
"@open-codesign/shared": minor
"@open-codesign/i18n": patch
---

Implements `docs/backlog-2.md` in full (7 net-new items, post-mortem of the 2026-04-27 mobile e-learning run). Two backlog-2 items already shipped via backlog-1 (prompt-assist for short prompts → backlog-1 #9; Babel-aware post-gen linter → backlog-1 #10) and are cross-referenced rather than redone.

- **#1 text_editor write ceilings**: `MAX_CREATE_BYTES_INDEX` 8K → 24K, `MAX_STR_REPLACE_NEW_BYTES_INDEX` 12K → 24K, `MAX_STR_REPLACE_NEW_BYTES_SIDECAR` 32K → 48K. New cap on `insert` mirrors `create` semantics — no more silently slipping oversized inserts through. A 5-screen mobile prototype now lands in 1–2 writes instead of ~6 sliced str_replace inserts.
- **#2 view by JSX symbol**: `text_editor view path symbol=LessonScreen` returns the body of a top-level function or const declaration. New hand-rolled `extractJsxSymbol` lexer (no Babel/Acorn dependency) is string/comment/template-literal aware; misses surface a candidate-list error, ambiguity surfaces line numbers. 12 + 4 new tests.
- **#3 active-file-aware context pruner**: `findActiveFile` walks tool calls newest→oldest and identifies the most-recent `text_editor` path. The last 6 toolResult blocks for that path stay un-pruned even when aggressive mode fires. Late-run `view index.html` calls stop paying tokens to re-establish state the runtime had just thrown away.
- **#4 anti-slop additions**: new top-level "## Touch targets" (44 px tap target / 8 px gap / 16 px input) and "## Iconography" (no emoji-as-icon when an icon set is in scope) sections in `anti-slop.v1.txt` + the `ANTI_SLOP_DIGEST` mirror. Mechanical and verifiable rules, scoped to mobile artifacts.
- **#5 render_preview tool**: new agent tool returning a PNG screenshot at a preset viewport (iphone 390×844, ipad 768×1024, desktop 1440×900). Hidden-BrowserWindow pipeline mirrors `done-verify.ts`; pi-ai's `ImageContent` block lets the model read the screenshot directly. Auto-degrades when the host doesn't supply a renderer (vitest, headless CI).
- **#6 mobile-flow template, keyword-routed**: new hardcoded scaffold in `@open-codesign/templates` (TabBar, screen-routing without a router lib, safe-area handling, lesson/quiz scaffolding, "what NOT to do" list keyed to the e-learning trace's specific failures). Routed via `composeSystemPrompt` keyword matcher when the prompt includes mobile / iOS / iPhone / iPad / 手机 / 移动端 — pays tokens only when relevant.
- **#7 Skills hub tab + in-app authoring**: new `UserSkillV1` schema, `user_skills` SQLite table, `skills:v1:*` IPC channels (list / get / create / update / delete + extract-from-design), agent integration so user-authored skills surface alongside the bundled set in `list_design_skills` / `view_design_skill`, and a Skills hub tab with manual-create modal. The region-capture overlay is intentionally a follow-up; the IPC channel is wired and the form-based path covers the canonical author-by-hand case.
