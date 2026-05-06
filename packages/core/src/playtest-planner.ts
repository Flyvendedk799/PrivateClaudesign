/**
 * Phase 6 — interaction playtest planner (game-mode `playtest_game` backport).
 *
 * Game-mode catches rotation/aim sign errors via synthetic input → state
 * playtest. Design-mode has the same blind spot: a form's `onsubmit` may
 * silently fail, an `onclick` handler may noop, an aria-target may
 * mismatch the live DOM. The planner inspects an HTML artifact and
 * returns a small set of high-leverage playtest steps (≤ 5) the runtime
 * can execute via Playwright at verify time.
 *
 * Pure parser — no IO, no Playwright dependency. Returns a plan; the
 * caller decides whether to actually execute it (lazy-loaded per the
 * §5 hard constraint).
 */

export interface PlaytestStep {
  /** What the runtime should do. */
  action: 'click' | 'fill' | 'submit' | 'hover';
  /** CSS selector or text-target. Caller resolves. */
  target: string;
  /** Optional input value for `fill`. */
  value?: string;
  /** Why this step is in the plan — telemetry / debug. */
  reason: string;
}

export interface PlaytestPlan {
  /** Whether the artifact carries enough interactivity to warrant a
   *  playtest. When false the runtime should skip Playwright entirely
   *  and only run the static lint + console capture. */
  shouldPlaytest: boolean;
  steps: ReadonlyArray<PlaytestStep>;
}

const MAX_STEPS = 5;

/** Plan a playtest from an HTML artifact. Picks the smallest set of
 *  actions that covers the artifact's documented interactivity surface
 *  area: forms (submit), top-N CTAs (click), hover-bearing nav. */
export function planPlaytest(html: string): PlaytestPlan {
  const steps: PlaytestStep[] = [];
  const lower = html.toLowerCase();
  // Heuristic: any of these signals interactivity worth probing.
  const hasForm = lower.includes('<form');
  const hasOnclick = lower.includes('onclick=') || lower.includes("addEventListener('click");
  const hasNav = lower.includes('<nav') || lower.includes('role="nav');
  if (!hasForm && !hasOnclick && !hasNav) {
    return { shouldPlaytest: false, steps: [] };
  }

  // 1. Forms — fill required fields with stub values, then submit.
  const formMatches = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) ?? [];
  for (const form of formMatches) {
    const inputs = (form.match(/<input[^>]+name="([^"]+)"[^>]*>/gi) ?? []).slice(0, 3);
    for (const input of inputs) {
      const name = (input.match(/name="([^"]+)"/i) ?? [])[1];
      if (!name) continue;
      const inputType = (input.match(/type="([^"]+)"/i) ?? [])[1] ?? 'text';
      const value = inputType === 'email' ? 'test@example.com' : 'playtest';
      steps.push({
        action: 'fill',
        target: `input[name="${name}"]`,
        value,
        reason: `form input "${name}" must accept value`,
      });
      if (steps.length >= MAX_STEPS) break;
    }
    if (steps.length >= MAX_STEPS) break;
    // Submit — first form only, then move on to other interactivity.
    steps.push({
      action: 'submit',
      target: 'form',
      reason: 'form submission should not throw',
    });
    break;
  }

  // 2. Click an aria-button or onclick element if room remains.
  if (steps.length < MAX_STEPS && hasOnclick) {
    steps.push({
      action: 'click',
      target: '[onclick], button, [role="button"]',
      reason: 'top onclick handler should not error',
    });
  }

  // 3. Hover the first nav element if room remains.
  if (steps.length < MAX_STEPS && hasNav) {
    steps.push({
      action: 'hover',
      target: 'nav a:first-of-type, [role="nav"] a:first-of-type',
      reason: 'nav hover should not throw',
    });
  }

  return {
    shouldPlaytest: steps.length > 0,
    steps: steps.slice(0, MAX_STEPS),
  };
}
