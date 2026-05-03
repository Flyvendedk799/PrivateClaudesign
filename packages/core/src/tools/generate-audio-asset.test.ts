/**
 * gameplan §E1 — generate-audio-asset tool tests.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AudioBankManifest } from '../audio-bank/index';
import { makeGenerateAudioAssetTool } from './generate-audio-asset';
import type { TextEditorFsCallbacks } from './text-editor';

const FIXTURE: AudioBankManifest = {
  schemaVersion: 1,
  entries: [
    {
      id: 'click',
      purpose: 'sfx',
      path: 'sfx/click.wav',
      mimeType: 'audio/wav',
      label: 'UI click',
      license: 'CC0',
      keywords: ['click', 'tap', 'button', 'ui'],
    },
    {
      id: 'coin',
      purpose: 'sfx',
      path: 'sfx/coin.wav',
      mimeType: 'audio/wav',
      label: 'Coin pickup',
      license: 'CC0',
      keywords: ['coin', 'pickup', 'gem'],
    },
    {
      id: 'menu_jingle',
      purpose: 'music',
      path: 'music/menu.wav',
      mimeType: 'audio/wav',
      label: 'Menu jingle',
      license: 'CC0',
      keywords: ['menu', 'jingle', 'title', 'intro'],
    },
  ],
};

const FAKE_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46]); // RIFF header

function fakeFs(): { fs: TextEditorFsCallbacks; created: Map<string, string> } {
  const created = new Map<string, string>();
  const fs: TextEditorFsCallbacks = {
    create: vi.fn((path: string, content: string) => {
      created.set(path, content);
      return { path, contentLength: content.length, lineCount: 1, success: true };
    }),
    str_replace: vi.fn(),
    insert: vi.fn(),
    view: vi.fn(),
  } as unknown as TextEditorFsCallbacks;
  return { fs, created };
}

describe('generate_audio_asset', () => {
  it('writes the matched audio bytes into the design as a data:base64 sentinel', async () => {
    const { fs, created } = fakeFs();
    const tool = makeGenerateAudioAssetTool(fs, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    const result = await tool.execute('call-1', { prompt: 'a coin pickup', purpose: 'sfx' });
    expect(result.details?.entryId).toBe('coin');
    expect(result.details?.path).toBe('assets/audio/coin.wav');
    const written = created.get('assets/audio/coin.wav');
    expect(written).toBe(`data:base64,${FAKE_BYTES.toString('base64')}`);
  });

  it('honours filenameHint and sanitises unsafe characters', async () => {
    const { fs, created } = fakeFs();
    const tool = makeGenerateAudioAssetTool(fs, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    await tool.execute('call-2', {
      prompt: 'button click',
      purpose: 'sfx',
      filenameHint: 'my UI/click sound!',
    });
    expect(Array.from(created.keys())[0]).toBe('assets/audio/my_UI_click_sound.wav');
  });

  it('respects the purpose discriminator (music ↔ sfx are scoped)', async () => {
    const { fs, created } = fakeFs();
    const tool = makeGenerateAudioAssetTool(fs, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    await tool.execute('call-3', { prompt: 'menu intro', purpose: 'music' });
    expect(Array.from(created.keys())[0]).toBe('assets/audio/menu_jingle.wav');
  });

  it('throws a clear error when no entries exist for the requested purpose', async () => {
    const tool = makeGenerateAudioAssetTool(undefined, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    await expect(
      tool.execute('call-4', { prompt: 'announce game over', purpose: 'voice' }),
    ).rejects.toThrow(/No audio bank entries available for purpose='voice'/);
  });

  it('throws on empty prompt', async () => {
    const tool = makeGenerateAudioAssetTool(undefined, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    await expect(tool.execute('call-5', { prompt: '   ', purpose: 'sfx' })).rejects.toThrow(
      /cannot be empty/,
    );
  });

  it('returns a text content block referencing the path + license', async () => {
    const tool = makeGenerateAudioAssetTool(undefined, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    const result = await tool.execute('call-6', { prompt: 'gem pickup', purpose: 'sfx' });
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('assets/audio/coin.wav');
    expect(text).toContain('CC0');
  });

  it('includes match score in details for telemetry', async () => {
    const tool = makeGenerateAudioAssetTool(undefined, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    const result = await tool.execute('call-7', {
      prompt: 'tap a button on the UI',
      purpose: 'sfx',
    });
    expect(result.details?.entryId).toBe('click');
    expect(result.details?.matchScore).toBeGreaterThanOrEqual(2);
  });

  it('no-ops fs.create when fs is undefined (lets host stream the bytes)', async () => {
    const tool = makeGenerateAudioAssetTool(undefined, undefined, {
      loadManifest: async () => FIXTURE,
      loadBytes: async () => FAKE_BYTES,
    });
    const result = await tool.execute('call-8', { prompt: 'coin', purpose: 'sfx' });
    expect(result.details?.path).toBe('assets/audio/coin.wav');
  });
});
