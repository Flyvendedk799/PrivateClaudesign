import { z } from 'zod';

export const SkillFrontmatterV1 = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().min(1),
  description: z.string().min(1).max(1536),
  trigger: z
    .object({
      providers: z.array(z.string()).default(['*']),
      scope: z.enum(['system', 'prefix']).default('system'),
    })
    .default({}),
  disable_model_invocation: z.boolean().default(false),
  user_invocable: z.boolean().default(true),
  allowed_tools: z.array(z.string()).optional(),
});

export type SkillFrontmatterV1 = z.infer<typeof SkillFrontmatterV1>;

export interface LoadedSkillRule {
  /** Path the model references when calling `view_skill_rule`. Always
   *  POSIX-relative to the skill folder, e.g. `rules/timing.md`. */
  path: string;
  /** Full markdown body of the rule file. */
  content: string;
}

export interface LoadedSkill {
  /** File slug — filename minus extension (e.g. "frontend-design-anti-slop")
   *  for flat skills, or the folder name for folder-format skills. */
  id: string;
  source: 'builtin' | 'user' | 'project';
  frontmatter: SkillFrontmatterV1;
  /** Markdown body after the closing --- delimiter. */
  body: string;
  /** motion-graphics-plan §0.3 — rule subpages discovered for folder-format
   *  skills (anything in `<skill-dir>/rules/*.md`). Empty array for flat
   *  `.md` skills. The agent can fetch any of these by path via
   *  `view_skill_rule`. */
  rules?: LoadedSkillRule[];
}
