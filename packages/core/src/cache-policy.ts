/**
 * Phase 1 — Prompt cache policy.
 *
 * pi-ai's `anthropic-messages` adapter already places `cache_control` markers
 * on the right blocks (last system block, last tool schema, last user message)
 * when `cacheRetention !== 'none'`. The lever this module provides is making
 * the decision **explicit** instead of relying on pi-ai's `'short'` default,
 * and making the per-provider intent visible in one place so future changes
 * (e.g., enabling 1h `'long'` retention for paid Anthropic API tiers) live
 * here and not scattered across stream-fn call sites.
 *
 * Policy:
 *   - `anthropic-messages`: 'short' (5 min ephemeral) for design runs and
 *     'long' (1h) for game runs. System prompt + tool schemas + last user
 *     message are auto-cached by pi-ai.
 *   - All other APIs: 'none'. OpenAI / Gemini / Bedrock do automatic prefix
 *     caching server-side; setting cacheRetention is a no-op or rejected.
 *
 * `'long'` (1h) retention is billed differently, so keep it scoped to game
 * runs where quick successive fix-runs commonly miss the 5 min window.
 *
 * NOTE: cache hits require **byte-identical** prefix. The system prompt is
 * built by `composeSystemPrompt` (./prompts/index.ts) and contains no
 * timestamps / random ids. `previousHtml` is intentionally NOT in the system
 * prompt — it's seeded into the agent's virtual fs (see
 * `apps/desktop/src/main/index.ts:494`) so a re-edit on the same design
 * keeps the prefix stable.
 */

import type { Api } from '@mariozechner/pi-ai';

export type CacheRetention = 'none' | 'short' | 'long';

/** Resolve the cache retention to forward into pi-ai's stream options.
 *  Caller passes the model's `api` field; we return the policy decision.
 *  Optional `override` lets a test or A/B flag force a specific value. */
export function resolveCachePolicy(
  api: Api,
  override?: CacheRetention,
  options: { artifactType?: 'design' | 'game' | 'motion' } = {},
): CacheRetention {
  if (override !== undefined) return override;
  if (api === 'anthropic-messages') {
    return options.artifactType === 'game' || options.artifactType === 'motion' ? 'long' : 'short';
  }
  return 'none';
}
