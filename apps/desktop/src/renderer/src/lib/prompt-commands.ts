/**
 * Tiny `/command` parser for the chat prompt input.
 *
 * Supported leading commands (must be the very first token of the prompt,
 * separated from the rest of the prompt by whitespace OR be the entire
 * prompt — everything else passes through untouched):
 *
 *   /jsx <prompt>      — force the JSX-via-Babel-standalone artifact pattern
 *                        (single index.html, React inline, EDITMODE/TWEAK).
 *   /vanilla <prompt>  — force multi-source-file (index.html + styles.css
 *                        + <name>.js + CDN libs allowed). Matches Claude
 *                        Design's actual export structure.
 *   /help              — produce a help payload instead of generating;
 *                        caller renders it as a system chat message.
 *
 * Unknown `/foo` commands pass through untouched so they don't accidentally
 * eat user prose. The bar is "the user clearly meant a command" — which
 * means the slash + a known keyword + (whitespace OR EOL).
 *
 * Why renderer-side: the parsing is purely UX (which guidance section the
 * agent sees, which export inliner the iframe runs). It doesn't need to
 * round-trip through the main process. Keeps the IPC payload simple.
 */

export type ArtifactPattern = 'jsx' | 'vanilla';

export type PatternSource = 'manual' | 'auto';

export interface ParsedPromptCommand {
  /** The user-visible prompt with the leading command stripped. */
  prompt: string;
  /** Pattern override the user requested, or undefined if no command. */
  pattern?: ArtifactPattern | undefined;
  /** Where the pattern came from: explicit slash-command (`manual`) or the
   *  auto-detection heuristic (`auto`). Useful for UI hints — we surface
   *  "auto-selected vanilla" so the user knows why their JSX-default flipped. */
  patternSource?: PatternSource | undefined;
  /** When true, the caller should NOT submit a generation — instead show
   *  the help text and let the user retry with a real prompt. */
  showHelp?: boolean;
}

const KNOWN_PATTERNS: Record<string, ArtifactPattern> = {
  jsx: 'jsx',
  vanilla: 'vanilla',
};

/**
 * Heuristic: should this prompt default to the multi-file VANILLA pattern
 * even though the user didn't type `/vanilla`?
 *
 * The bar is "obviously beyond a single 80KB JSX file". Originally
 * scoped to Three.js / WebGL / shader work — anything that needs
 * sidecar JS modules + real `<script src>` not Babel-standalone-friendly
 * JSX. Broadened to also catch:
 *   - data-density apps (dashboard / admin / data table) that benefit
 *     from a separate fixtures file + render module
 *   - state-machine apps (multi-step form / wizard / quiz / chat /
 *     drawing tool / code editor) that get unwieldy past ~500 LOC
 *   - external-lib apps (chart.js / d3 / monaco / tldraw / excalidraw
 *     / prosemirror / codemirror) that need real `<script src>` not
 *     Babel-standalone-friendly JSX
 *   - multi-page mocks (marketing site / docs site / sitemap)
 *
 * Conservative bias: ambiguous prompts (a passing mention of "data
 * table" inside a regular landing page) leave detection at undefined
 * so the JSX default still wins. Manual `/jsx` / `/vanilla` always
 * wins over auto-detection (handled in the caller).
 */
/**
 * Heuristic: should this prompt route through GAME-mode (`composeGame`,
 * `choose_engine` tool, engine-specific prompt guides) instead of the
 * default DESIGN-mode JSX path?
 *
 * The trigger is "the prompt names a game genre or engine". Without
 * this, prompts like "create a first-person shooter wave defense"
 * fall into JSX-design-mode without engine guidance — the model spends
 * its output budget reasoning about which 3D engine to use and how to
 * structure the scene, often hitting `max_tokens` before any tool call
 * fires (the 2026-05-06 FPS run hit exactly this: 1 turn, 0 tools, 0
 * deltas, 65 K output tokens, 15.3 min wall-clock).
 *
 * Conservative bias: only obvious game prompts flip. "A landing page
 * for a video game studio" stays design-mode. The NewDesignDialog's
 * explicit Game-mode button always wins.
 */
export function detectGameModeFromPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const gameSignals = [
    // Genre names (canonical)
    /\b(?:first[-\s]?person\s+shooter|fps)\b/,
    /\b(?:third[-\s]?person\s+shooter|tps)\b/,
    /\b(?:twin[-\s]?stick(?:\s+shooter)?)\b/,
    /\b(?:tower\s+defense|td)\b/,
    /\b(?:wave\s+defense|wave\s+survival)\b/,
    /\b(?:platformer|metroidvania)\b/,
    /\b(?:endless\s+runner)\b/,
    /\b(?:rogue[-\s]?lik[ey]|rogue[-\s]?lite)\b/,
    /\b(?:battle\s+royale)\b/,
    /\b(?:shoot\s*['']em[-\s]?up|shmup|bullet\s+hell)\b/,
    /\b(?:tactical|turn[-\s]?based)\s+(?:rpg|game|combat)\b/,
    /\b(?:dungeon\s+crawler)\b/,
    /\b(?:racing\s+game|kart\s+game)\b/,
    /\b(?:fighting\s+game)\b/,
    /\b(?:rhythm\s+game)\b/,
    /\b(?:puzzle\s+game)\b/,
    /\b(?:arcade\s+game)\b/,
    /\b(?:retro\s+game)\b/,
    /\b(?:idle\s+game|clicker\s+game|incremental\s+game)\b/,
    /\b(?:tile[-\s]?based\s+game)\b/,
    /\b(?:open[-\s]?world\s+game)\b/,
    /\b(?:rpg|mmo|moba|rts|jrpg)\b/,
    // Generic "build a <genre> game" patterns
    /\b(?:build|make|create)\s+(?:me\s+)?(?:an?\s+)?(?:simple\s+)?(?:2d|3d)\s+game\b/,
    /\b(?:simple|small)\s+(?:2d|3d)?\s*game\s+(?:with|where|that)\b/,
    // Engine-specific phrasing — explicit engine choice = obvious game
    /\b(?:phaser|three\.?js)\s+(?:game|project|scene\s+with\s+gameplay)\b/,
    /\b(?:godot)\s+(?:project|game|2d|3d)\b/,
    /\b(?:pygame)\s+(?:game|project)\b/,
  ];
  for (const re of gameSignals) {
    if (re.test(lower)) return true;
  }
  return false;
}

export function detectPatternFromPrompt(prompt: string): ArtifactPattern | undefined {
  const lower = prompt.toLowerCase();
  // Direct library mentions — if the user names Three.js / WebGL / etc.,
  // they want a real multi-file build, not React-in-a-string.
  const heavySignals = [
    // Original: 3D / WebGL / animation
    /\bthree\.?js\b/,
    /\bwebgl\b/,
    /\bshader(s)?\b/,
    /\bglsl\b/,
    /\bparticle (system|engine|simulation)\b/,
    /\bfluid (sim(ulation)?|dynamics)\b/,
    /\bphysics (engine|sim)\b/,
    /\baudio (visualizer|analyzer|reactive)\b/,
    /\bweb audio api\b/,
    /\btone\.?js\b/,
    /\bcanvas (animation|app|game)\b/,
    /\bgame loop\b/,
    /\b3d (scene|model|engine|world|game)\b/,
    /\b<canvas[^>]*>/,
    // Data-density app shapes — these need a fixtures sidecar plus a
    // render module, single-file JSX gets unwieldy fast.
    /\b(?:admin|control)\s+(?:panel|dashboard)\b/,
    /\bkanban\s+board\b/,
    /\b(?:trello|jira|linear|notion)[\s-]like\b/,
    /\b(?:project|task|issue|ticket)\s+management\b/,
    /\b(?:analytics|metrics|monitoring|observability)\s+(?:dashboard|platform|tool|site|app)\b/,
    // State-machine app shapes — complex client-side logic + persisted
    // state across multiple views.
    /\b(?:multi[-\s]?step|multistep)\s+(?:form|wizard|flow)\b/,
    /\b(?:onboarding|signup)\s+(?:wizard|flow|funnel)\b/,
    /\b(?:chat|messaging|im)\s+(?:app|application|client|interface)\b/,
    /\b(?:drawing|whiteboard|illustration|paint|sketch)\s+(?:tool|app|application)\b/,
    /\b(?:code|markdown|rich[-\s]?text|wysiwyg)\s+editor\b/,
    /\bplayground\s+(?:for|app|tool)\b/,
    /\b(?:quiz|trivia|survey)\s+(?:app|application|builder)\b/,
    // External-libs that the JSX/Babel-standalone path can't easily
    // bundle — almost always indicates the user wants real sidecars.
    /\b(?:chart\.?js|d3\.?js|d3)\b/,
    /\bmonaco(?:[-\s]?editor)?\b/,
    /\btldraw\b/,
    /\bexcalidraw\b/,
    /\bprose[-\s]?mirror\b/,
    /\bcode[-\s]?mirror\b/,
    /\b(?:gsap|lottie)\b/,
    // Multi-page / multi-doc mocks — sitemap of pages, marketing +
    // blog, or "documentation site" with sidebar nav benefit from
    // sidecar JS to drive routing without re-rendering the whole tree.
    /\bdocumentation\s+(?:site|portal)\b/,
    /\bdocs?\s+site\b/,
    /\bmulti[-\s]?page\s+(?:site|app|application)\b/,
    /\bsitemap\b/,
    /\b(?:landing\s+page\s+with|site\s+with)\s+(?:a\s+)?blog\b/,
  ];
  for (const re of heavySignals) {
    if (re.test(lower)) return 'vanilla';
  }
  return undefined;
}

export function parsePromptCommand(rawPrompt: string): ParsedPromptCommand {
  const trimmed = rawPrompt.trimStart();
  // Auto-detect path: no slash command, but the prompt content itself
  // implies multi-file scope. We still return the original prompt unchanged.
  const autoDetect = (prompt: string): ParsedPromptCommand => {
    const detected = detectPatternFromPrompt(prompt);
    if (detected) return { prompt, pattern: detected, patternSource: 'auto' };
    return { prompt };
  };
  if (!trimmed.startsWith('/')) return autoDetect(rawPrompt);
  // Match `/word` followed by whitespace OR end-of-string. Anything else
  // (e.g. `/foo,bar`, `/12`) passes through as ordinary prose.
  const match = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(\s+|$)/);
  if (!match) return autoDetect(rawPrompt);
  const command = (match[1] ?? '').toLowerCase();
  const remainder = trimmed.slice(match[0].length);
  if (command === 'help') {
    return { prompt: '', showHelp: true };
  }
  const pattern = KNOWN_PATTERNS[command];
  if (pattern) {
    return { prompt: remainder.trimEnd(), pattern, patternSource: 'manual' };
  }
  // Unknown command — pass through untouched (still respect auto-detect).
  return autoDetect(rawPrompt);
}

/** Help text rendered as an assistant message when the user types `/help`. */
export const PROMPT_COMMAND_HELP = [
  '**Slash commands** — type at the very start of your prompt to override defaults:',
  '',
  '`/jsx <your prompt>` — force the React/JSX pattern (single `index.html` with inline React + Babel-standalone). Default for most designs.',
  '',
  '`/vanilla <your prompt>` — force multi-source-file pattern (separate `index.html` + `styles.css` + `<name>.js` files). Use this for designs that need 100+ KB of code (Three.js engines, complex state machines, large data fixtures). Allows external CDN libraries (`https://unpkg.com/...`).',
  '',
  '`/help` — show this help.',
  '',
  'Without a slash command, the system uses the JSX pattern (current default).',
].join('\n');
