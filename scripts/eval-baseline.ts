#!/usr/bin/env tsx
/**
 * may9 Phase 0 — emit a baseline metrics report by querying the user's
 * local designs.db. One-shot tool; produces evals/baseline-{date}.md so
 * later phases can compute deltas against the same numbers.
 *
 * Usage:
 *   pnpm tsx scripts/eval-baseline.ts            # writes evals/baseline-{today}.md
 *   pnpm tsx scripts/eval-baseline.ts --print    # prints to stdout instead
 *
 * Reads from: ~/Library/Application Support/@open-codesign/desktop/designs.db
 *
 * Designs reported:
 *   - FPS Wave Defense   (ba2adf62-…)  — the May-8 trace
 *   - Brawler            (c44763af-…)  — the May-3 fight-game run
 * Plus a "top-5-by-tool-count" honorable-mentions section.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB_PATH = join(homedir(), 'Library/Application Support/@open-codesign/desktop/designs.db');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

interface DesignRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  generation_id: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  total_chunks: number;
  total_ms: number;
  implied_cost_usd: number;
  model_id: string | null;
  created_at: string;
}

interface ToolCountRow {
  tool: string | null;
  n: number;
}

interface SnapshotRow {
  id: string;
  type: string;
  created_at: string;
  size_bytes: number;
}

interface ErrorRow {
  seq: number;
  created_at: string;
  payload: string;
}

const FOCUS_DESIGNS: { label: string; pattern: string }[] = [
  { label: 'FPS Wave Defense', pattern: 'First-Person Shooter%' },
  { label: 'Brawler (top-view 3D fighter)', pattern: 'create a topview%fighting%' },
];

function loadDesign(db: Database.Database, pattern: string): DesignRow | undefined {
  return db
    .prepare(
      `SELECT id, name, created_at, updated_at
         FROM designs
         WHERE name LIKE ? AND deleted_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(pattern) as DesignRow | undefined;
}

function loadRuns(db: Database.Database, designId: string): RunRow[] {
  return db
    .prepare(
      `SELECT generation_id, input_tokens, output_tokens, cached_input_tokens,
              cache_creation_input_tokens, total_chunks, total_ms,
              implied_cost_usd, model_id, created_at
         FROM run_usage WHERE design_id = ? ORDER BY created_at`,
    )
    .all(designId) as RunRow[];
}

function loadToolCounts(db: Database.Database, designId: string): ToolCountRow[] {
  return db
    .prepare(
      `SELECT json_extract(payload, '$.toolName') AS tool, COUNT(*) AS n
         FROM chat_messages
         WHERE design_id = ? AND kind = 'tool_call'
         GROUP BY tool ORDER BY n DESC`,
    )
    .all(designId) as ToolCountRow[];
}

function loadSnapshots(db: Database.Database, designId: string): SnapshotRow[] {
  return db
    .prepare(
      `SELECT id, type, created_at, length(artifact_source) AS size_bytes
         FROM design_snapshots WHERE design_id = ? ORDER BY created_at`,
    )
    .all(designId) as SnapshotRow[];
}

function loadErrors(db: Database.Database, designId: string): ErrorRow[] {
  return db
    .prepare(
      `SELECT seq, created_at, payload
         FROM chat_messages WHERE design_id = ? AND kind = 'error'
         ORDER BY seq`,
    )
    .all(designId) as ErrorRow[];
}

function classifyError(payload: string): string {
  if (payload.includes('overloaded_error')) return 'overloaded';
  if (payload.includes('token has expired')) return 'oauth_expired';
  if (payload.includes('llama3.2')) return 'ollama_misconfig';
  if (payload.includes('Request was aborted')) return 'aborted';
  if (payload.includes('stream was interrupted')) return 'stream_interrupted';
  if (payload.includes('Paused at safe boundary')) return 'paused_safe_boundary';
  return 'other';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function summarizeDesign(db: Database.Database, label: string, design: DesignRow): string {
  const runs = loadRuns(db, design.id);
  const tools = loadToolCounts(db, design.id);
  const snapshots = loadSnapshots(db, design.id);
  const errors = loadErrors(db, design.id);

  const totalIn = runs.reduce((s, r) => s + r.input_tokens, 0);
  const totalOut = runs.reduce((s, r) => s + r.output_tokens, 0);
  const totalCacheRead = runs.reduce((s, r) => s + r.cached_input_tokens, 0);
  const totalCacheCreate = runs.reduce((s, r) => s + r.cache_creation_input_tokens, 0);
  const totalCost = runs.reduce((s, r) => s + r.implied_cost_usd, 0);
  const totalMs = runs.reduce((s, r) => s + r.total_ms, 0);
  const cacheHitRate = totalIn > 0 ? totalCacheRead / totalIn : 0;

  const errorsByKind = new Map<string, number>();
  for (const e of errors) {
    const k = classifyError(e.payload);
    errorsByKind.set(k, (errorsByKind.get(k) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push(`### ${label} — \`${design.id}\``);
  lines.push('');
  lines.push(`- **Window**: ${design.created_at} → ${design.updated_at}`);
  lines.push(`- **Snapshots**: ${snapshots.length} (initial + ${snapshots.length - 1} edits)`);
  lines.push(`- **Runs**: ${runs.length}`);
  lines.push(
    `- **Tokens**: ${fmtTokens(totalIn)} in (cache-read ${fmtTokens(totalCacheRead)}, cache-create ${fmtTokens(totalCacheCreate)}) / ${fmtTokens(totalOut)} out`,
  );
  lines.push(`- **Cache hit rate**: ${(cacheHitRate * 100).toFixed(1)}%`);
  lines.push(`- **Implied cost**: $${totalCost.toFixed(2)}`);
  lines.push(`- **Wall-time across runs**: ${(totalMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('**Tool calls (top 12):**');
  lines.push('');
  lines.push('| tool | calls |');
  lines.push('|---|---:|');
  for (const t of tools.slice(0, 12)) {
    lines.push(`| \`${t.tool ?? '(null)'}\` | ${t.n} |`);
  }
  lines.push('');
  if (errors.length > 0) {
    lines.push('**Errors by classification:**');
    lines.push('');
    lines.push('| kind | n |');
    lines.push('|---|---:|');
    for (const [k, n] of [...errorsByKind.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| \`${k}\` | ${n} |`);
    }
    lines.push('');
  }
  const minSize = snapshots.reduce((m, s) => Math.min(m, s.size_bytes), Number.POSITIVE_INFINITY);
  const maxSize = snapshots.reduce((m, s) => Math.max(m, s.size_bytes), 0);
  lines.push(
    `**Source size range**: ${(minSize / 1024).toFixed(1)} KB – ${(maxSize / 1024).toFixed(1)} KB across snapshots.`,
  );
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const print = args.has('--print');
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [];
  out.push(`# Baseline metrics — ${today}`);
  out.push('');
  out.push('Generated by `scripts/eval-baseline.ts` from the local designs.db.');
  out.push('Frozen baseline used by may9 Phase 0 → Phase 14 to compute deltas.');
  out.push('');
  out.push('## Focus designs');
  out.push('');

  for (const focus of FOCUS_DESIGNS) {
    const d = loadDesign(db, focus.pattern);
    if (!d) {
      out.push(`### ${focus.label}\n\n_(not found in local DB)_\n`);
      continue;
    }
    out.push(summarizeDesign(db, focus.label, d));
  }

  out.push('## Baseline targets (post-V2 must beat these)');
  out.push('');
  out.push('| metric | FPS | Brawler | post-V2 target |');
  out.push('|---|---:|---:|---:|');
  out.push('| `validate_game_scene` calls | 1 | — | ≥ 1 per snapshot |');
  out.push('| `playtest_game` calls       | 1 | — | ≥ 1 per snapshot (delta > 5%) |');
  out.push('| `set_todos` calls           | 93 | — | ≤ 12 per design |');
  out.push('| `render_preview` calls      | 5 | — | 0 |');
  out.push('| `str_replace_*` calls       | 428 | — | ≤ 200 per design |');
  out.push('| follow-up input tokens      | 1.45M (run 2) | — | ≥ 40% lower |');
  out.push('| corrections needed          | ~10 | 6 | ≤ 2 |');
  out.push('| pointer-lock SecurityError  | 1 | — | 0 |');
  out.push('| destructive-edit collapses  | 1 (-80%) | — | flagged before done |');
  out.push('');
  out.push('See `docs/may9.md` for the full sequenced plan that drives these targets.');
  out.push('');

  const md = out.join('\n');

  if (print) {
    process.stdout.write(md);
    return;
  }

  const outPath = join(REPO_ROOT, 'evals', `baseline-${today}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md);
  process.stdout.write(`Wrote ${outPath}\n`);
}

main();
