#!/usr/bin/env tsx
/**
 * may9 Phase 14 — `pnpm eval:games` CLI.
 *
 * Reads the eval fixtures under `evals/fixtures/*.json`, pulls a
 * RunObservation for each fixture from the local designs.db (matching
 * by design name), evaluates the assertions, and writes the markdown
 * report to `evals/runs/<date>.md`.
 *
 * The fixture's `slug` field is matched against design name with
 * fuzzy logic (slugified). When no matching design is found, the
 * fixture is reported as "skipped (no recording)" rather than failed
 * — recording fresh runs is a separate workflow.
 *
 * Usage:
 *   pnpm tsx scripts/eval-games.ts                 # writes evals/runs/{today}.md
 *   pnpm tsx scripts/eval-games.ts --print         # prints to stdout
 *   pnpm tsx scripts/eval-games.ts --json          # emits a JSON blob
 *   pnpm tsx scripts/eval-games.ts --baseline-only # skip fixtures with no DB match
 *
 * Re-run after rebuilding better-sqlite3 native bindings:
 *   pnpm rebuild better-sqlite3
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvalFixture,
  type EvalReport,
  type EvalResult,
  type RunObservation,
  evaluateFixture,
  renderEvalReport,
} from '@open-codesign/core';
import Database from 'better-sqlite3';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DB_PATH = join(homedir(), 'Library/Application Support/@open-codesign/desktop/designs.db');
const FIXTURES_DIR = join(REPO_ROOT, 'evals/fixtures');
const RUNS_DIR = join(REPO_ROOT, 'evals/runs');

interface DesignRow {
  id: string;
  name: string;
}

interface RunRow {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}

interface ToolRow {
  tool: string | null;
  n: number;
}

interface ToolDurationRow {
  tool_name: string;
  status: string;
  n: number;
}

interface FileRow {
  path: string;
}

interface SnapshotRow {
  id: string;
  prompt: string | null;
  engine: string | null;
  spec_json: string | null;
}

function loadFixtures(): EvalFixture[] {
  const out: EvalFixture[] = [];
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const raw = readFileSync(join(FIXTURES_DIR, f), 'utf8');
    const parsed = EvalFixture.parse(JSON.parse(raw));
    out.push(parsed);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function findMatchingDesign(db: Database.Database, fixture: EvalFixture): DesignRow | null {
  // Match by name LIKE first (case-insensitive). Phrasing is forgiving
  // because design names drift over time.
  const tokens = fixture.slug.split('-').filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;
  const pattern = `%${tokens.join('%')}%`;
  const row = db
    .prepare(
      'SELECT id, name FROM designs WHERE deleted_at IS NULL AND lower(name) LIKE lower(?) ORDER BY updated_at DESC LIMIT 1',
    )
    .get(pattern) as DesignRow | undefined;
  return row ?? null;
}

function observeDesign(db: Database.Database, designId: string): RunObservation {
  // Aggregate run_usage tokens.
  const runRow = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens
         FROM run_usage WHERE design_id = ?`,
    )
    .get(designId) as RunRow;

  // Tool-call counts from chat_messages.
  const toolRows = db
    .prepare(
      `SELECT json_extract(payload, '$.toolName') AS tool, COUNT(*) AS n
         FROM chat_messages
         WHERE design_id = ? AND kind = 'tool_call'
         GROUP BY tool`,
    )
    .all(designId) as ToolRow[];
  const toolCounts: Record<string, number> = {};
  for (const r of toolRows) {
    if (r.tool !== null) toolCounts[r.tool] = r.n;
  }

  // str_replace failure count from run_tool_durations (when present).
  let strReplaceFailures = 0;
  try {
    const durRows = db
      .prepare(
        `SELECT tool_name, status, COUNT(*) AS n
           FROM run_tool_durations
           WHERE design_id = ?
             AND tool_name IN ('str_replace_based_edit_tool','str_replace')
           GROUP BY tool_name, status`,
      )
      .all(designId) as ToolDurationRow[];
    for (const r of durRows) {
      if (r.status === 'error') strReplaceFailures += r.n;
    }
  } catch {
    /* run_tool_durations table doesn't exist on legacy DBs — skip */
  }

  // File set: read latest snapshot's files via design_snapshot_files.
  let filePaths: string[] = [];
  try {
    const fileRows = db
      .prepare(
        `SELECT DISTINCT path FROM design_snapshot_files
           WHERE snapshot_id IN (
             SELECT id FROM design_snapshots
               WHERE design_id = ?
               ORDER BY created_at DESC LIMIT 1
           )`,
      )
      .all(designId) as FileRow[];
    filePaths = fileRows.map((r) => r.path);
  } catch {
    /* design_snapshot_files may not exist on legacy DBs — skip */
  }

  // Snapshot count + correction count (number of edit-type snapshots
  // beyond the initial). Each user prompt creates one snapshot.
  const snapRows = db
    .prepare(
      `SELECT id, prompt, engine, spec_json FROM design_snapshots
         WHERE design_id = ? ORDER BY created_at`,
    )
    .all(designId) as SnapshotRow[];
  const snapshotCount = snapRows.length;
  const correctionCount = Math.max(0, snapshotCount - 1);

  // Engine + genre from the latest snapshot.
  let engine: string | null = null;
  let genre: string | null = null;
  for (const s of snapRows) {
    if (s.engine !== null && s.engine !== '') engine = s.engine;
    if (s.spec_json !== null && s.spec_json !== '') {
      try {
        const spec = JSON.parse(s.spec_json) as { genre?: string };
        if (typeof spec.genre === 'string') genre = spec.genre;
      } catch {
        /* malformed spec_json — leave genre null */
      }
    }
  }

  return {
    engine,
    genre,
    inputTokens: runRow.input_tokens,
    outputTokens: runRow.output_tokens,
    cachedInputTokens: runRow.cached_input_tokens,
    toolCounts,
    strReplaceFailures,
    filePaths,
    snapshotCount,
    correctionCount,
  };
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const print = args.has('--print');
  const json = args.has('--json');
  const baselineOnly = args.has('--baseline-only');

  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    process.stderr.write(`No fixtures found in ${FIXTURES_DIR}\n`);
    process.exit(1);
  }

  let db: Database.Database;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    process.stderr.write(
      `Failed to open designs.db at ${DB_PATH}: ${err instanceof Error ? err.message : String(err)}\nRun the app at least once to seed it, or pass --print on a machine without the DB to dry-run with empty observations.\n`,
    );
    process.exit(2);
    return;
  }

  const results: EvalResult[] = [];
  for (const fx of fixtures) {
    const start = Date.now();
    const design = findMatchingDesign(db, fx);
    if (design === null) {
      if (baselineOnly) continue;
      const result = evaluateFixture(fx, undefined, Date.now() - start);
      result.failures.unshift(`(no recording in designs.db for slug '${fx.slug}')`);
      result.pass = false;
      results.push(result);
      continue;
    }
    const observation = observeDesign(db, design.id);
    results.push(evaluateFixture(fx, observation, Date.now() - start));
  }

  const passed = results.filter((r) => r.pass).length;
  const today = new Date().toISOString().slice(0, 10);
  const report: EvalReport = {
    generatedAt: today,
    baselineRef: 'evals/baseline-2026-05-09.md',
    results,
    summary: { total: results.length, passed, failed: results.length - passed },
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const md = renderEvalReport(report);
  if (print) {
    process.stdout.write(md);
    return;
  }

  mkdirSync(RUNS_DIR, { recursive: true });
  const outPath = join(RUNS_DIR, `${today}.md`);
  writeFileSync(outPath, md);
  process.stdout.write(`Wrote ${outPath}\n${passed}/${results.length} fixtures passed.\n`);
  if (results.length - passed > 0) process.exit(1);
}

main();
