import { describe, expect, it } from 'vitest';
import { parsePromptCommand } from './prompt-commands';

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
});
