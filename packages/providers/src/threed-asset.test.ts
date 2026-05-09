import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeThreeDAssetProvider, makeMeshyProvider, makeTripoProvider } from './threed-asset';

const ORIGINAL_FETCH = globalThis.fetch;

describe('fakeThreeDAssetProvider', () => {
  it('returns a base64-encoded GLB at assets/models/<slug>.glb', async () => {
    const out = await fakeThreeDAssetProvider({ prompt: 'Desert Eagle pistol', purpose: 'weapon' });
    expect(out.path).toMatch(/^assets\/models\/desert-eagle-pistol\.glb$/);
    expect(out.dataUrl).toMatch(/^data:base64,/);
    expect(out.provider).toBe('fake');
    expect(out.mimeType).toBe('model/gltf-binary');
  });
});

describe('makeMeshyProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('creates a task, polls until SUCCEEDED, downloads the GLB', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const stubBody = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (url.endsWith('/text-to-3d') && init?.method === 'POST') {
        return new Response(JSON.stringify({ result: 'task-1' }), { status: 200 });
      }
      if (url.endsWith('/text-to-3d/task-1')) {
        return new Response(
          JSON.stringify({
            id: 'task-1',
            status: 'SUCCEEDED',
            model_urls: { glb: 'https://meshy.test/model.glb' },
            triangle_count: 4321,
            prompt: 'Desert Eagle pistol — revised',
          }),
          { status: 200 },
        );
      }
      if (url === 'https://meshy.test/model.glb') {
        return new Response(stubBody, { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const provider = makeMeshyProvider({ apiKey: 'msy-test' });
    const promise = provider({ prompt: 'Desert Eagle pistol', purpose: 'weapon' });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await promise;
    expect(out.provider).toBe('meshy');
    expect(out.path).toBe('assets/models/desert-eagle-pistol.glb');
    expect(out.triangleCount).toBe(4321);
    expect(out.revisedPrompt).toBe('Desert Eagle pistol — revised');
    expect(calls.find((c) => c.url.endsWith('/text-to-3d'))).toBeDefined();
  });

  it('throws on FAILED task with the provider message', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/text-to-3d') && init?.method === 'POST') {
        return new Response(JSON.stringify({ result: 'task-fail' }), { status: 200 });
      }
      if (url.endsWith('/text-to-3d/task-fail')) {
        return new Response(
          JSON.stringify({
            id: 'task-fail',
            status: 'FAILED',
            task_error: { message: 'inappropriate content' },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const provider = makeMeshyProvider({ apiKey: 'msy-test' });
    const promise = provider({ prompt: 'oops', purpose: 'prop' });
    const assertion = expect(promise).rejects.toThrow(/FAILED.*inappropriate content/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});

describe('makeTripoProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('creates a task, polls until success, downloads pbr_model GLB', async () => {
    const calls: { url: string; method: string }[] = [];
    const stubBody = new Uint8Array([9, 9, 9]);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url.endsWith('/openapi/task') && method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't-1' } }), {
          status: 200,
        });
      }
      if (url.endsWith('/openapi/task/t-1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              status: 'success',
              progress: 100,
              output: {
                model: 'https://tripo.test/raw.glb',
                pbr_model: 'https://tripo.test/pbr.glb',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://tripo.test/pbr.glb') {
        return new Response(stubBody, { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const provider = makeTripoProvider({ apiKey: 'tp-test' });
    const promise = provider({ prompt: 'Sci-fi katana', purpose: 'weapon' });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await promise;
    expect(out.provider).toBe('tripo');
    expect(out.path).toBe('assets/models/sci-fi-katana.glb');
    expect(out.dataUrl).toMatch(/^data:base64,/);
    // Pulled the pbr_model URL, not the raw model.
    expect(calls.some((c) => c.url === 'https://tripo.test/pbr.glb')).toBe(true);
    expect(calls.some((c) => c.url === 'https://tripo.test/raw.glb')).toBe(false);
  });

  it('falls back to model URL when pbr_model is absent', async () => {
    const stubBody = new Uint8Array([1]);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/openapi/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't-2' } }), {
          status: 200,
        });
      }
      if (url.endsWith('/openapi/task/t-2')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 'success', output: { model: 'https://tripo.test/raw.glb' } },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://tripo.test/raw.glb') {
        return new Response(stubBody, { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const provider = makeTripoProvider({ apiKey: 'tp-test' });
    const promise = provider({ prompt: 'plain', purpose: 'prop' });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await promise;
    expect(out.path).toBe('assets/models/plain.glb');
  });

  it('throws on failed task with the error message', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/openapi/task') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't-fail' } }), {
          status: 200,
        });
      }
      if (url.endsWith('/openapi/task/t-fail')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 'failed', error: { message: 'GPU unavailable' } },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const provider = makeTripoProvider({ apiKey: 'tp-test' });
    const promise = provider({ prompt: 'oops', purpose: 'prop' });
    const assertion = expect(promise).rejects.toThrow(/failed.*GPU unavailable/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('honors a custom modelVersion override', async () => {
    let createBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/openapi/task') && init?.method === 'POST') {
        createBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(JSON.stringify({ code: 0, data: { task_id: 't-v' } }), {
          status: 200,
        });
      }
      if (url.endsWith('/openapi/task/t-v')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status: 'success', output: { model: 'https://tripo.test/v.glb' } },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://tripo.test/v.glb') {
        return new Response(new Uint8Array([0]), { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const provider = makeTripoProvider({
      apiKey: 'tp-test',
      modelVersion: 'v3.0-test',
    });
    const promise = provider({ prompt: 'shape', purpose: 'prop' });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await promise;
    expect(out.model).toBe('v3.0-test');
    expect(createBody?.['model_version']).toBe('v3.0-test');
  });
});
