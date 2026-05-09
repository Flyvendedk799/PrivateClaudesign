/**
 * may9 Phase 14 — eval-fixture schema.
 *
 * Each fixture under `evals/fixtures/<slug>.json` describes what a
 * successful run of a brief should produce. The runner consumes
 * these and reports per-fixture pass/fail in `evals/runs/{date}.md`.
 *
 * Schema is hand-written to avoid pulling Zod into core (which
 * already uses TypeBox for tools). The fixture set is small and
 * the validation surface is narrow.
 */

export const EVAL_FIXTURE_SCHEMA_VERSION = 1 as const;

export const EVAL_ENGINES = ['three', 'phaser', 'pygame', 'godot'] as const;
export type EvalEngine = (typeof EVAL_ENGINES)[number];
export const EvalEngine = {
  parse(value: unknown): EvalEngine {
    if (typeof value !== 'string' || !(EVAL_ENGINES as readonly string[]).includes(value)) {
      throw new Error(`Invalid engine: ${String(value)}`);
    }
    return value as EvalEngine;
  },
} as const;

export interface EvalAssertion {
  expectedEngine?: EvalEngine;
  expectedGenre?: string;
  requiredFiles: string[];
  requiredAudio: boolean;
  maxInputTokens: number;
  maxStrReplaceFailureRate: number;
  maxSetTodosCalls: number;
  minValidateGameSceneCalls: number;
  minPlaytestGameCalls: number;
  maxRenderPreviewCalls: number;
  maxCorrections: number;
}

const ASSERTION_DEFAULTS: EvalAssertion = {
  requiredFiles: [],
  requiredAudio: false,
  maxInputTokens: 1_400_000,
  maxStrReplaceFailureRate: 0.05,
  maxSetTodosCalls: 8,
  minValidateGameSceneCalls: 1,
  minPlaytestGameCalls: 1,
  maxRenderPreviewCalls: 0,
  maxCorrections: 2,
};

export interface EvalFixture {
  schemaVersion: 1;
  name: string;
  slug: string;
  description: string;
  brief: string;
  playtestPlaybook?: string;
  assertions: EvalAssertion;
}

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(o: Record<string, unknown>, key: string, max = 8000): string {
  const v = o[key];
  if (typeof v !== 'string') throw new Error(`Field '${key}' must be a string`);
  if (v.length === 0) throw new Error(`Field '${key}' must not be empty`);
  if (v.length > max) throw new Error(`Field '${key}' exceeds max length ${max}`);
  return v;
}

function requirePositiveInt(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`Field '${key}' must be a non-negative integer`);
  }
  return v;
}

function optionalAssertion(raw: unknown): EvalAssertion {
  if (raw === undefined || raw === null) return { ...ASSERTION_DEFAULTS };
  if (!isObject(raw)) throw new Error("'assertions' must be an object");
  const out: EvalAssertion = { ...ASSERTION_DEFAULTS };

  if (raw['expectedEngine'] !== undefined) {
    out.expectedEngine = EvalEngine.parse(raw['expectedEngine']);
  }
  if (raw['expectedGenre'] !== undefined) {
    out.expectedGenre = requireString(raw, 'expectedGenre', 40);
  }
  if (raw['requiredFiles'] !== undefined) {
    if (!Array.isArray(raw['requiredFiles'])) {
      throw new Error("'requiredFiles' must be an array");
    }
    out.requiredFiles = raw['requiredFiles'].map((f, i) => {
      if (typeof f !== 'string' || f.length === 0) {
        throw new Error(`requiredFiles[${i}] must be a non-empty string`);
      }
      return f;
    });
  }
  if (raw['requiredAudio'] !== undefined) {
    if (typeof raw['requiredAudio'] !== 'boolean') {
      throw new Error("'requiredAudio' must be a boolean");
    }
    out.requiredAudio = raw['requiredAudio'];
  }
  if (raw['maxInputTokens'] !== undefined) {
    out.maxInputTokens = requirePositiveInt(raw, 'maxInputTokens');
  }
  if (raw['maxStrReplaceFailureRate'] !== undefined) {
    const v = raw['maxStrReplaceFailureRate'];
    if (typeof v !== 'number' || v < 0 || v > 1) {
      throw new Error("'maxStrReplaceFailureRate' must be in [0, 1]");
    }
    out.maxStrReplaceFailureRate = v;
  }
  if (raw['maxSetTodosCalls'] !== undefined) {
    out.maxSetTodosCalls = requirePositiveInt(raw, 'maxSetTodosCalls');
  }
  if (raw['minValidateGameSceneCalls'] !== undefined) {
    out.minValidateGameSceneCalls = requirePositiveInt(raw, 'minValidateGameSceneCalls');
  }
  if (raw['minPlaytestGameCalls'] !== undefined) {
    out.minPlaytestGameCalls = requirePositiveInt(raw, 'minPlaytestGameCalls');
  }
  if (raw['maxRenderPreviewCalls'] !== undefined) {
    out.maxRenderPreviewCalls = requirePositiveInt(raw, 'maxRenderPreviewCalls');
  }
  if (raw['maxCorrections'] !== undefined) {
    out.maxCorrections = requirePositiveInt(raw, 'maxCorrections');
  }
  return out;
}

export const EvalFixture = {
  parse(raw: unknown): EvalFixture {
    if (!isObject(raw)) throw new Error('EvalFixture must be an object');
    if (raw['schemaVersion'] !== undefined && raw['schemaVersion'] !== 1) {
      throw new Error(`Unsupported schemaVersion: ${String(raw['schemaVersion'])}`);
    }
    const slug = requireString(raw, 'slug', 64);
    if (!SLUG_RE.test(slug)) {
      throw new Error(`slug must match ${String(SLUG_RE)} — got '${slug}'`);
    }
    const fixture: EvalFixture = {
      schemaVersion: 1,
      name: requireString(raw, 'name', 120),
      slug,
      description: requireString(raw, 'description', 500),
      brief: requireString(raw, 'brief', 8_000),
      assertions: optionalAssertion(raw['assertions']),
    };
    if (raw['playtestPlaybook'] !== undefined) {
      fixture.playtestPlaybook = requireString(raw, 'playtestPlaybook', 40);
    }
    return fixture;
  },
} as const;

export const EvalAssertion = {
  defaults(): EvalAssertion {
    return { ...ASSERTION_DEFAULTS };
  },
  parse(raw: unknown): EvalAssertion {
    return optionalAssertion(raw);
  },
} as const;

/** Result shape one fixture produces after the runner inspects a run. */
export interface EvalResult {
  fixture: EvalFixture;
  pass: boolean;
  durationMs: number;
  failures: string[];
  observed: {
    engine: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    setTodosCalls: number;
    validateGameSceneCalls: number;
    playtestGameCalls: number;
    renderPreviewCalls: number;
    strReplaceCalls: number;
    audioCalls: number;
    snapshotCount: number;
    correctionCount: number;
  };
}

export interface EvalReport {
  generatedAt: string;
  baselineRef?: string;
  results: EvalResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}
