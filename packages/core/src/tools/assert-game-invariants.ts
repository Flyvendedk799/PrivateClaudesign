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

const AssertGameInvariantsParams = Type.Object({});

export type GameInvariant = 'restart' | 'fail-state' | 'score-or-state' | 'feedback';

export interface InvariantIssue {
  invariant: GameInvariant;
  message: string;
  severity: 'warn' | 'error';
}

export interface AssertGameInvariantsDetails {
  ok: boolean;
  checked: GameInvariant[];
  issues: InvariantIssue[];
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

export function assertGameInvariants(deps: AssertGameInvariantsDeps): AssertGameInvariantsDetails {
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

  return {
    ok: issues.length === 0,
    checked,
    issues,
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
      'collision handler (sound / particle / shake). Pattern-based static ' +
      'analysis over the whole project tree — fast and free. Call BEFORE ' +
      '`done` alongside `validate_game_scene`. Warnings are non-blocking but ' +
      'should be treated as a strong nudge to fix before shipping.',
    parameters: AssertGameInvariantsParams,
    async execute(): Promise<AgentToolResult<AssertGameInvariantsDetails>> {
      const result = assertGameInvariants(deps);
      const summary =
        result.issues.length === 0
          ? 'All four game invariants present (restart, fail-state, score-or-state, feedback). No follow-up needed.'
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
