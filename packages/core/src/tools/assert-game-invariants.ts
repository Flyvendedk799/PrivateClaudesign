/**
 * gameplan §E2 — `assert_game_invariants` tool.
 *
 * Cross-engine static-analysis check for the design-level invariants every
 * game must hit: a restart binding, a fail state, score / state change,
 * and *some* feedback within the collision/hit handler. These cut across
 * engine boundaries, so we run pattern checks over the project's source
 * tree (.js / .ts / .py / .gd) instead of dispatching to per-engine
 * validators.
 *
 * v1 is intentionally pattern-based — fast, cheap, runs over the whole
 * file bundle. A real "play test" that ticks the game forward N frames
 * needs an iframe runtime to drive (Phase E follow-up); this tool buys
 * 80% of the value without that infrastructure.
 *
 * The agent is told to call this before `done` alongside
 * `validate_game_scene`. validate_game_scene catches engine-specific
 * structural foot-guns; assert_game_invariants catches game-design
 * gaps (e.g. shipped a Pong that has no way to lose).
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { TextEditorFsCallbacks } from './text-editor.js';

/** Genre values match the spec-block menu in game-workflow.v1.txt §2. */
export const GAME_GENRES = [
  'brawler',
  'shooter',
  'platformer',
  'puzzle',
  'racer',
  'runner',
  'tower-defense',
  'survival',
  'rhythm',
  'other',
] as const;
export type GameGenre = (typeof GAME_GENRES)[number];

const AssertGameInvariantsParams = Type.Object({
  /** Genre token from the Mechanic spec block (Sequence 1). When set,
   *  the cross-engine pass adds genre-specific checks (e.g. brawler →
   *  combo + hitstop + visible limbs + aim/hitbox parity). Optional so
   *  the tool stays backward-compatible with the design-mode pre-`done`
   *  invariant pass. */
  genre: Type.Optional(
    Type.Union([
      Type.Literal('brawler'),
      Type.Literal('shooter'),
      Type.Literal('platformer'),
      Type.Literal('puzzle'),
      Type.Literal('racer'),
      Type.Literal('runner'),
      Type.Literal('tower-defense'),
      Type.Literal('survival'),
      Type.Literal('rhythm'),
      Type.Literal('other'),
    ]),
  ),
});

export type GameInvariant =
  | 'restart'
  | 'fail-state'
  | 'score-or-state'
  | 'feedback'
  | 'brawler-combo'
  | 'brawler-hitstop'
  | 'brawler-per-attack-limb'
  | 'brawler-aim-hitbox-parity';

export interface InvariantIssue {
  invariant: GameInvariant;
  message: string;
  severity: 'warn' | 'error';
}

export interface AssertGameInvariantsDetails {
  ok: boolean;
  checked: GameInvariant[];
  issues: InvariantIssue[];
  genre: GameGenre | null;
}

const SOURCE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.py', '.gd', '.html'] as const;

export interface AssertGameInvariantsDeps {
  /** Returns every authored project file the agent has written. The host
   *  wires this from the in-memory virtual FS — same source the
   *  text_editor tool mutates. */
  listFiles: () => Array<{ path: string; content: string }>;
}

/** Concatenated source of every text file that's a candidate for source-
 *  level pattern matching. Binary/asset paths are filtered out so we
 *  don't scan PNGs / WAVs by accident. */
function gatherSource(deps: AssertGameInvariantsDeps): string {
  const files = deps.listFiles();
  const sources: string[] = [];
  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (!SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    if (f.content.startsWith('data:')) continue;
    sources.push(f.content);
  }
  return sources.join('\n\n');
}

/** Restart binding — any of: an explicit reset()/restart() function,
 *  a key handler for R / Space that mutates state back, or `location.reload`. */
const RESTART_PATTERNS: readonly RegExp[] = [
  /\b(restart|reset|new[_]?game|reset[_]?game)\s*\(/i,
  /K_r\b|key\s*===?\s*['"]r['"]|key\s*===?\s*['"]R['"]|\.code\s*===?\s*['"]KeyR['"]/,
  /pygame\.K_r\b|pygame\.K_SPACE\b/,
  /location\.reload\b/,
  /Input\.is_action_just_pressed\(["']ui_select["']\)/,
];

const FAIL_PATTERNS: readonly RegExp[] = [
  // Match `gameOver`, `GameOver`, `game_over`, `game over` even when they
  // appear in camelCase identifiers (`onGameOver`, `isGameOver`). The
  // leading boundary is dropped because game-design code very commonly
  // wraps these names without a word break.
  /(?:game[_\s]?over|gameover|lose|lost|defeat|fail(?:ed)?|died|deaths?)/i,
  /\bif\s*\(\s*hp\s*<=?\s*0\s*\)/i,
  /\bif\s*\(\s*health\s*<=?\s*0\s*\)/i,
  /\bif\s*\(\s*lives\s*<=?\s*0\s*\)/i,
];

const SCORE_PATTERNS: readonly RegExp[] = [
  /\b(score|points?|coins?|stars?|kills?|level|wave|round)\s*[+\-*/]?=\s*[+\-]?\s*\d/i,
  /\b(score|points?|coins?)\s*\+\+/i,
  /\bsetScore\s*\(/i,
  /\bemit_signal\(["']score_changed/i,
];

const FEEDBACK_PATTERNS: readonly RegExp[] = [
  // Audio playback (any engine)
  /\bplay\s*\(\s*\)/i,
  /\bnew\s+Audio\s*\(/,
  /\.sound\.add\b|\.sound\.play\b/i,
  /pygame\.mixer\.Sound\b/,
  /AudioStreamPlayer\b/,
  // Visual / particle / shake
  /\b(flash|shake|particle|emit_particle|spark|ripple)/i,
  /\bcontext\.fillRect\b|\bdrawRect\b/i,
  // Tween / camera shake
  /\btween\.|camera\.shake\b|setShake\b/i,
];

function anyMatch(source: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(source));
}

// Sequence-6 (genre-specific invariants) — brawler patterns. Brawler =
// melee-combat game where hand alternation, hit telegraphing, and aim/
// hitbox parity decide whether the game feels skilled or random. These
// checks are pattern-based, not AST-level, so a brawler that genuinely
// implements the mechanic but uses unusual identifiers (e.g. Danish
// `venstreHaand`) will trip the warning. Severity stays `warn` so the
// agent can ignore-and-justify, same as the design-level invariants.

// Patterns deliberately do NOT use leading `\b` so identifiers like
// `applyHitstop` and `leftArm` (camelCase) match. Each pattern is
// distinctive enough that false positives are unlikely.

const BRAWLER_COMBO_PATTERNS: readonly RegExp[] = [
  /combo[A-Z_a-z]*/i,
  /alternation/i,
  /multiplier/i,
  /lastAttack/i,
  /lastHand/i,
];

const BRAWLER_HITSTOP_PATTERNS: readonly RegExp[] = [
  /hit[_-]?stop/i,
  /hit[_-]?stun/i,
  /hit[_-]?pause/i,
  /hit[_-]?freeze/i,
  /stagger/i,
  /freezeFrames?/i,
  /timeScale\s*=/,
];

const BRAWLER_LIMB_PATTERNS: readonly RegExp[] = [
  /(left|l)[_-]?(Arm|Fist|Hand)/i,
  /(right|r)[_-]?(Arm|Fist|Hand)/i,
  /arms?\.(left|right|l|r)/i,
  /\bjab\b/i,
  /\bcross\b/i,
  /\bhook\b/i,
];

/** A brawler must visibly distinguish at least two limbs/attack
 *  identifiers — counting unique pattern hits, not just one. */
function brawlerLimbCount(source: string): number {
  let hits = 0;
  for (const re of BRAWLER_LIMB_PATTERNS) {
    if (re.test(source)) hits += 1;
  }
  return hits;
}

const ROTATION_NEGATED_ANGLE: readonly RegExp[] = [
  /rotation\.y\s*=\s*-\s*playerAngle/i,
  /rotation\.y\s*=\s*-\s*aimAngle/i,
  /rotation\.y\s*=\s*-\s*ea\b/i,
  /rotation\.y\s*=\s*-\s*enemyAngle/i,
];

/** Tries to extract the agent's `Genre:` choice from the system / user
 *  / assistant transcript when the tool is called without an explicit
 *  argument. Exported for reuse by the renderer (Sequence 7). */
export function parseGenreFromTranscript(text: string): GameGenre | null {
  const match = /Genre:\s*([a-z-]+)/i.exec(text);
  if (match === null) return null;
  const token = (match[1] ?? '').toLowerCase() as GameGenre;
  return GAME_GENRES.includes(token) ? token : null;
}

export function assertGameInvariants(
  deps: AssertGameInvariantsDeps,
  opts: { genre?: GameGenre } = {},
): AssertGameInvariantsDetails {
  const source = gatherSource(deps);
  const issues: InvariantIssue[] = [];
  const checked: GameInvariant[] = ['restart', 'fail-state', 'score-or-state', 'feedback'];

  if (!anyMatch(source, RESTART_PATTERNS)) {
    issues.push({
      invariant: 'restart',
      severity: 'warn',
      message:
        'No restart binding detected. Wire R or Space (or ui_select for Godot) to reset state without a page reload — losing without restart is a hard fail per the gameplan §3.',
    });
  }
  if (!anyMatch(source, FAIL_PATTERNS)) {
    issues.push({
      invariant: 'fail-state',
      severity: 'warn',
      message:
        'No fail state detected. Add a way for the player to lose — hp <= 0, time runs out, all lives gone — otherwise the brief is a toy, not a game.',
    });
  }
  if (!anyMatch(source, SCORE_PATTERNS)) {
    issues.push({
      invariant: 'score-or-state',
      severity: 'warn',
      message:
        'No score / state change detected. The player needs a measurable signal of progress — score, level, wave, kills — that mutates as they play.',
    });
  }
  if (!anyMatch(source, FEEDBACK_PATTERNS)) {
    issues.push({
      invariant: 'feedback',
      severity: 'warn',
      message:
        'No feedback cue detected. Hits / pickups / impacts need a visible AND audible response within 100 ms — a sound effect, particle burst, or screen shake. Silence reads as broken.',
    });
  }

  const genre = opts.genre ?? null;
  if (genre === 'brawler') {
    checked.push(
      'brawler-combo',
      'brawler-hitstop',
      'brawler-per-attack-limb',
      'brawler-aim-hitbox-parity',
    );
    if (!anyMatch(source, BRAWLER_COMBO_PATTERNS)) {
      issues.push({
        invariant: 'brawler-combo',
        severity: 'warn',
        message:
          'Brawler with no combo / alternation system detected. Two-handed brawlers reward sequence (Jab→Cross→Jab → multiplier) — without a `combo`, `lastAttack`, or `multiplier` mutation the skill ceiling collapses. The 2026-05-03 c44763af trace needed a final user prompt to spell this out; bake it in up-front.',
      });
    }
    if (!anyMatch(source, BRAWLER_HITSTOP_PATTERNS)) {
      issues.push({
        invariant: 'brawler-hitstop',
        severity: 'warn',
        message:
          'Brawler with no hitstop / hitstun detected. Heavy hits should freeze the attacker for 30-80 ms (`hitstop`, `hitstun`, `staggerFrames`, or `timeScale = 0.05` for one tick) so the impact reads as weighty rather than ghostly.',
      });
    }
    if (brawlerLimbCount(source) < 2) {
      issues.push({
        invariant: 'brawler-per-attack-limb',
        severity: 'warn',
        message:
          'Brawler without two visible attack limbs detected. The lead/rear hand distinction (Jab vs Cross) requires distinct meshes / sprites the player can SEE — at least one each of `leftArm`/`rightArm` (or `jab`/`cross`/`hook`). Without this the user cannot read which hand is firing and the combo system becomes invisible.',
      });
    }
    if (anyMatch(source, ROTATION_NEGATED_ANGLE)) {
      issues.push({
        invariant: 'brawler-aim-hitbox-parity',
        severity: 'warn',
        message:
          'Suspect aim/hitbox sign error — `rotation.y = -playerAngle` (or -ea / -aimAngle / -enemyAngle) detected. In Three.js with `atan2(dx, dz)` the rotation is the angle directly, NOT its negative. The 2026-05-03 c44763af trace shipped this exact bug through three snapshots; switch to `rotation.y = playerAngle` and re-run `playtest_game` to confirm the player faces the cursor.',
      });
    }
  }

  return {
    ok: issues.length === 0,
    checked,
    issues,
    genre,
  };
}

export function makeAssertGameInvariantsTool(
  deps: AssertGameInvariantsDeps,
  _fs?: TextEditorFsCallbacks,
): AgentTool<typeof AssertGameInvariantsParams, AssertGameInvariantsDetails> {
  return {
    name: 'assert_game_invariants',
    label: 'Assert game invariants',
    description:
      'Cross-engine sanity check for the four design-level invariants every ' +
      'game must hit: a restart binding (R / Space), a fail state (lose / ' +
      'game over), a score or state-change signal, and feedback within the ' +
      'collision handler (sound / particle / shake). Pass `genre: "brawler"` ' +
      '(or another genre token from your Mechanic spec block) to also run ' +
      'genre-specific checks — e.g. brawler adds combo + hitstop + visible ' +
      'limbs + aim/hitbox parity (catches the 2026-05-03 c44763af sign-error ' +
      'class). Pattern-based static analysis over the whole project tree — ' +
      'fast and free. Call BEFORE `done` alongside `validate_game_scene`. ' +
      'Warnings are non-blocking but should be treated as a strong nudge to ' +
      'fix before shipping.',
    parameters: AssertGameInvariantsParams,
    async execute(_id, params): Promise<AgentToolResult<AssertGameInvariantsDetails>> {
      const genre = params.genre as GameGenre | undefined;
      const result = assertGameInvariants(deps, genre !== undefined ? { genre } : {});
      const baseInvariants = ['restart', 'fail-state', 'score-or-state', 'feedback'].join(', ');
      const okHeadline =
        genre !== undefined
          ? `All ${result.checked.length} invariants present for genre=${genre} (${baseInvariants}${result.checked.length > 4 ? ` + ${result.checked.slice(4).join(', ')}` : ''}). No follow-up needed.`
          : `All four game invariants present (${baseInvariants}). No follow-up needed.`;
      const summary =
        result.issues.length === 0
          ? okHeadline
          : `${result.issues.length} game invariant(s) appear missing:\n${result.issues
              .map((i) => `  • [${i.invariant}] ${i.message}`)
              .join(
                '\n',
              )}\n\nThese are warnings, not blockers — review and add the missing pieces before \`done\`.`;
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  };
}
