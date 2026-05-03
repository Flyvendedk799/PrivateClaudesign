# Audio bank — license + attribution

The samples committed under this directory are the bundled audio library
the `generate_audio_asset` tool draws from. Each entry in `manifest.json`
carries its own `license` field; the policy is **MIT-compatible / CC0
only**. No GPL/AGPL/SSPL-licensed audio enters the bundle.

## Current contents (Phase E1 starter set)

The shipped samples are short synthesized tones written by
`_generate-starter-samples.ts` (committed alongside). They live under
**CC0** as part of open-codesign itself. They're intentionally simple
(sine + envelope) so the tool is functional out of the box without a
multi-megabyte download.

## Planned expansion (curation queue)

- **Kenney CC0 game audio packs** (https://kenney.nl/assets) — UI,
  Impact, Footsteps, Sci-fi Sounds, RPG Sound Effects. Each pack is
  CC0 so attribution is optional but recommended; this file lists the
  specific files imported when they land.
- Total budget: ≤ 3 MB compressed across all curated entries. Past
  that the bundle starts to dominate cold-start size.

## How to add an entry

1. Drop the audio file under `sfx/`, `music/`, or `voice/`.
2. Add a manifest entry in `manifest.json` with id, purpose, path,
   mimeType, label, license string, and keywords array.
3. The lookup in `index.ts` is keyword-based — pick keywords the agent
   is plausibly going to use in its prompt.
4. Re-run `pnpm test` so the manifest-shape test catches typos.

## Why no streaming / generative audio

ElevenLabs / OpenAI TTS for generative SFX/music/voice is **deferred to
Phase E.1** (per gameplan.md §4 and §9). It will require explicit BYOK
keys and a UX signal that audio generation costs API tokens.
