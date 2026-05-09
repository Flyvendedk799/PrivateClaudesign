import { fakeThreeDAssetProvider } from '@open-codesign/providers';
/**
 * may9 step 1 — generate_3d_asset tool tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { enrichThreeDPromptForPurpose, makeGenerate3dAssetTool } from './generate-3d-asset';
import type { TextEditorFsCallbacks } from './text-editor';

function fakeFs(): TextEditorFsCallbacks & { create: ReturnType<typeof vi.fn> } {
  return {
    view: vi.fn(),
    create: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    listDir: vi.fn(() => []),
  };
}

describe('enrichThreeDPromptForPurpose', () => {
  it('appends humanoid hint for character', () => {
    const out = enrichThreeDPromptForPurpose('warrior with sword', 'character');
    expect(out.toLowerCase()).toContain('humanoid');
  });

  it('appends weapon hint for weapon', () => {
    const out = enrichThreeDPromptForPurpose('m4 carbine', 'weapon');
    expect(out.toLowerCase()).toContain('weapon');
  });

  it("doesn't double-append when prompt already mentions the marker phrase", () => {
    const out = enrichThreeDPromptForPurpose('vehicle: sports car red', 'vehicle');
    // The marker is "Vehicle" (first phrase pre-colon). Already present
    // so the suffix shouldn't be appended; output should equal input.
    expect(out).toBe('vehicle: sports car red');
  });

  it('passes other through unchanged', () => {
    const out = enrichThreeDPromptForPurpose('some thing', 'other');
    expect(out).toBe('some thing');
  });
});

describe('makeGenerate3dAssetTool — fake provider', () => {
  it('writes a GLB file via fs.create + returns details', async () => {
    const fs = fakeFs();
    const tool = makeGenerate3dAssetTool(fakeThreeDAssetProvider, fs);
    const result = await tool.execute('id-1', { prompt: 'desert eagle pistol', purpose: 'weapon' });
    expect(fs.create).toHaveBeenCalledOnce();
    const [path, data] = fs.create.mock.calls[0] ?? [];
    expect(path).toMatch(/^assets\/models\/.+\.glb$/);
    expect(typeof data).toBe('string');
    expect(data).toMatch(/^data:base64,/);
    expect(result.details.path).toMatch(/^assets\/models\/.+\.glb$/);
    expect(result.details.provider).toBe('fake');
    expect(result.details.mimeType).toBe('model/gltf-binary');
  });

  it('honors filenameHint', async () => {
    const fs = fakeFs();
    const tool = makeGenerate3dAssetTool(fakeThreeDAssetProvider, fs);
    const result = await tool.execute('id-1', {
      prompt: 'whatever',
      purpose: 'prop',
      filenameHint: 'My-Cool-Hat 01',
    });
    expect(result.details.path).toBe('assets/models/my-cool-hat-01.glb');
  });

  it('rejects empty prompt', async () => {
    const tool = makeGenerate3dAssetTool(fakeThreeDAssetProvider, fakeFs());
    await expect(tool.execute('id-1', { prompt: '', purpose: 'prop' })).rejects.toThrow(
      /cannot be empty/i,
    );
  });

  it('passes style + topology through to the provider', async () => {
    const calls: Array<{ prompt: string; purpose: string; style?: string; topology?: string }> = [];
    const stub = async (req: {
      prompt: string;
      purpose: string;
      style?: string;
      topology?: string;
    }) => {
      calls.push(req);
      return fakeThreeDAssetProvider(req as never);
    };
    const tool = makeGenerate3dAssetTool(stub as never, fakeFs());
    await tool.execute('id-1', {
      prompt: 'pixel knight',
      purpose: 'character',
      style: 'low_poly',
      topology: 'quads',
    });
    const captured = calls[0];
    expect(captured?.style).toBe('low_poly');
    expect(captured?.topology).toBe('quads');
  });
});
