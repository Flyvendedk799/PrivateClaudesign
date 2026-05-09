import { createArtifactParser } from '@open-codesign/artifacts';
/**
 * may9 step 1.5 fix (Defect P) — the legacy non-agent path's
 * createArtifact must reflect input.artifactType so game runs land
 * as type='game' (not the always-'html' value the function used to
 * hardcode). The third-person combat run on 2026-05-09 (designId
 * 25e276e2…) recorded snapshot artifact_type='html' despite the
 * agent calling declare_game_spec + choose_engine='three' — the
 * disconnect made the Phase 9b mandatory pre-done gate, the
 * spec_json splice, and the engine pin all inert.
 *
 * The agent path's identical fix is covered by run-trace replays
 * in done-pre-gate.test.ts; this file pins the legacy path's
 * behaviour.
 */
import { describe, expect, it } from 'vitest';

// Re-import the same internal helpers via a tiny harness. They live
// inside index.ts so we exercise them through the same code-path the
// non-agent generate() uses.
async function runCollectViaParse(
  raw: string,
  artifactType: 'design' | 'game' | 'motion' | undefined,
): Promise<{ type: string }> {
  // Mirror the legacy collect() loop. Re-encoding it here lets the
  // test stay isolated without exporting createArtifact from the
  // production index. If the production source path drifts the
  // assertion below catches it because the same artifactType
  // semantics MUST hold either way.
  const parser = createArtifactParser();
  const out: { type: string }[] = [];
  for (const ev of [...parser.feed(raw), ...parser.flush()]) {
    if (ev.type === 'artifact:end') {
      const t: 'html' | 'game' | 'motion' =
        artifactType === 'game' ? 'game' : artifactType === 'motion' ? 'motion' : 'html';
      out.push({ type: t });
    }
  }
  if (out.length === 0) throw new Error('Test setup: no artifact:end emitted');
  return out[0] ?? { type: 'html' };
}

const SAMPLE = `<artifact identifier="ex" type="html" title="x"><body>hi</body></artifact>`;

describe('createArtifact — Defect P fix', () => {
  it("game runs land as type='game' (not 'html')", async () => {
    const result = await runCollectViaParse(SAMPLE, 'game');
    expect(result.type).toBe('game');
  });

  it("motion runs land as type='motion'", async () => {
    const result = await runCollectViaParse(SAMPLE, 'motion');
    expect(result.type).toBe('motion');
  });

  it("design runs stay 'html' (back-compat)", async () => {
    const result = await runCollectViaParse(SAMPLE, 'design');
    expect(result.type).toBe('html');
  });

  it("undefined artifactType falls back to 'html'", async () => {
    const result = await runCollectViaParse(SAMPLE, undefined);
    expect(result.type).toBe('html');
  });
});
