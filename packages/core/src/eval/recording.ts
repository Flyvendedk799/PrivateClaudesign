/**
 * may9 Phase 14 follow-up #34 — eval recording format.
 *
 * The "recording" format is the smallest thing that lets `pnpm
 * eval:games` run hermetically (no live API, no host designs.db):
 * a JSON file per fixture that captures the RunObservation a
 * recorded run produced. PRs can then replay that observation and
 * confirm every assertion still holds.
 *
 * Two non-goals (intentional):
 *   1. Capturing the full agent transcript (tool_use blocks, prompts,
 *      streaming). That's a fixture-replay PROVIDER, not a recording
 *      — it would re-execute the agent against frozen LLM responses.
 *      Useful but ~10x bigger than this.
 *   2. Verifying anything beyond the assertion surface the runner
 *      already knows about. Recordings round-trip through the same
 *      `evaluateFixture(fixture, observation)` path the live SQLite
 *      backend uses; only the source changes.
 *
 * Recording schema (RECORDING_SCHEMA_VERSION = 1):
 *
 *   {
 *     "schemaVersion": 1,
 *     "fixtureSlug": "fps-wave-defense",
 *     "capturedAt": "2026-05-09T12:00:00.000Z",
 *     "designId": "ba2adf62-...",  // optional, audit-only
 *     "observation": <RunObservation>,
 *     "notes": "first replay seeded from baseline; ..."
 *   }
 *
 * The CLI loads recordings via `--recording <path>` and skips the
 * SQLite lookup entirely.
 */
import type { RunObservation } from './runner.js';

export const RECORDING_SCHEMA_VERSION = 1 as const;

export interface EvalRecording {
  schemaVersion: 1;
  fixtureSlug: string;
  capturedAt: string;
  designId?: string;
  observation: RunObservation;
  notes?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Recording field '${key}' must be a non-empty string`);
  }
  return v;
}

function requireNumber(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`Recording field '${key}' must be a finite number`);
  }
  return v;
}

function parseObservation(raw: unknown): RunObservation {
  if (!isObject(raw)) throw new Error("Recording 'observation' must be an object");
  const toolCounts: Record<string, number> = {};
  if (raw['toolCounts'] !== undefined) {
    if (!isObject(raw['toolCounts'])) {
      throw new Error("'observation.toolCounts' must be an object");
    }
    for (const [k, v] of Object.entries(raw['toolCounts'])) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new Error(`'observation.toolCounts.${k}' must be a non-negative integer`);
      }
      toolCounts[k] = v;
    }
  }
  const filePaths: string[] = [];
  if (raw['filePaths'] !== undefined) {
    if (!Array.isArray(raw['filePaths'])) {
      throw new Error("'observation.filePaths' must be an array");
    }
    for (const f of raw['filePaths']) {
      if (typeof f !== 'string') throw new Error("'observation.filePaths[*]' must be strings");
      filePaths.push(f);
    }
  }
  return {
    engine: typeof raw['engine'] === 'string' ? raw['engine'] : null,
    genre: typeof raw['genre'] === 'string' ? raw['genre'] : null,
    inputTokens: requireNumber(raw, 'inputTokens'),
    outputTokens: requireNumber(raw, 'outputTokens'),
    cachedInputTokens: requireNumber(raw, 'cachedInputTokens'),
    toolCounts,
    strReplaceFailures: requireNumber(raw, 'strReplaceFailures'),
    filePaths,
    snapshotCount: requireNumber(raw, 'snapshotCount'),
    correctionCount: requireNumber(raw, 'correctionCount'),
  };
}

export function parseEvalRecording(raw: unknown): EvalRecording {
  if (!isObject(raw)) throw new Error('Recording must be an object');
  if (raw['schemaVersion'] !== 1) {
    throw new Error(`Unsupported recording schemaVersion: ${String(raw['schemaVersion'])}`);
  }
  const out: EvalRecording = {
    schemaVersion: 1,
    fixtureSlug: requireString(raw, 'fixtureSlug'),
    capturedAt: requireString(raw, 'capturedAt'),
    observation: parseObservation(raw['observation']),
  };
  if (typeof raw['designId'] === 'string' && raw['designId'].length > 0) {
    out.designId = raw['designId'];
  }
  if (typeof raw['notes'] === 'string') {
    out.notes = raw['notes'];
  }
  return out;
}

/** Minimum-viable recording to seed a fresh fixture: zeroes out
 *  everything but the engine + genre. Useful as a "starting point"
 *  template a contributor can hand-edit, or a sentinel that fails
 *  every assertion in a known way until a real run is captured. */
export function emptyRecording(
  fixtureSlug: string,
  engine?: string,
  genre?: string,
): EvalRecording {
  return {
    schemaVersion: 1,
    fixtureSlug,
    capturedAt: new Date().toISOString(),
    observation: {
      engine: engine ?? null,
      genre: genre ?? null,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      toolCounts: {},
      strReplaceFailures: 0,
      filePaths: [],
      snapshotCount: 0,
      correctionCount: 0,
    },
  };
}
