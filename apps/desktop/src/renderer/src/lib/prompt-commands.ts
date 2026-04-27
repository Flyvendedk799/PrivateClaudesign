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
 * The bar is "obviously beyond a single 80KB JSX file" — Three.js scenes,
 * WebGL/shader work, audio visualizers, physics/game loops. These reliably
 * blow past JSX-pattern size limits and benefit from sidecar `.js` files
 * + CDN libraries that vanilla unlocks. When unsure, return undefined and
 * let the JSX default win — it's the proven path.
 *
 * Manual `/jsx` / `/vanilla` always wins over auto-detection (handled in
 * the caller).
 */
export function detectPatternFromPrompt(prompt: string): ArtifactPattern | undefined {
  const lower = prompt.toLowerCase();
  // Direct library mentions — if the user names Three.js / WebGL / etc.,
  // they want a real multi-file build, not React-in-a-string.
  const heavySignals = [
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
