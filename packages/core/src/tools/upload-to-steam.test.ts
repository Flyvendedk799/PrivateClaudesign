import { describe, expect, it } from 'vitest';
import { type UploadToSteamFn, makeUploadToSteamTool } from './upload-to-steam';

describe('upload_to_steam tool', () => {
  it('reports success with build ID in the result text', async () => {
    const upload: UploadToSteamFn = async () => ({
      ok: true,
      log: 'Logged in OK\nSuccessfully finished AppBuild\nBuildID 999',
      buildId: '999',
      durationMs: 4567,
    });
    const tool = makeUploadToSteamTool(upload);
    const result = await tool.execute('id', { contentRoot: '/tmp/build' });
    expect(result.details.ok).toBe(true);
    expect(result.details.buildId).toBe('999');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Steam upload OK');
    expect(text).toContain('BuildID 999');
  });

  it('reports failure with the steamcmd log tail', async () => {
    const upload: UploadToSteamFn = async () => ({
      ok: false,
      log: 'a\nb\nFAILED upload: rate limited',
      durationMs: 1234,
    });
    const tool = makeUploadToSteamTool(upload);
    const result = await tool.execute('id', { contentRoot: '/tmp/build' });
    expect(result.details.ok).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('FAILED');
    expect(text).toContain('rate limited');
  });

  it('threads steamGuardCode + buildDescription into the upload call', async () => {
    const calls: Array<{
      contentRoot: string;
      steamGuardCode?: string;
      buildDescription?: string;
    }> = [];
    const upload: UploadToSteamFn = async (req) => {
      calls.push(req);
      return { ok: true, log: 'Successfully finished AppBuild', durationMs: 100 };
    };
    const tool = makeUploadToSteamTool(upload);
    await tool.execute('id', {
      contentRoot: '/tmp/build',
      steamGuardCode: 'AB12CD',
      buildDescription: 'rc1',
    });
    expect(calls[0]?.steamGuardCode).toBe('AB12CD');
    expect(calls[0]?.buildDescription).toBe('rc1');
  });
});
