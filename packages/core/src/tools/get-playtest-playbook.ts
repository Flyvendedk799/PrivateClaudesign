/**
 * may9 Phase 9 — `get_playtest_playbook` agent tool.
 *
 * Returns a canonical input → state assertion list for a given genre.
 * The agent calls this BEFORE `playtest_game` so it ships a step list
 * that has already proved itself against the empirical regressions
 * documented in docs/may9.md (brawler sign error, FPS pointer-lock
 * silent-failure, platformer no-gravity, etc.).
 *
 * Companion to `playtest_game` (which does the actual host-side
 * dispatch). The agent's pattern:
 *
 *   1. declare_game_spec  → captures genre
 *   2. choose_engine
 *   3. ... build the game ...
 *   4. validate_game_scene
 *   5. assert_game_invariants
 *   6. get_playtest_playbook(genre)   ← this tool
 *   7. playtest_game(<steps from playbook>)
 *   8. done
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import {
  type PlaytestPlaybook,
  getPlaytestPlaybook,
  listSupportedGenres,
} from '../playtest-playbooks.js';

const GetPlaytestPlaybookParams = Type.Object({
  genre: Type.String({
    description:
      'The GameSpec.genre value. Must match the spec recorded via declare_game_spec. ' +
      'When the genre has no built-in playbook, the tool returns a list of supported genres ' +
      'and the agent improvises a step list of its own.',
  }),
});

export interface GetPlaytestPlaybookDetails {
  genre: string;
  found: boolean;
  playbook: PlaytestPlaybook | null;
  supportedGenres: string[];
}

export function makeGetPlaytestPlaybookTool(): AgentTool<
  typeof GetPlaytestPlaybookParams,
  GetPlaytestPlaybookDetails
> {
  return {
    name: 'get_playtest_playbook',
    label: 'Get playtest playbook',
    description: `Return a canonical input -> state assertion list for the given genre. Call after declare_game_spec but before playtest_game to get a proven step list. Built-in genres: ${listSupportedGenres().join(', ')}. Returns null when the genre has no bundled playbook; the agent should then improvise.`,
    parameters: GetPlaytestPlaybookParams,
    async execute(_id, params): Promise<AgentToolResult<GetPlaytestPlaybookDetails>> {
      const playbook = getPlaytestPlaybook(
        params.genre as Parameters<typeof getPlaytestPlaybook>[0],
      );
      const supported = listSupportedGenres();
      if (playbook === null) {
        return {
          content: [
            {
              type: 'text',
              text: `No bundled playbook for genre '${params.genre}'. Built-in genres: ${supported.join(', ')}. Improvise a step list using the spec's primaryInputs and the engine guide's input section.`,
            },
          ],
          details: {
            genre: params.genre,
            found: false,
            playbook: null,
            supportedGenres: supported,
          },
        };
      }
      const stepCount = playbook.steps.length;
      const watchCount = playbook.watchFor.length;
      const json = JSON.stringify(playbook, null, 2);
      return {
        content: [
          {
            type: 'text',
            text: `Playbook for ${params.genre}: ${playbook.intent} ${stepCount} steps, ${watchCount} watch-fors. Translate steps into your playtest_game call (adapt key codes to your binding scheme), then evaluate each step's \`assert\` against the snapshot returned by playtest_game.\n\n${json}`,
          },
        ],
        details: {
          genre: params.genre,
          found: true,
          playbook,
          supportedGenres: supported,
        },
      };
    },
  };
}
