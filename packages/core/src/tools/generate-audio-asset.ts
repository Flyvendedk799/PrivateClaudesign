/**
 * gameplan §E1 — `generate_audio_asset` tool.
 *
 * Looks up the best-matching sample in the bundled audio bank, copies
 * its bytes into the design's virtual FS at `assets/audio/<name>.wav`,
 * and returns the path for the agent to reference.
 *
 * v1 backend = bundled Kenney CC0 sample bank (small starter set ships
 * synthesized samples — ops expands the manifest with curated Kenney
 * packs without touching this code).
 *
 * Generative TTS (ElevenLabs / OpenAI) is deferred to Phase E.1 — the
 * tool's purpose taxonomy is forward-compatible with that switchover.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import {
  type AudioBankManifest,
  type AudioPurpose,
  loadAudioBankManifest,
  pickBestMatch,
  readAudioEntryBytes,
} from '../audio-bank/index.js';
import { type CoreLogger, NOOP_LOGGER } from '../logger.js';
import type { TextEditorFsCallbacks } from './text-editor';

const GenerateAudioAssetParams = Type.Object({
  prompt: Type.String(),
  purpose: Type.Union([Type.Literal('sfx'), Type.Literal('music'), Type.Literal('voice')]),
  /** Optional file-name stem the tool sanitises. Defaults to the entry id. */
  filenameHint: Type.Optional(Type.String()),
});

export interface GenerateAudioAssetDetails {
  /** Path inside the design's virtual FS where the WAV landed. */
  path: string;
  /** Manifest entry id selected. */
  entryId: string;
  purpose: AudioPurpose;
  /** Human-friendly label from the manifest, surfaced to the agent. */
  label: string;
  /** License + attribution from the manifest. */
  license: string;
  /** Score the matcher gave the chosen entry against the prompt. */
  matchScore: number;
}

const SAFE_NAME_RE = /[^a-zA-Z0-9._-]+/g;

function sanitiseFilenameStem(s: string): string {
  return s.replace(SAFE_NAME_RE, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function extFromMime(mime: string): string {
  switch (mime) {
    case 'audio/wav':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mpeg':
      return 'mp3';
    default:
      return 'wav';
  }
}

export interface MakeGenerateAudioAssetToolOpts {
  /** Loader override — production reads `manifest.json`; tests stub it. */
  loadManifest?: () => Promise<AudioBankManifest>;
  /** Bytes loader override — production reads the file off disk. */
  loadBytes?: (entry: AudioBankManifest['entries'][number]) => Promise<Buffer>;
  /** may9 step 1.5 fix (Defect Q) — explicit audio-bank dir from the
   *  host. Ignored when loadManifest/loadBytes are also overridden
   *  (tests pass stubs). When set, the default loaders use this dir
   *  to resolve `manifest.json` + entry paths instead of falling
   *  back to import.meta.url (which lands at the bundled-out/main
   *  location, not packages/core/src/audio-bank). */
  bankDir?: string;
}

export function makeGenerateAudioAssetTool(
  fs: TextEditorFsCallbacks | undefined,
  logger: CoreLogger = NOOP_LOGGER,
  opts: MakeGenerateAudioAssetToolOpts = {},
): AgentTool<typeof GenerateAudioAssetParams, GenerateAudioAssetDetails> {
  const bankDir = opts.bankDir;
  const loadManifest = opts.loadManifest ?? (() => loadAudioBankManifest(bankDir));
  const loadBytes = opts.loadBytes ?? ((entry) => readAudioEntryBytes(entry, bankDir));
  return {
    name: 'generate_audio_asset',
    label: 'Generate audio asset',
    description:
      'Pick a short audio cue from the bundled CC0 sample bank and write it ' +
      'into the design at assets/audio/<name>. Use for SFX (one-shot button ' +
      'clicks, jumps, hits, coin pickups), short music loops (menu jingle, ' +
      'ambient pad), or voice notification cues. Pass `purpose` to scope the ' +
      'search and a free-text `prompt` describing what you want. The tool ' +
      'returns a relative path to load via pygame.mixer.Sound, new Audio(...), ' +
      'phaser.sound.add, or godot AudioStreamPlayer. Synchronous and fast ' +
      '(no network); call as many times as you need cues.',
    parameters: GenerateAudioAssetParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<GenerateAudioAssetDetails>> {
      const promptText = params.prompt.trim();
      if (promptText.length === 0) throw new Error('Audio asset prompt cannot be empty');
      const started = Date.now();

      const manifest = await loadManifest();
      const match = pickBestMatch(manifest, params.purpose, promptText);
      if (match === null) {
        throw new Error(
          `No audio bank entries available for purpose='${params.purpose}'. Drop a curated sample into packages/core/src/audio-bank/ and add it to manifest.json.`,
        );
      }

      const bytes = await loadBytes(match.entry);
      const ext = extFromMime(match.entry.mimeType);
      const stem = sanitiseFilenameStem(params.filenameHint ?? match.entry.id);
      const safeStem = stem.length > 0 ? stem : match.entry.id;
      const path = `assets/audio/${safeStem}.${ext}`;
      const dataUrl = `data:base64,${bytes.toString('base64')}`;
      if (fs !== undefined) fs.create(path, dataUrl);

      logger.info('[audio_asset] step=ok', {
        purpose: params.purpose,
        entryId: match.entry.id,
        path,
        score: match.score,
        bytes: bytes.length,
        ms: Date.now() - started,
      });

      return {
        content: [
          {
            type: 'text',
            text:
              `Wrote ${match.entry.label} to ${path} (${match.entry.mimeType}, ${bytes.length} bytes). ` +
              `Reference this path from your engine's audio loader. Source: ${match.entry.license}.`,
          },
        ],
        details: {
          path,
          entryId: match.entry.id,
          purpose: params.purpose,
          label: match.entry.label,
          license: match.entry.license,
          matchScore: match.score,
        },
      };
    },
  };
}
