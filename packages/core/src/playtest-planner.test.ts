import { describe, expect, it } from 'vitest';
import { planPlaytest } from './playtest-planner';

describe('planPlaytest (Phase 6)', () => {
  it('skips playtest on a static artifact (no form / onclick / nav)', () => {
    const html = '<html><body><h1>Hi</h1><p>just text</p></body></html>';
    expect(planPlaytest(html).shouldPlaytest).toBe(false);
    expect(planPlaytest(html).steps).toHaveLength(0);
  });

  it('plans fill + submit for a form', () => {
    const html = `
      <form action="/contact">
        <input name="email" type="email" required>
        <input name="message" type="text" required>
        <button type="submit">Send</button>
      </form>
    `;
    const plan = planPlaytest(html);
    expect(plan.shouldPlaytest).toBe(true);
    const fills = plan.steps.filter((s) => s.action === 'fill');
    expect(fills).toHaveLength(2);
    expect(fills[0]?.value).toBe('test@example.com');
    expect(fills[1]?.value).toBe('playtest');
    expect(plan.steps.some((s) => s.action === 'submit')).toBe(true);
  });

  it('plans click for inline onclick handlers', () => {
    const html = `<button onclick="doTheThing()">Click</button>`;
    const plan = planPlaytest(html);
    expect(plan.shouldPlaytest).toBe(true);
    expect(plan.steps[0]?.action).toBe('click');
  });

  it('plans hover for navigation', () => {
    const html = `<nav><a href="/a">A</a><a href="/b">B</a></nav>`;
    const plan = planPlaytest(html);
    expect(plan.shouldPlaytest).toBe(true);
    expect(plan.steps[0]?.action).toBe('hover');
  });

  it('caps at MAX_STEPS = 5 even on heavily interactive artifacts', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => `<input name="f${i}" type="text"/>`).join(
      '',
    );
    const html = `<form>${inputs}<button onclick="submit()">Submit</button></form>`;
    const plan = planPlaytest(html);
    expect(plan.steps.length).toBeLessThanOrEqual(5);
  });

  it('every step carries a non-empty reason for telemetry', () => {
    const html = `<form><input name="email" type="email"></form>`;
    for (const step of planPlaytest(html).steps) {
      expect(step.reason.length).toBeGreaterThan(0);
    }
  });
});
