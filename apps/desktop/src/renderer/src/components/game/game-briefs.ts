/**
 * Centralized pre-flighted briefs that the game-mode tabs drop into the
 * prompt draft via `setPromptDraft`. Tight scoping is intentional —
 * historically the agent has rewritten the whole game when given any
 * weapon/HUD-shaped prompt (see
 * .claude/workspace/2026-05-08-pause-prune-continuation-fix.md). Each
 * brief explicitly:
 *  - names canonical paths the indexer recognises
 *  - lists the asset slugs that should be created
 *  - forbids touching unrelated game logic
 *  - mandates verify_artifact + render_preview after edits
 *  - hands off other concerns to dedicated briefs (so the Decompose
 *    orchestrator doesn't redundantly touch the same code from three
 *    angles)
 *
 * The briefs live in this module (not inline in their tab views) so the
 * unified "Decompose game" orchestrator (Phase 8.2) can sequence them
 * in a single workflow without re-importing each tab's component.
 */

export const SPRITE_EXTRACTION_BRIEF = [
  'Decompose the inline weapon / character viewmodels in `index.html` into',
  'sprite files so the Sprites tab can index them.',
  '',
  'For each major `<svg>` block representing a discrete asset, extract the markup',
  'into a new file at `assets/sprites/<slug>/sprite.svg` (slug = stable kebab-case',
  'name, e.g. `m4a1`, `desert-eagle`, `knife`, `enemy-grunt`).',
  '',
  'Hard rules:',
  '- DO NOT rewrite unrelated parts of `index.html`. Make targeted edits only.',
  '- Keep the in-game render working — either reference the sprite via `<img>` /',
  '  fetch + inline, or duplicate the markup. Visual parity is mandatory.',
  '- After each extraction call `verify_artifact` and `render_preview` to confirm',
  '  the game still loads. If a render shows the scene gone, revert that edit.',
  '- Do NOT change game logic, weapon switching, melee combos, or animations.',
  '- Do NOT extract level / world data here — those have dedicated briefs',
  '  ("Extract from existing game" on the Levels tab, "Generate world graph"',
  '  on the World tab). Stay focused on visual sprite assets.',
  '- After all extractions, call `done`.',
].join('\n');

export const ANIMATION_EXTRACTION_BRIEF = [
  'Decompose the inline animation cycles in `index.html` into animation clips so the',
  'Animations tab can index them.',
  '',
  'For each distinct cycle (reload, fire, melee combos, ADS, jump, vault, idle breathing),',
  'extract the keyframe data + timing into a new file at',
  '`assets/animations/<slug>/clip.json` (slug = stable kebab-case name, e.g.',
  '`reload-m4`, `melee-combo-0`, `melee-combo-1`, `idle-breathing`).',
  '',
  'Each clip JSON should follow this minimal shape:',
  '```',
  '{ "name": "<slug>", "durationMs": <number>, "fps": 60,',
  '  "tracks": [ { "target": "<bone>", "property": "<rotation|position|scale>",',
  '                "values": [{ "tMs": 0, "value": [...] }, ...] } ] }',
  '```',
  '',
  'Hard rules:',
  '- DO NOT rewrite unrelated parts of `index.html`. Make targeted edits only.',
  '- Keep the in-game animations playing — extract the data; reference the clip',
  '  files from `index.html` or duplicate the data inline. Visual parity is mandatory.',
  '- After each extraction call `verify_artifact` and `render_preview` to confirm',
  '  the game still renders. If a render shows the scene gone, revert that edit.',
  '- Do NOT change game logic, weapon switching, or sprite geometry.',
  '- Do NOT extract level / world data here — those have dedicated briefs',
  '  ("Extract from existing game" on the Levels tab, "Generate world graph"',
  '  on the World tab). Stay focused on animation cycles.',
  '- After all extractions, call `done`.',
].join('\n');

export const DEFINE_LEVEL_SCHEMA_BRIEF = [
  'Decide the level shape for this game.',
  '',
  'Steps:',
  '1. Read `index.html` to understand the genre (FPS, tilemap, dialogue tree,',
  '   wave defense, etc.). Read `assets/sprites/_registry.json` if present.',
  '2. Pick exactly ONE of the canonical level kinds:',
  '   - `tilemap-2d` (2D platformer / top-down RPG / roguelike)',
  '   - `scene-3d` (3D FPS / third-person / city-builder)',
  '   - `node-graph` (dialogue / state-machine / puzzle)',
  '   - `wave-script` (wave-defense / arena)',
  '   - `freeform-json` (bailout — only if none of the above fit)',
  '3. Write `assets/levels/_schema.json` declaring the chosen kind. Schema:',
  '   `{ schemaVersion: 1, kind: "<chosen>", notes: "<reasoning>", defaults: {...} }`.',
  '4. Output the chosen kind + a 1-sentence justification in your response.',
  '',
  'Hard rules:',
  '- DO NOT modify `index.html` or write any level files yet — schema only.',
  '- DO NOT invent a new kind outside the canonical five.',
  '- Call `done` when finished.',
].join('\n');

export const ADD_LEVEL_BRIEF = [
  'Add a new level to this game.',
  '',
  'Steps:',
  '1. Read `assets/levels/_schema.json` to learn the per-design level shape.',
  '   If it does not exist, write it first by reading `index.html` to choose',
  '   one of: tilemap-2d, scene-3d, node-graph, wave-script, freeform-json.',
  '2. Read the most recent existing level under `assets/levels/<slug>/level.json`',
  '   for stylistic conventions (entity types, spawn-role names, naming).',
  '3. Write a new level at `assets/levels/<new-slug>/level.json` matching the',
  '   schema. Slug = stable kebab-case (`level-1`, `tutorial`, `wave-2`).',
  '4. Append a corresponding entry to `assets/world/world.json` `levels[]`',
  '   with sequencePosition = max(existing) + 1, plus a transition from the',
  '   previous level. Validate against WorldDoc.',
  '',
  'Hard rules:',
  '- DO NOT modify `index.html` or game runtime logic.',
  '- DO NOT invent fields outside the declared schema.',
  '- After writing, call `verify_artifact` and `render_preview` to confirm',
  '  the game still loads. If a render shows the scene gone, revert.',
  '- Call `done` when finished.',
].join('\n');

export const EXTRACT_LEVELS_FROM_GAME_BRIEF = [
  'This design has an existing game in `index.html` but no level files.',
  'Extract the implicit level/area boundaries into discrete level files.',
  '',
  'Steps:',
  '1. Read `assets/levels/_schema.json` if present, else write it first via',
  '   the same process as the "Define level schema" brief.',
  '2. Read `index.html` and identify discrete level/area concepts. Examples:',
  '   - waves of enemies → one level per wave (kind=wave-script)',
  '   - rooms / corridors / floors → one level per room (kind=scene-3d)',
  '   - dialogue trees / quest branches → one level per branch (kind=node-graph)',
  '3. For each, write `assets/levels/<slug>/level.json` matching the schema.',
  '   Extraction must be lossless — the data already lives in code; copy it',
  '   into the level file, do not paraphrase.',
  '4. Write `assets/world/world.json` linking the levels with transitions',
  '   that match the in-game progression order.',
  '',
  'Hard rules:',
  '- DO NOT change `index.html` behavior. Extraction is read-only against the',
  '  game logic. If a concept does not fit the schema, expand `_schema.json`',
  '  first via a single targeted edit.',
  '- After every two extractions, call `verify_artifact` and `render_preview`',
  '  to confirm the game still renders. Revert any edit that breaks it.',
  '- Call `done` when finished.',
].join('\n');

export const GENERATE_WORLD_GRAPH_BRIEF = [
  'Generate the world graph for this game.',
  '',
  'Steps:',
  '1. List every `assets/levels/<slug>/level.json` file in the design.',
  '2. Read each level file briefly (headline metadata only — kind,',
  '   biome, sequencePosition).',
  '3. Compose `assets/world/world.json` matching the WorldDoc schema:',
  '   `{ schemaVersion: 1, kind: "world-graph", startLevelSlug: <slug>,',
  '     levels: [...], transitions: [...] }`. Pick startLevelSlug = the',
  '   level with the lowest sequencePosition (or a level whose slug',
  '   includes "tutorial" / "intro" / "1").',
  '4. Add `transitions` based on sequencePosition: each level → the',
  '   next sequencePosition with triggerType="exit". For death-loops',
  '   (e.g. wave-defense), add a triggerType="death" self-loop.',
  '',
  'Hard rules:',
  '- DO NOT modify `index.html` or any level files.',
  '- DO NOT invent levels that are not already in the registry.',
  '- Validate against WorldDoc before writing.',
  '- Call `done` when finished.',
].join('\n');

/** Phase 8.2 — ordered phase list the unified "Decompose game" button
 *  walks through. Sprites first (other phases reference sprites for
 *  tilesetRef / spriteRef cross-cutting), then animations, then levels
 *  (which need sprite/animation registry), then world (which needs
 *  levels). Each phase calls into the same agent.sendPrompt pipeline,
 *  serialised so we don't compete for the same context window. */
export interface DecomposePhaseDef {
  id: 'sprites' | 'animations' | 'levels' | 'world';
  label: string;
  brief: string;
}

export const DECOMPOSE_PHASES: readonly DecomposePhaseDef[] = [
  { id: 'sprites', label: 'Extract sprites', brief: SPRITE_EXTRACTION_BRIEF },
  { id: 'animations', label: 'Extract animations', brief: ANIMATION_EXTRACTION_BRIEF },
  { id: 'levels', label: 'Extract levels', brief: EXTRACT_LEVELS_FROM_GAME_BRIEF },
  { id: 'world', label: 'Generate world graph', brief: GENERATE_WORLD_GRAPH_BRIEF },
];
