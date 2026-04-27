/**
 * Design-library tools — surface the bundled `design-skills/*.jsx` and
 * `frames/*.jsx` registries to the agent as discoverable tools.
 *
 * Why this exists: the registries ship in the bundle today (12 skills + 5
 * frames) but the agent never adopts them. The static AGENTIC_TOOL_GUIDANCE
 * block listed file paths in prose, but the model didn't go looking — there's
 * no tool, so it doesn't read. Adding `list_design_skills` makes the catalogue
 * discoverable, and the model picks the matching skill before scaffolding.
 *
 * Three tools:
 *   - `list_design_skills` — name + `when_to_use:` hint + size for each skill.
 *   - `view_design_skill({name})` — full source of one skill.
 *   - `view_frame({name})` — full source of one device frame.
 *
 * No fs / state / I/O — pure registry lookups. The skill source is then
 * pasted by the model into a `text_editor.create("index.html", ...)` call.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { DESIGN_SKILLS } from '../design-skills/index.js';
import { FRAME_TEMPLATES } from '../frames/index.js';

const SKILL_MAP = new Map<string, string>(DESIGN_SKILLS.map(([name, src]) => [name, src]));
const FRAME_MAP = new Map<string, string>(FRAME_TEMPLATES.map(([name, src]) => [name, src]));

/** Parse the leading `// when_to_use: ...` block (one or more contiguous
 *  comment lines) out of a JSX skill file. Returns the joined hint or a
 *  fallback if the file doesn't follow the convention. */
function parseWhenToUse(src: string): string {
  const lines = src.split('\n');
  // Find the first `// when_to_use:` line
  let startIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    if (/^\s*\/\/\s*when_to_use\s*:/i.test(lines[i] ?? '')) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return 'No when_to_use hint declared in this skill file.';
  // Capture contiguous comment lines until first non-comment / blank-comment.
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('//')) break;
    const stripped = line.replace(/^\s*\/\/\s?/, '').replace(/^when_to_use\s*:\s*/i, '');
    out.push(stripped);
  }
  return out.join(' ').trim();
}

const ListDesignSkillsParams = Type.Object({});

export interface DesignSkillEntry {
  name: string;
  whenToUse: string;
  sizeBytes: number;
}

export interface ListDesignSkillsDetails {
  skills: DesignSkillEntry[];
}

export function makeListDesignSkillsTool(): AgentTool<
  typeof ListDesignSkillsParams,
  ListDesignSkillsDetails
> {
  return {
    name: 'list_design_skills',
    label: 'List design skills',
    description:
      'Return the catalogue of bundled design-skill starter snippets. Each entry has a name, ' +
      'a `whenToUse` hint, and a byte size. Call this once before scaffolding `index.html` ' +
      'so you can pick a starter that matches the brief (landing-page, dashboard, slide-deck, ' +
      'chart-svg, glassmorphism, editorial-typography, heroes, pricing, footers, chat-ui, ' +
      'data-table, calendar). Then call `view_design_skill({name})` on the best match. ' +
      'Skipping this means rewriting things the bundled snippets already do well.',
    parameters: ListDesignSkillsParams,
    async execute(): Promise<AgentToolResult<ListDesignSkillsDetails>> {
      const skills: DesignSkillEntry[] = [];
      for (const [name, src] of DESIGN_SKILLS) {
        skills.push({
          name,
          whenToUse: parseWhenToUse(src),
          sizeBytes: src.length,
        });
      }
      const text = skills.map((s) => `- ${s.name} (${s.sizeBytes}b): ${s.whenToUse}`).join('\n');
      return {
        content: [{ type: 'text', text: `Design skills available:\n${text}` }],
        details: { skills },
      };
    },
  };
}

const ViewDesignSkillParams = Type.Object({
  name: Type.String(),
});

export interface ViewDesignSkillDetails {
  name: string;
  source: string;
}

export function makeViewDesignSkillTool(): AgentTool<
  typeof ViewDesignSkillParams,
  ViewDesignSkillDetails
> {
  return {
    name: 'view_design_skill',
    label: 'View design skill',
    description:
      'Return the full source of one bundled design-skill snippet. Call after `list_design_skills` ' +
      'to load the matching starter. Adapt the snippet to the brief — never paste it verbatim, but ' +
      'use it as the starting structure for your `text_editor.create("index.html", ...)` call.',
    parameters: ViewDesignSkillParams,
    async execute(_id, params): Promise<AgentToolResult<ViewDesignSkillDetails>> {
      const source = SKILL_MAP.get(params.name);
      if (source === undefined) {
        const valid = Array.from(SKILL_MAP.keys()).join(', ');
        throw new Error(`Unknown design skill "${params.name}". Available: ${valid}`);
      }
      return {
        content: [{ type: 'text', text: source }],
        details: { name: params.name, source },
      };
    },
  };
}

const ViewFrameParams = Type.Object({
  name: Type.String(),
});

export interface ViewFrameDetails {
  name: string;
  source: string;
}

export function makeViewFrameTool(): AgentTool<typeof ViewFrameParams, ViewFrameDetails> {
  return {
    name: 'view_frame',
    label: 'View device frame',
    description:
      'Return the full source of a device-frame starter (iphone.jsx, ipad.jsx, watch.jsx, ' +
      'android.jsx, macos-safari.jsx). Use these as the wrapping shell for any mobile / tablet / ' +
      'watch / desktop-Safari design. The runtime pre-loads the IOSDevice / AppleWatchUltra / ' +
      'AndroidPhone / MacOSSafari globals, so the snippet drops straight into your `App` component.',
    parameters: ViewFrameParams,
    async execute(_id, params): Promise<AgentToolResult<ViewFrameDetails>> {
      const source = FRAME_MAP.get(params.name);
      if (source === undefined) {
        const valid = Array.from(FRAME_MAP.keys()).join(', ');
        throw new Error(`Unknown frame "${params.name}". Available: ${valid}`);
      }
      return {
        content: [{ type: 'text', text: source }],
        details: { name: params.name, source },
      };
    },
  };
}
