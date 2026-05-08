---
'@open-codesign/desktop': minor
'@open-codesign/core': minor
'@open-codesign/shared': minor
'@open-codesign/runtime': patch
---

feat(game): may9 game-creator V2 — spec-first pipeline + universal hardening

Lands the high-leverage subset of `docs/may9.md` plus telemetry and
hardening for the universal pipeline.

**Game creator (Phases 4, 5, 8, 8b, 9b):**

- `declare_game_spec` + `amend_game_spec` — typed Zod GameSpec is now
  the mandatory first tool call in every game run. Captures
  genre / dimensions / perspective / camera / inputs / actors /
  win+lose / per-feature invariants. Persisted in
  `design_snapshots.spec_json`. Catches the brawler `c44763af` 6-correction
  class of failure and the FPS vault iteration coherence loss.
- `checkEngineFit` matrix — `choose_engine` rejects 3D fighting on
  pygame, warns on FPS-on-phaser, etc.
- `sandbox-tokens.ts` — single source of truth for iframe sandbox
  attributes (no more inline drift).
- `pointer-lock.ts` — 1.25 s re-acquire cooldown helper. Fixes the
  FPS Wave Defense `SecurityError` crash.
- `set_todos` cap (3/turn, 12/design) — was 93 in the FPS run.
- `render_preview` retired from game mode.
- Anti-slop: trigger-zone reachability, HUD-overlay safety,
  destructive-edit guardrail (40% shrink without remove-intent).
- `checkDestructiveEdit` advisory module — pure check, ready to wire
  into `done`.

**Universal (Phases 0, 7):**

- `run_usage` v3 columns: `artifact_type`, `engine`, `abort_kind`,
  `narration_dropped`, `prompt_version`, `first_tool_call_ms`.
- `classifyAbortKind` — single-source AbortKind classifier maps error
  text to a stable enum. Drives `run_usage.abort_kind` and (follow-up)
  the renderer's pill semantics.
- Eval baseline `evals/baseline-2026-05-09.md` + extraction script.

**Hardening (Phase 15):**

- `isValidSlug` + `RESERVED_SLUGS` — strict slug validator at the IPC
  boundary, complementing the permissive `slugifyArtifactName`.
- `docs/SCHEMA.md` — schema-versioning policy across SQLite, snapshot
  bundles, TOML config, shared types, IPC, and exporter formats.

**Docs (Phase 16):**

- `docs/GAME_CREATOR.md` — contributor guide. How to add an engine,
  add a genre, add a playtest playbook, where things live.

Verified phases-already-shipped (no diff but verified during the may9
audit): tool-transcript persistence (Phase 1), str_replace fuzzy match
(Phase 2), narration detector + steer (Phase 3), `done` heuristic
gating for canvas games (Phase 6), continuation chunk-loop wiring
(Phase 7), prompt-cache `'long'` for game runs (Phase 13).

Deferred — see follow-up tasks #20–30 in the may9 task list:

- Phase 9: real input → state playtest harness (hidden BrowserWindow +
  per-genre playbooks)
- Phase 10: NewDesignDialog Game-mode toggle + EnginePicker + GenrePicker UI
- Phase 11: sprite/animation tabs UX completion
- Phase 12: Kenney CC0 audio bundle vendoring + asset-fidelity routing
- Phase 14: eval framework + 4 fixtures + CI workflow
- Plus call-site wirings (spec persistence, choose_engine fit gate,
  set_todos counter, abort-pill semantics, destructive-edit advisory in
  done.ts, EscalationHint UI).

Net: 2586 → 2599 vitest cases pass; typecheck + lint green.
