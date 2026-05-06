import { describe, expect, it } from 'vitest';
import { classifyArtifactType } from './artifact-type-classifier';

describe('classifyArtifactType (Phase 6)', () => {
  it('clear pricing brief lands type=pricing with high confidence', () => {
    const r = classifyArtifactType('Build a B2B pricing page with three tiers');
    expect(r.type).toBe('pricing');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('clear dashboard brief lands type=dashboard', () => {
    const r = classifyArtifactType('Sales analytics dashboard with KPI tiles and charts');
    expect(r.type).toBe('dashboard');
  });

  it('one-pager brief disambiguates from landing', () => {
    expect(classifyArtifactType('Create a one-pager for our investor brief').type).toBe(
      'one_pager',
    );
  });

  it('mobile flow disambiguates from landing despite shared marketing words', () => {
    expect(classifyArtifactType('Mobile app flow with tab bar navigation for 5 screens').type).toBe(
      'mobile_flow',
    );
  });

  it('slide deck wins over landing when "deck" or "slides" appears', () => {
    expect(classifyArtifactType('A 6-slide pitch deck for our seed round').type).toBe('slide_deck');
  });

  it('confidence drops near 0 when two strong keywords compete (low confidence → ask)', () => {
    const r = classifyArtifactType(
      'A pricing dashboard that shows tier sales charts and KPI cards',
    );
    expect(r.confidence).toBeLessThan(0.4);
  });

  it('empty / off-topic prompt returns confidence 0 (caller falls back to default)', () => {
    expect(classifyArtifactType('').confidence).toBe(0);
    expect(classifyArtifactType('hello').confidence).toBe(0);
  });

  it('case study / report / email each score correctly on a 1-keyword prompt', () => {
    expect(classifyArtifactType('Write a case study').type).toBe('case_study');
    expect(classifyArtifactType('Quarterly report').type).toBe('report');
    expect(classifyArtifactType('Newsletter email').type).toBe('email');
  });

  it('candidates are returned sorted descending so the runtime can show top-3', () => {
    const r = classifyArtifactType('A pricing dashboard with charts');
    for (let i = 1; i < r.candidates.length; i += 1) {
      const prev = r.candidates[i - 1]?.score ?? 0;
      const cur = r.candidates[i]?.score ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });
});
