/**
 * Phase 6 — artifact-type classifier (game-mode backport).
 *
 * The fighting-game run failed first at the spec gate — the model picked
 * the wrong genre because the brief said "topview 3D fighting" and the
 * model heard "orthographic-top". Design-mode has the same trap: a brief
 * like "build me a sales dashboard" can produce a landing page, a slide
 * deck, or a one-pager depending on which keyword wins. The classifier
 * runs as a guardrail BEFORE generation: if the prompt's artifact-type
 * signal disagrees with the requested type, surface it.
 *
 * Pure heuristic — no LLM call, just keyword scoring. Returns the
 * top-ranked guess + confidence + every candidate's score. The runtime
 * decides whether to surface a confirmation dialog (low confidence) or
 * proceed silently (clear winner).
 */

export type ArtifactType =
  | 'landing'
  | 'dashboard'
  | 'pricing'
  | 'slide_deck'
  | 'one_pager'
  | 'case_study'
  | 'email'
  | 'mobile_flow'
  | 'report';

export interface ClassifyResult {
  type: ArtifactType;
  confidence: number;
  /** All candidate types and their scores, sorted descending. */
  candidates: ReadonlyArray<{ type: ArtifactType; score: number }>;
}

/** Keyword → artifact-type weight map. Tuned conservatively: a single
 *  strong signal (e.g. "pricing") wins outright, but ambiguous phrases
 *  ("dashboard interface" → could be either) leave the second-best
 *  within striking distance so the classifier reports low confidence. */
const KEYWORDS: Readonly<Record<string, Partial<Record<ArtifactType, number>>>> = Object.freeze({
  // landing
  landing: { landing: 5 },
  hero: { landing: 3 },
  cta: { landing: 2 },
  marketing: { landing: 2 },
  // dashboard
  dashboard: { dashboard: 5 },
  metrics: { dashboard: 3 },
  kpi: { dashboard: 3 },
  analytics: { dashboard: 2, report: 1 },
  chart: { dashboard: 2, report: 1 },
  // pricing
  pricing: { pricing: 5 },
  tier: { pricing: 2 },
  tiers: { pricing: 2 },
  plan: { pricing: 2 },
  plans: { pricing: 2 },
  // slide deck
  slide: { slide_deck: 5 },
  slides: { slide_deck: 5 },
  deck: { slide_deck: 4 },
  pitch: { slide_deck: 2 },
  presentation: { slide_deck: 4 },
  // one-pager
  'one pager': { one_pager: 5 },
  'one-pager': { one_pager: 5 },
  onepager: { one_pager: 4 },
  brief: { one_pager: 1 },
  // case study
  'case study': { case_study: 5 },
  'case-study': { case_study: 5 },
  // email
  email: { email: 5 },
  newsletter: { email: 3 },
  // mobile flow
  mobile: { mobile_flow: 4 },
  'tab bar': { mobile_flow: 3 },
  tabbar: { mobile_flow: 3 },
  app: { mobile_flow: 1 },
  // report
  report: { report: 5 },
  whitepaper: { report: 4 },
});

const ALL_TYPES: ReadonlyArray<ArtifactType> = [
  'landing',
  'dashboard',
  'pricing',
  'slide_deck',
  'one_pager',
  'case_study',
  'email',
  'mobile_flow',
  'report',
];

/** Classify a prompt. The returned `confidence` is the gap between the
 *  top score and the runner-up, normalised by the top score: 1 means
 *  "no second-place candidate scored at all", 0 means "tie". */
export function classifyArtifactType(prompt: string): ClassifyResult {
  const lower = prompt.toLowerCase();
  const scores: Record<ArtifactType, number> = {
    landing: 0,
    dashboard: 0,
    pricing: 0,
    slide_deck: 0,
    one_pager: 0,
    case_study: 0,
    email: 0,
    mobile_flow: 0,
    report: 0,
  };
  for (const [keyword, weights] of Object.entries(KEYWORDS)) {
    if (!lower.includes(keyword)) continue;
    for (const t of ALL_TYPES) {
      const w = weights[t];
      if (typeof w === 'number') scores[t] += w;
    }
  }
  const candidates = ALL_TYPES.map((type) => ({ type, score: scores[type] })).sort(
    (a, b) => b.score - a.score,
  );
  const top = candidates[0]!;
  const second = candidates[1]?.score ?? 0;
  const confidence = top.score === 0 ? 0 : (top.score - second) / top.score;
  return {
    type: top.score === 0 ? 'landing' : top.type,
    confidence,
    candidates,
  };
}
