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

// may9 step 1.5 fix (Defect Q) — Electron's main bundle inlines this
// module into apps/desktop/out/main/index.js, so import.meta.url no
// longer points at packages/core/src/audio-bank where manifest.json
// + the *.wav samples actually live. The third-person combat run
// (designId 25e276e2…) recorded `ENOENT: no such file or directory,
// open '<repo>/apps/desktop/out/main/manifest.json'` four times in
// 2026-05-09 main.log; the agent gave up on audio generation entirely.
//
// Fix: cache the manifest per-directory and let the HOST inject the
// audio-bank dir explicitly via apps/desktop/src/main when constructing
// the tool. The import.meta.url fallback stays for in-package tests
// and for the unit tests that don't go through the host.
const manifestCache = new Map<string, AudioBankManifest>();

/** Resolve the audio-bank dir to use. When the caller passes one
 *  (production path), trust it. Otherwise fall back to the
 *  import.meta.url-relative resolution that works in unit tests + the
 *  in-package dev mode. */
function resolveBankDir(injectedDir?: string): string {
  if (injectedDir !== undefined && injectedDir.length > 0) return injectedDir;
  return dirname(fileURLToPath(import.meta.url));
}

/** Default loader — reads `manifest.json` from the resolved bank dir.
 *  `bankDir` overrides the import.meta.url fallback so the host can
 *  point at the real source path post-bundle. Tests pass a stub
 *  instead. */
export async function loadAudioBankManifest(bankDir?: string): Promise<AudioBankManifest> {
  const here = resolveBankDir(bankDir);
  const cached = manifestCache.get(here);
  if (cached !== undefined) return cached;
  const path = join(here, 'manifest.json');
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as AudioBankManifest;
  manifestCache.set(here, parsed);
  return parsed;
}

/** Test-only — drop the cached manifests so the next load re-reads
 *  disk for every dir. */
export function _resetAudioBankCache(): void {
  manifestCache.clear();
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
 *  insertion into the design's virtual FS as a `data:base64,…` sentinel.
 *  `bankDir` MUST be the same dir loadAudioBankManifest used so the
 *  entry.path resolves to the right wav file. */
export async function readAudioEntryBytes(
  entry: AudioBankEntry,
  bankDir?: string,
): Promise<Buffer> {
  const here = resolveBankDir(bankDir);
  const path = join(here, entry.path);
  return readFile(path);
}
