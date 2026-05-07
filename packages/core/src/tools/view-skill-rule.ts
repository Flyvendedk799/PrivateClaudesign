/**
 * motion-graphics-plan §0.3 — `view_skill_rule` agent tool.
 *
 * Folder-format skills (e.g. the bundled Remotion skill) expose
 * `rules/*.md` subpages alongside the main SKILL.md body. The agent
 * uses this tool to fetch one rule on demand, mirroring the
 * `view_design_skill` pattern. Always registered globally so the
 * tool catalog stays stable across runs; calls against flat skills
 * (no rules) return a clear "no rules" message instead of failing.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { LoadedSkill } from '@open-codesign/shared';
import { Type } from '@sinclair/typebox';

const Params = Type.Object({
  /** The skill id (folder/file slug, e.g. `remotion-best-practices`).
   *  Listed in the system prompt's "Available Skills" header. */
  skillId: Type.String(),
  /** The rule subpage path. Always `rules/<filename>.md`. */
  rulePath: Type.String(),
});

export interface ViewSkillRuleDetails {
  skillId: string;
  rulePath: string;
  /** Rule body length in characters (cheap heuristic for the tool log). */
  byteLen: number;
  /** True when the rule was found and returned; false when the lookup
   *  failed (skill missing, flat-skill, unknown path). */
  ok: boolean;
}

export function makeViewSkillRuleTool(
  skills: ReadonlyArray<LoadedSkill> | undefined,
): AgentTool<typeof Params, ViewSkillRuleDetails> {
  return {
    name: 'view_skill_rule',
    label: 'View skill rule',
    description:
      'Fetch one `rules/<name>.md` subpage from a folder-format skill. ' +
      'Folder skills (e.g. the Remotion skill) split deep guidance across rule files; ' +
      'the SKILL.md body lists which rules exist. Call this only when you need a specific ' +
      'rule body — the SKILL.md body is already in the system prompt. Returns a clear ' +
      '"no rules" message for flat-format skills.',
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<ViewSkillRuleDetails>> {
      const list = skills ?? [];
      const skill = list.find((s) => s.id === params.skillId);
      if (skill === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: `view_skill_rule: skill "${params.skillId}" is not loaded for this run. Available: ${
                list.map((s) => s.id).join(', ') || '(none)'
              }`,
            },
          ],
          details: {
            skillId: params.skillId,
            rulePath: params.rulePath,
            byteLen: 0,
            ok: false,
          },
        };
      }
      const rules = skill.rules ?? [];
      if (rules.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `view_skill_rule: skill "${params.skillId}" is a flat-format skill with no rule subpages. The full body is already in the system prompt under "Available Skills".`,
            },
          ],
          details: {
            skillId: params.skillId,
            rulePath: params.rulePath,
            byteLen: 0,
            ok: false,
          },
        };
      }
      const rule = rules.find((r) => r.path === params.rulePath);
      if (rule === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: `view_skill_rule: no rule "${params.rulePath}" in skill "${params.skillId}". Known rules: ${rules
                .map((r) => r.path)
                .join(', ')}`,
            },
          ],
          details: {
            skillId: params.skillId,
            rulePath: params.rulePath,
            byteLen: 0,
            ok: false,
          },
        };
      }
      return {
        content: [{ type: 'text', text: rule.content }],
        details: {
          skillId: params.skillId,
          rulePath: params.rulePath,
          byteLen: rule.content.length,
          ok: true,
        },
      };
    },
  };
}
