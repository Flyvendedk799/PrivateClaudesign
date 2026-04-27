import { describe, expect, it } from 'vitest';
import {
  makeListDesignSkillsTool,
  makeViewDesignSkillTool,
  makeViewFrameTool,
} from './design-library.js';

describe('list_design_skills tool', () => {
  it('returns one entry per bundled skill with name + whenToUse + size', async () => {
    const tool = makeListDesignSkillsTool();
    const res = await tool.execute('test', {});
    expect(res.details.skills.length).toBeGreaterThanOrEqual(12);
    for (const skill of res.details.skills) {
      expect(skill.name).toMatch(/\.jsx$/);
      expect(skill.sizeBytes).toBeGreaterThan(0);
      expect(skill.whenToUse.length).toBeGreaterThan(0);
    }
  });

  it('includes all 12 known skill names', async () => {
    const tool = makeListDesignSkillsTool();
    const res = await tool.execute('test', {});
    const names = new Set(res.details.skills.map((s) => s.name));
    for (const expected of [
      'slide-deck.jsx',
      'dashboard.jsx',
      'landing-page.jsx',
      'chart-svg.jsx',
      'glassmorphism.jsx',
      'editorial-typography.jsx',
      'heroes.jsx',
      'pricing.jsx',
      'footers.jsx',
      'chat-ui.jsx',
      'data-table.jsx',
      'calendar.jsx',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('parses the leading // when_to_use: comment block', async () => {
    const tool = makeListDesignSkillsTool();
    const res = await tool.execute('test', {});
    const landing = res.details.skills.find((s) => s.name === 'landing-page.jsx');
    expect(landing).toBeDefined();
    // The actual landing-page.jsx starts with "Full marketing landing pages"
    expect(landing?.whenToUse.toLowerCase()).toContain('landing');
  });

  it('formats text content as a bulleted catalogue', async () => {
    const tool = makeListDesignSkillsTool();
    const res = await tool.execute('test', {});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^Design skills available:/);
    expect(text).toContain('- landing-page.jsx');
  });
});

describe('view_design_skill tool', () => {
  it('returns the full source of a known skill', async () => {
    const tool = makeViewDesignSkillTool();
    const res = await tool.execute('test', { name: 'landing-page.jsx' });
    expect(res.details.name).toBe('landing-page.jsx');
    expect(res.details.source.length).toBeGreaterThan(100);
    expect(res.details.source).toContain('when_to_use');
  });

  it('throws with valid-names listing when the skill is unknown', async () => {
    const tool = makeViewDesignSkillTool();
    await expect(tool.execute('test', { name: 'not-a-real-skill.jsx' })).rejects.toThrow(
      /Unknown design skill.*Available:/,
    );
  });
});

describe('view_frame tool', () => {
  it('returns the full source of a known frame', async () => {
    const tool = makeViewFrameTool();
    const res = await tool.execute('test', { name: 'iphone.jsx' });
    expect(res.details.name).toBe('iphone.jsx');
    expect(res.details.source.length).toBeGreaterThan(100);
  });

  it('lists all 5 frames as valid names in the unknown-frame error', async () => {
    const tool = makeViewFrameTool();
    await expect(tool.execute('test', { name: 'nonexistent.jsx' })).rejects.toThrow(
      /Unknown frame.*iphone\.jsx.*ipad\.jsx.*watch\.jsx.*android\.jsx.*macos-safari\.jsx/,
    );
  });
});
