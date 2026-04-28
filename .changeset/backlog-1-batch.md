---
"@open-codesign/desktop": minor
"@open-codesign/core": minor
"@open-codesign/providers": minor
"@open-codesign/shared": minor
"@open-codesign/i18n": patch
---

Implements `docs/backlog-1.md` in full (10 items):

- **#4 build/lazy-load**: providers + skills/loader no longer trigger Vite "dynamic import will not move module into another chunk" warnings; both now load consistently across importers.
- **#3 read_url**: bounded fetch (15 s) + body drain (5 s) via `AbortSignal.any` + `AbortSignal.timeout`; throws typed `CodesignError` with `REFERENCE_URL_FETCH_TIMEOUT`. The 4 KB body cap stays.
- **#5 read_url tests**: vitest coverage for happy path, network error, non-2xx, body cap, body-drain timeout, and HTML-stripper edge cases (entities, block tags, script/style, whitespace, nested-tag flattening).
- **#6 chat schema validation**: `chat_messages` rows now persist `schema_version` (additive migration); `rowToChatMessage` throws `SchemaMismatchError` for forward-incompat rows; `listChatMessages` skips them with a logged warning so a single bad row doesn't break the whole sidebar. New `CHAT_SCHEMA_MISMATCH` error code.
- **#7 prefs migration persistence**: the v5 → v6 `generationTimeoutSec` migration was read-time only; it now writes back so the on-disk file actually bumps to schemaVersion 6.
- **#8 generate dedup**: `codesign:v1:generate` collapses duplicate concurrent IPC calls — by `generationId` (a duplicate IPC of the same submit) and by content fingerprint (a double-click that minted distinct ids). Extracted `findInFlightDuplicate` for unit-testing.
- **#10 Babel-aware linter**: `done.ts` no longer flags JSX self-closing component tags or `<Image src=… />` as unclosed/missing-alt when the artifact is a `<script type="text/babel">` payload. `findDuplicateIds` still runs (valid in either runtime); plain HTML still gets the HTML-only checks.
- **#1 OAuth refresh**: `SecretRef` extended with optional `expiresAt`, `refreshToken`, `oauthClientId`. New `refreshClaudeCodeToken` helper in `@open-codesign/providers` with in-flight dedup + typed `CLAUDE_CODE_TOKEN_REFRESH_FAILED` / `CLAUDE_CODE_REIMPORT_REQUIRED` error codes. New `readClaudeCodeKeychainCredentials` (Darwin-only `security` shell-out) captures the refresh blob at import time. `runImportClaudeCode` persists refreshable identities via new `buildOAuthSecretRef`. New `ensureFreshClaudeCodeToken` runs ahead of every `resolveApiKeyForActive` so requests transparently refresh on near-expiry, and the renderer's toast pipeline shows a one-click "Re-import Claude Code" banner when `CLAUDE_CODE_REIMPORT_REQUIRED` bubbles up.
- **#2 preview device toggle**: 3-button segmented control on `PreviewToolbar` (Monitor / Tablet / Smartphone, lucide-react), wired to the existing `previewViewport` Zustand state. Iframe sees a real responsive viewport (no scaling). Defaults to desktop. i18n keys added for en, zh-CN, pt-BR.
- **#9 prompt-assist**: new `PromptAssistMetadataV1` schema (`audience` / `device` / `depth` / `primaryAction` / `vibe` / `a11y`); `Design.promptAssistMetadata` column via additive migration; `snapshots:v1:set-prompt-assist` IPC; `composeSystemPrompt({ promptAssist })` injects the picks as a structured `<design-constraints>` XML block on initial generation AND every refinement turn (applyComment now carries an optional `designId` so it can read the same metadata). New `PromptAssistDialog` interstitial intercepts sub-120-char submissions for designs without metadata, presents 5 chip rows (audience/device/depth/vibe/a11y) with auto-skip after 5s, persists picks via the new IPC, then resumes `sendPrompt`. i18n added in en, zh-CN, pt-BR.
