import { describe, expect, it } from 'vitest';
import { detectGameModeFromPrompt, parsePromptCommand } from './prompt-commands';

describe('parsePromptCommand', () => {
  it('passes a plain prompt through untouched', () => {
    const r = parsePromptCommand('design a SaaS pricing page');
    expect(r).toEqual({ prompt: 'design a SaaS pricing page' });
  });

  it('extracts /jsx and returns the trailing prompt', () => {
    const r = parsePromptCommand('/jsx make a dashboard');
    expect(r.pattern).toBe('jsx');
    expect(r.prompt).toBe('make a dashboard');
    expect(r.showHelp).toBeUndefined();
  });

  it('extracts /vanilla and returns the trailing prompt', () => {
    const r = parsePromptCommand('/vanilla three-js scene of a brain');
    expect(r.pattern).toBe('vanilla');
    expect(r.prompt).toBe('three-js scene of a brain');
  });

  it('is case-insensitive on the command word', () => {
    const r = parsePromptCommand('/Vanilla a thing');
    expect(r.pattern).toBe('vanilla');
    expect(r.prompt).toBe('a thing');
  });

  it('tolerates leading whitespace before the slash', () => {
    const r = parsePromptCommand('   /jsx pricing page');
    expect(r.pattern).toBe('jsx');
    expect(r.prompt).toBe('pricing page');
  });

  it('returns showHelp:true with empty prompt for /help', () => {
    const r = parsePromptCommand('/help');
    expect(r.showHelp).toBe(true);
    expect(r.prompt).toBe('');
    expect(r.pattern).toBeUndefined();
  });

  it('passes unknown /commands through as ordinary prose', () => {
    const r = parsePromptCommand('/totallyfake do the thing');
    expect(r).toEqual({ prompt: '/totallyfake do the thing' });
  });

  it('does NOT treat /word followed by punctuation as a command', () => {
    const r = parsePromptCommand('/jsx,please');
    expect(r).toEqual({ prompt: '/jsx,please' });
  });

  it('treats a bare /jsx with no following prompt as command + empty prompt', () => {
    const r = parsePromptCommand('/jsx');
    expect(r.pattern).toBe('jsx');
    expect(r.prompt).toBe('');
  });

  it('strips trailing whitespace from the residual prompt', () => {
    const r = parsePromptCommand('/vanilla   build me a thing   ');
    expect(r.pattern).toBe('vanilla');
    expect(r.prompt).toBe('build me a thing');
  });

  it('does not strip slash commands deeper in the prompt', () => {
    const r = parsePromptCommand('please add /vanilla styling');
    expect(r).toEqual({ prompt: 'please add /vanilla styling' });
  });

  describe('auto-pattern detection', () => {
    it('auto-selects vanilla when the prompt mentions Three.js', () => {
      const r = parsePromptCommand('build a Three.js scene of a brain');
      expect(r.pattern).toBe('vanilla');
      expect(r.patternSource).toBe('auto');
      expect(r.prompt).toBe('build a Three.js scene of a brain');
    });

    it('auto-selects vanilla for shader / GLSL prompts', () => {
      const r = parsePromptCommand('a fragment shader playground with a custom GLSL editor');
      expect(r.pattern).toBe('vanilla');
      expect(r.patternSource).toBe('auto');
    });

    it('auto-selects vanilla for audio visualizer prompts', () => {
      const r = parsePromptCommand('an audio visualizer that reacts to mic input');
      expect(r.pattern).toBe('vanilla');
      expect(r.patternSource).toBe('auto');
    });

    it('auto-selects vanilla for physics-engine prompts', () => {
      const r = parsePromptCommand('toy with a 2D physics engine + bouncing balls');
      expect(r.pattern).toBe('vanilla');
      expect(r.patternSource).toBe('auto');
    });

    it('does NOT auto-flip ordinary landing-page prompts', () => {
      const r = parsePromptCommand('a clean SaaS pricing page with three tiers');
      expect(r.pattern).toBeUndefined();
      expect(r.patternSource).toBeUndefined();
    });

    it('manual /jsx wins over auto-detect signals', () => {
      const r = parsePromptCommand('/jsx render a Three.js skybox inside React');
      expect(r.pattern).toBe('jsx');
      expect(r.patternSource).toBe('manual');
    });

    it('manual /vanilla is marked as manual source even when content also matches', () => {
      const r = parsePromptCommand('/vanilla a webgl particle field');
      expect(r.pattern).toBe('vanilla');
      expect(r.patternSource).toBe('manual');
    });
  });

  describe('expanded multi-file heuristic — Phase 2.1', () => {
    it.each([
      'admin panel for a logistics company',
      'admin dashboard with users, products, and orders',
      'kanban board like Trello',
      'Trello-like project management tool',
      'analytics dashboard with three charts',
      'observability platform for our microservices',
      'multi-step onboarding wizard with 4 screens',
      'signup flow with email verification',
      'chat app like Slack',
      'whiteboard tool with sticky notes',
      'drawing tool with brush + eraser',
      'code editor playground for JavaScript',
      'markdown editor with live preview',
      'WYSIWYG editor with image upload',
      'quiz app with 10 questions',
      'survey builder for product feedback',
      'analytics dashboard using d3',
      'design tool with tldraw',
      'spreadsheet using prosemirror',
      'IDE-like playground with monaco editor',
      'documentation site for our API',
      'docs site with sidebar nav',
      'multi-page site for a SaaS launch',
      'landing page with a blog and case studies',
    ])('auto-flips to vanilla for: %s', (input) => {
      const r = parsePromptCommand(input);
      expect(r.pattern).toBe('vanilla');
      expect(r.patternSource).toBe('auto');
    });

    it.each([
      'a clean SaaS pricing page with three tiers',
      'simple landing page for a coffee shop',
      'portfolio for a photographer with 5 sections',
      'iPhone mock of a notes app',
      'pricing comparison table for two tiers',
      'iPad lock-screen with weather widget',
    ])('does NOT auto-flip ordinary single-page prompts: %s', (input) => {
      const r = parsePromptCommand(input);
      expect(r.pattern).toBeUndefined();
      expect(r.patternSource).toBeUndefined();
    });

    it('does not flip on a casual mention of "data table" inside a landing page', () => {
      const r = parsePromptCommand(
        'landing page for a CRM that mentions a data table feature in the hero',
      );
      // "data table" alone is not a strong enough signal — only kanban /
      // admin panel / multi-step flow / external lib / multi-page hits.
      expect(r.pattern).toBeUndefined();
    });
  });
});

describe('detectGameModeFromPrompt — auto-route game-genre prompts to game-mode', () => {
  it.each([
    'create a first-person shooter wave defense',
    'first person shooter with 3 weapons',
    'FPS prototype with simple AI',
    'twin-stick shooter set in space',
    'tower defense with 5 enemy types',
    'wave defense game with upgrades',
    'wave survival on a desert map',
    '2D platformer like Celeste',
    'metroidvania with a grappling hook',
    'endless runner where the player avoids cars',
    'roguelike with permadeath',
    'rogue-lite with meta progression',
    'battle royale prototype on a small island',
    'shoot em up with bullet hell waves',
    'shmup with pickups',
    'tactical RPG with grid-based combat',
    'turn-based combat prototype',
    'dungeon crawler with procedural rooms',
    'racing game with 3 tracks',
    'fighting game with 4 characters',
    'rhythm game synced to a 120 BPM track',
    'puzzle game with sokoban-style levels',
    'arcade game with high-score table',
    'retro game in the style of Galaga',
    'idle game where you tap to mine ore',
    'open-world game with a small village',
    'simple 2d game with a player + enemies',
    'build me a 3d game with a starter ship',
    'small game where you collect coins',
    'phaser game with 3 scenes',
    'three.js scene with gameplay',
    'godot project for a metroidvania',
    'pygame project with arcade physics',
    'MOBA prototype with two heroes',
    'JRPG with a small overworld',
  ])('flips to game-mode for: %s', (input) => {
    expect(detectGameModeFromPrompt(input)).toBe(true);
  });

  it.each([
    'landing page for a video game studio',
    'pricing page for a game-development SaaS',
    'documentation site for a game engine library',
    'simple SaaS landing page',
    'iPhone mock of a notes app',
    'three.js scene of a brain',
    'admin dashboard with users and orders',
    'multi-step onboarding wizard',
    'portfolio for a game artist',
  ])('does NOT flip on: %s', (input) => {
    expect(detectGameModeFromPrompt(input)).toBe(false);
  });
});
