/**
 * gameplan §E — bundled audio retrieval bank.
 *
 * v1 ships a small curated catalog (manifest.json + per-purpose folders).
 * Lookup is keyword-routed: the agent passes a free-text prompt + purpose
 * discriminator, we tokenize both and pick the entry with the highest
 * overlap-score against the entry's `keywords` array.
 *
 * The bundle currently ships a minimal set of synthesized samples so the
 * tool is functional out of the box. The Kenney CC0 expansion (Q9 + Q10)
 * is a curation task that drops more entries into the manifest + folders
 * without touching this module — the lookup logic stays the same.
 *
 * Why not a vector index? The catalog is small (≤ ~100 entries even after
 * curation) and the agent's prompts are short. Token-overlap scoring
 * matches in O(n) and produces a stable, debuggable winner. A real
 * embedding index would balloon the bundle without measurable gain.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AudioPurpose = 'sfx' | 'music' | 'voice';

export interface AudioBankEntry {
  /** Stable identifier — used as the on-disk filename stem too. */
  id: string;
  /** Discriminator the tool requires the agent to pass. */
  purpose: AudioPurpose;
  /** Path inside the bundle, relative to packages/core/src/audio-bank/. */
  path: string;
  /** MIME type of the file (audio/wav, audio/ogg, audio/mpeg). */
  mimeType: string;
  /** Searchable keywords. The lookup tokenizes prompts + scores overlap. */
  keywords: string[];
  /** Short human-friendly label surfaced to the agent in the result. */
  label: string;
  /** License + attribution for the underlying sample. */
  license: string;
  /** Source URL for the original sample, when applicable. */
  source?: string;
}

export interface AudioBankManifest {
  schemaVersion: 1;
  entries: AudioBankEntry[];
}

export interface AudioBankMatch {
  entry: AudioBankEntry;
  score: number;
}

let cachedManifest: AudioBankManifest | null = null;

/** Default loader — reads `manifest.json` from the bundled directory.
 *  Tests pass a stub instead. */
export async function loadAudioBankManifest(): Promise<AudioBankManifest> {
  if (cachedManifest !== null) return cachedManifest;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, 'manifest.json');
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as AudioBankManifest;
  cachedManifest = parsed;
  return parsed;
}

/** Test-only — drop the cached manifest so the next load re-reads disk. */
export function _resetAudioBankCache(): void {
  cachedManifest = null;
}

/** Tokenize a free-text prompt: lowercase, strip punctuation, drop short
 *  stop words. The catalog keywords are tokenized the same way by the
 *  bundle author. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'and',
  'or',
  'but',
  'is',
  'this',
  'that',
  'i',
  'you',
  'we',
  'my',
  'me',
]);

export function tokenize(input: string): string[] {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return words;
}

/** Score one entry against tokenized prompt words. Score = number of
 *  prompt tokens that match at least one entry keyword (substring or
 *  exact match — substrings let "footstep" match "footsteps"). */
export function scoreEntry(promptTokens: string[], entry: AudioBankEntry): number {
  let score = 0;
  for (const token of promptTokens) {
    for (const kw of entry.keywords) {
      if (kw === token || kw.includes(token) || token.includes(kw)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

/** Pick the best-matching entry for a given purpose + prompt. Ties break
 *  on the entry's first-keyword length (more specific wins). Returns
 *  null when no entry of that purpose exists in the manifest. */
export function pickBestMatch(
  manifest: AudioBankManifest,
  purpose: AudioPurpose,
  prompt: string,
): AudioBankMatch | null {
  const candidates = manifest.entries.filter((e) => e.purpose === purpose);
  if (candidates.length === 0) return null;
  const tokens = tokenize(prompt);
  let best: AudioBankMatch | null = null;
  for (const entry of candidates) {
    const score = scoreEntry(tokens, entry);
    if (best === null || score > best.score) {
      best = { entry, score };
    } else if (score === best.score) {
      // Tie-break: prefer the entry whose first keyword is longest
      // (proxy for specificity). Keeps the lookup deterministic.
      const a = best.entry.keywords[0]?.length ?? 0;
      const b = entry.keywords[0]?.length ?? 0;
      if (b > a) best = { entry, score };
    }
  }
  return best;
}

/** Read an audio entry's bytes off disk and base64-encode them for
 *  insertion into the design's virtual FS as a `data:base64,…` sentinel. */
export async function readAudioEntryBytes(entry: AudioBankEntry): Promise<Buffer> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, entry.path);
  return readFile(path);
}
