import { z } from 'zod';

export const DesignSnapshotV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  designId: z.string().min(1),
  parentId: z.string().nullable(),
  type: z.enum(['initial', 'edit', 'fork']),
  prompt: z.string().nullable(),
  artifactType: z.enum(['html', 'react', 'svg', 'game', 'motion']),
  artifactSource: z.string(),
  createdAt: z.string(),
  message: z.string().optional(),
  /** Engine pin for game-mode snapshots (gameplan §6). NULL on every
   *  design-mode snapshot; required when artifactType === 'game'. */
  engine: z.enum(['three', 'phaser', 'pygame', 'godot']).nullable().optional(),
  /** Free-text engine version pin (gameplan §6, Appendix). e.g.
   *  '0.170.0' for Three.js, '3.88.0' for Phaser, '2.5.5' for pygame-ce,
   *  '4.3' for Godot. */
  engineVersion: z.string().nullable().optional(),
  /** may9 Phase 4 — serialized GameSpec JSON. Round-trips through the
   *  snapshot row so follow-up turns can re-inject the spec into the
   *  system prompt without the user re-stating it. NULL on design +
   *  motion runs. Validated against the GameSpec schema in `game-spec.ts`
   *  on read; on parse failure callers should treat it as absent
   *  (forward-compat). */
  specJson: z.string().nullable().optional(),
});
export type DesignSnapshot = z.infer<typeof DesignSnapshotV1>;

/** v1 schema for prompt-assist chip selections. Captured before the agent
 *  runs when the prompt is short and underspecified (see backlog-1 #9), and
 *  injected into the system prompt as structured constraints on every
 *  generation for the design (initial + refinements).
 *
 *  paletteHint (plan0305 P4.2) is a free-text palette steer captured when
 *  the user overrides the model's palette choice in conversation
 *  (e.g. "actually use warm wood + cream + iron, not dark + cyan"). The
 *  renderer writes this into the design's metadata via the existing
 *  `setDesignPromptAssistMetadata` IPC so refinement runs honor the steer
 *  rather than regressing to the model's first instinct (often dark+cyan
 *  per the cosmic-by-default bias the rest of plan0305 fixes). Deliberately
 *  free-text, not an enum, because palette directives are open-ended.
 */
export const PromptAssistMetadataV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  audience: z.string().optional(),
  device: z.enum(['desktop', 'tablet', 'mobile']).optional(),
  depth: z.enum(['quick', 'standard', 'deep']).optional(),
  primaryAction: z.string().optional(),
  vibe: z.string().optional(),
  a11y: z.enum(['baseline', 'enhanced']).optional(),
  paletteHint: z.string().optional(),
});
export type PromptAssistMetadata = z.infer<typeof PromptAssistMetadataV1>;

export const DesignV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().default('Untitled design'),
  createdAt: z.string(),
  updatedAt: z.string(),
  thumbnailText: z.string().nullable().default(null),
  deletedAt: z.string().nullable().default(null),
  workspacePath: z.string().nullable().default(null),
  /** Per-design constraints captured by the prompt-assist interstitial.
   *  Optional — long prompts skip the dialog entirely and leave this null. */
  promptAssistMetadata: PromptAssistMetadataV1.nullable().default(null).optional(),
  /** In-design "new conversation" pointer — see snapshots-db.newChatSession.
   *  Optional in the inferred type so legacy fixtures don't have to set it;
   *  consumers read it via `design.currentSessionId ?? 0` or fetch fresh via
   *  the dedicated IPC. The DB always materialises a value (default 0). */
  currentSessionId: z.number().int().nonnegative().optional(),
});
export type Design = z.infer<typeof DesignV1>;

export const DesignMessageV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  designId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  ordinal: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type DesignMessage = z.infer<typeof DesignMessageV1>;

export const ChatMessageKind = z.enum([
  'user',
  'assistant_text',
  'tool_call',
  'artifact_delivered',
  'error',
  // Backlog-3 §5 — cancel-checkpoint row. Written when the user clicks
  // "Stop & checkpoint"; payload carries enough state to resume from
  // the same design with the prior agent's history rehydrated.
  'checkpoint',
  // Phase 2 — adaptive-thinking rollup persisted at thinking_end →
  // tool_draft_start. Payload: { fullText, toolName?, durationMs }. The
  // renderer renders these as a clickable, collapsible reasoning pill;
  // the full thinking text survives reload without dominating the chat
  // viewport. Replaces ephemeral streamingThinking-only display.
  'reasoning_summary',
  // Phase 4 — first-class continuation marker. The model (or runtime
  // threshold check) decided the run should pause cleanly instead of
  // truncating. Payload: { reason, todoSnapshotSeq?, decisionRecap,
  // outputTokens, contextUsedPct, wallClockMs }. Renderer shows a
  // non-modal "Continue" button + auto-continue toggle.
  'continuation_pending',
]);
export type ChatMessageKind = z.infer<typeof ChatMessageKind>;

/**
 * Row from the chat_messages table. `payload` is a JSON string on disk; the
 * typed variants are parsed at the IPC boundary. Schema must anticipate
 * Phase 2 tool events (tool_call with verbGroup) even though Phase 1 only
 * emits user / assistant_text / artifact_delivered.
 */
export const ChatMessageRowV1 = z.object({
  // Accepts both v1 and v2 — the on-disk shape is identical at the row
  // level (only the semantic of `payload.status` for tool_call rows
  // changed in v2). Renamed schema would require a coordinated rename
  // across many call sites; keeping `ChatMessageRowV1` as the supported
  // reader for both versions is the lower-friction path.
  schemaVersion: z.union([z.literal(1), z.literal(2)]).default(2),
  id: z.number().int(),
  designId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  kind: ChatMessageKind,
  payload: z.unknown(),
  snapshotId: z.string().nullable(),
  createdAt: z.string(),
  /** Partition key for the in-design "new conversation" feature. Rows
   *  written before that feature shipped read back as 0 (the default
   *  bucket). The history-builder filters to the design's
   *  `current_session_id` before sending to the LLM, so prior sessions
   *  are visible in the UI but pay no token cost on subsequent runs.
   *  Optional in the inferred type so fixtures predating the field
   *  don't have to be updated; the DB always materialises a value. */
  sessionId: z.number().int().nonnegative().optional(),
});
export type ChatMessageRow = z.infer<typeof ChatMessageRowV1>;

/** Current on-disk schema version for `chat_messages` rows. Bump together
 *  with `migrateChatMessageRow` in the main process when shapes change.
 *
 *  Version history:
 *  - v1 — initial. tool_call payloads always landed with `status: 'done'`
 *         regardless of actual outcome; failed executions were
 *         indistinguishable from successful ones in the chat history.
 *  - v2 (plan0305 P3.1) — tool_call payloads now record `status: 'error'`
 *         when the runtime flagged the call as a failure. Forward-migration
 *         of v1 rows is identity (they keep `status: 'done'` meaning
 *         "outcome unknown — assume done"). Renderer treats both as valid.
 */
export const CHAT_MESSAGE_SCHEMA_VERSION = 2 as const;

export interface ChatAppendInput {
  designId: string;
  kind: ChatMessageKind;
  payload: unknown;
  snapshotId?: string | null;
  /** Persisted alongside the row so the read path can refuse / migrate
   *  forward-incompatible rows. Defaults to the current writer version. */
  schemaVersion?: typeof CHAT_MESSAGE_SCHEMA_VERSION;
}

// Payload shapes (not strictly validated — payload is opaque JSON in DB).
export interface ChatUserPayload {
  text: string;
  attachedSkills?: string[];
}
export interface ChatAssistantTextPayload {
  text: string;
}
export interface ChatArtifactDeliveredPayload {
  filename?: string;
  createdAt: string;
}
export interface ChatErrorPayload {
  message: string;
  code?: string;
  runId?: string;
}
export interface ChatToolCallPayload {
  toolName: string;
  command?: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: unknown;
  error?: { message: string; code?: string };
  startedAt: string;
  durationMs?: number;
  verbGroup: string;
  toolCallId?: string;
}
/** Phase 2 — adaptive-thinking rollup. Persisted at thinking_end →
 *  tool_draft_start so the chat survives reload without losing the model's
 *  reasoning trace. The renderer collapses these into a single-line pill
 *  ("Reasoned for 12s · 1.4k tokens — click to expand") so the chat stays
 *  scannable but the full text is one click away. */
export interface ChatReasoningSummaryPayload {
  /** Verbatim concatenation of the run's `thinking_delta` chunks for this
   *  burst. Token count is approximate and is encoded as
   *  `tokenEstimate = Math.ceil(fullText.length / 4)` by the writer. */
  fullText: string;
  /** Wall-clock duration of the thinking burst. */
  durationMs: number;
  /** Approximate token count — `Math.ceil(fullText.length / 4)`. Stored so
   *  the renderer doesn't have to recompute on every render. */
  tokenEstimate: number;
  /** The next tool the model committed to after this thinking burst, if
   *  any. Captured by the agent stream when tool_draft_start fires; absent
   *  when the burst was followed by user-visible text instead. */
  toolName?: string;
  /** ISO timestamp of when the rollup was finalised (thinking_end). */
  finalisedAt: string;
}
/** Phase 4 — first-class continuation marker. The runtime decided this run
 *  should pause cleanly (vs. truncate) because one of the documented
 *  thresholds tripped: context %, output tokens, wall-clock, or the model
 *  itself emitted `pause_for_continuation`. The renderer shows a non-modal
 *  "Continue" button + auto-continue toggle. The continuation prompt is
 *  reconstructed from `decisionRecap`, the latest set_todos, and current
 *  FS state (NOT a full transcript replay — that's how Phase 4 reclaims
 *  the cache-miss tail). */
export interface ChatContinuationPendingPayload {
  /** Why the run paused. Drives the "Continue" CTA copy and the recap
   *  prompt template. `unplanned_abort` is added 2026-05-07 for stream
   *  interruptions that did not go through the soft-cancel path. */
  reason:
    | 'context_threshold'
    | 'output_budget'
    | 'wall_clock'
    | 'model_requested'
    | 'manual'
    | 'unplanned_abort';
  /** Latest set_todos seq at pause time, if one exists. The continuation
   *  prompt embeds that snapshot verbatim. */
  todoSnapshotSeq?: number;
  /** ≤400-token rolled-up "what was decided + what is next" written at the
   *  cut point. Reconstructed by `buildContinuationPrompt` (Phase 4). */
  decisionRecap: string;
  outputTokens: number;
  contextUsedPct: number;
  wallClockMs: number;
  /** 2026-05-07 — the user's most recent task-defining brief at the
   *  cut point. The continuation prompt prefers this over the design's
   *  first-ever user message because long-running designs accumulate
   *  multiple briefs and resume should reflect the *current* objective.
   *  Optional for backwards compatibility with rows written before
   *  this field existed. */
  lastUserBrief?: string;
}

// ---------------------------------------------------------------------------
// Virtual FS (Workstream E — Phase 2 agent tools)
//
// Per-design file tree stored in SQLite, written by the text_editor tool via
// the agent runtime. Paths are POSIX-relative ("index.html",
// "_starters/ios-frame.jsx"); never absolute, never contain "..".
// ---------------------------------------------------------------------------

export const DesignFileV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  designId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DesignFile = z.infer<typeof DesignFileV1>;

// ---------------------------------------------------------------------------
// Comments (Workstream D — inline comment mode)
// ---------------------------------------------------------------------------

export const CommentKind = z.enum(['note', 'edit']);
export type CommentKind = z.infer<typeof CommentKind>;

export const CommentStatus = z.enum(['pending', 'applied', 'dismissed']);
export type CommentStatus = z.infer<typeof CommentStatus>;

/** Whether a comment instructs the model to change just the pinned element
 *  ("element") or to consider the change a global directive that may touch
 *  the rest of the design ("global"). Defaults to "element" for back-compat
 *  with rows written before the v2 enrichment landed. */
export const CommentScope = z.enum(['element', 'global']);
export type CommentScope = z.infer<typeof CommentScope>;

export const CommentRect = z.object({
  top: z.number(),
  left: z.number(),
  width: z.number(),
  height: z.number(),
});
export type CommentRect = z.infer<typeof CommentRect>;

export const CommentRowV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  designId: z.string().min(1),
  snapshotId: z.string().min(1),
  kind: CommentKind,
  selector: z.string(),
  tag: z.string(),
  outerHTML: z.string(),
  rect: CommentRect,
  text: z.string(),
  status: CommentStatus,
  createdAt: z.string(),
  appliedInSnapshotId: z.string().nullable(),
  /** v2 enrichment — defaults to 'element' for rows from v1. */
  scope: CommentScope.default('element').optional(),
  /** v2 enrichment — parent element's outerHTML (truncated). Optional so
   *  pre-v2 rows still parse without it. */
  parentOuterHTML: z.string().optional(),
});
export type CommentRow = z.infer<typeof CommentRowV1>;

export interface CommentCreateInput {
  designId: string;
  snapshotId: string;
  kind: CommentKind;
  selector: string;
  tag: string;
  outerHTML: string;
  rect: CommentRect;
  text: string;
  scope?: CommentScope;
  parentOuterHTML?: string;
}

export interface CommentUpdateInput {
  text?: string;
  status?: CommentStatus;
}

export interface SnapshotCreateInput {
  designId: string;
  parentId: string | null;
  type: 'initial' | 'edit' | 'fork';
  prompt: string | null;
  artifactType: 'html' | 'react' | 'svg' | 'game' | 'motion';
  artifactSource: string;
  message?: string;
  /** Game-mode only — engine pin for the snapshot. (gameplan §6) */
  engine?: 'three' | 'phaser' | 'pygame' | 'godot' | null;
  engineVersion?: string | null;
  /** may9 Phase 4 — serialized GameSpec JSON. Persisted alongside the
   *  snapshot so the next follow-up turn can re-inject the spec into
   *  the system prompt and `amend_game_spec` can patch it. Validated
   *  via the GameSpec Zod schema in `@open-codesign/shared/game-spec`
   *  on read; null for design + motion runs. */
  specJson?: string | null;
}

// ---------------------------------------------------------------------------
// User-authored skills (backlog-2 #7) — the "Skills hub tab" output of the
// in-app authoring flow. Persisted alongside the built-in DESIGN_SKILLS so
// the agent can `view_design_skill` either kind on the next generation.
// ---------------------------------------------------------------------------

export const UserSkillV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  /** Slug-form label the agent matches against. Must be a valid jsx file
   *  stem (e.g. `mobile-tab-bar`, `lesson-row`) so it round-trips through
   *  the existing `view_design_skill name` parameter. */
  name: z.string().min(1).max(80),
  /** One-sentence "when to use" hint shown in `list_design_skills`. The
   *  agent reads this to decide whether to pull the source. */
  whenToUse: z.string().min(1).max(500),
  /** JSX/HTML body of the skill — already parameterised (placeholders for
   *  copy, design tokens for colour) so it's reusable. Capped well above
   *  the text-editor ceilings; a 50 KB skill is plenty. */
  source: z.string().min(1).max(50_000),
  /** Origin design id (NULL when imported from elsewhere). FK with
   *  ON DELETE SET NULL so deleting the design doesn't cascade away the
   *  skill. */
  sourceDesignId: z.string().nullable(),
  /** Origin snapshot id (NULL when imported / when the design has no
   *  snapshots yet). */
  sourceSnapshotId: z.string().nullable(),
  /** Region rect captured from the source iframe at extraction time.
   *  Reuses the existing CommentRect schema. NULL when the user authored
   *  the skill without picking a region (e.g. typed it manually). */
  sourceRect: CommentRect.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserSkill = z.infer<typeof UserSkillV1>;

export interface UserSkillCreateInput {
  name: string;
  whenToUse: string;
  source: string;
  sourceDesignId?: string | null;
  sourceSnapshotId?: string | null;
  sourceRect?: CommentRect | null;
}

export interface UserSkillUpdateInput {
  name?: string;
  whenToUse?: string;
  source?: string;
}

export interface UserSkillExtractInput {
  designId: string;
  snapshotId: string;
  rect: CommentRect;
  /** What the user wants extracted ("a reusable mobile tab bar", "the
   *  lesson row component", …). The extractor LLM uses it to scope the
   *  output to the relevant subtree. */
  userPrompt: string;
}
