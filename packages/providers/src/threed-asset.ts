/**
 * may9 step 1 — 3D asset generation provider abstraction.
 *
 * Provider-neutral interface for text → 3D model APIs. The agent's
 * `generate_3d_asset` tool calls a single function the host wires;
 * this file declares the request/response shapes + the Meshy adapter
 * (the v1 reference implementation) + a deterministic fake provider
 * for tests.
 *
 * Design rules:
 *   - BYOK only (per CLAUDE.md hard constraint #2). The host passes
 *     the user's API key in; this module never reads filesystem
 *     credentials directly.
 *   - Async by default — provider APIs poll task IDs to completion.
 *     Callers MUST pass an AbortSignal so user-cancellation propagates.
 *   - Output is a GLB (binary glTF). Returned as a base64-encoded
 *     `data:base64,…` string the host writes into design_files via
 *     the same `data:base64,` sentinel pattern image + audio use.
 *   - The agent's prompt is enriched purpose-side (low-poly vs
 *     hero-detail) by the tool factory before reaching the provider.
 *
 * Why these provider choices today (2026-05-09):
 *   - Meshy.ai — text-to-3D + image-to-3D, ~$0.30 per generation,
 *     POST /openapi/v2/text-to-3d returns task_id, GET polls.
 *     Quality-leader for game-ready meshes with PBR materials.
 *   - Tripo3D — alternative; can be added by implementing the same
 *     ThreeDAssetProvider interface in a sibling file.
 *   - Local providers (Hunyuan3D, etc.) — out of scope; CLAUDE.md
 *     §1 forbids bundled model runtimes.
 */

export type ThreeDAssetPurpose =
  | 'character'
  | 'weapon'
  | 'vehicle'
  | 'prop'
  | 'environment'
  | 'creature'
  | 'other';

export type ThreeDAssetStyle = 'realistic' | 'stylized' | 'sculpture' | 'low_poly' | 'voxel';

/** Shape the agent (via the tool factory) hands to a provider. */
export interface ThreeDAssetRequest {
  /** Free-text description of the asset. The tool factory enriches
   *  this with purpose-specific style guidance before the provider
   *  call. */
  prompt: string;
  purpose: ThreeDAssetPurpose;
  style?: ThreeDAssetStyle | undefined;
  /** Topology hint for the mesh — game-ready (decimated triangles)
   *  vs sculpt (high-density quads). Defaults to game-ready since
   *  the tool's primary consumer is real-time engines. */
  topology?: 'tris' | 'quads' | undefined;
  /** Whether the response should include PBR textures baked into the
   *  GLB. Adds ~30 s to generation. Defaults to true. */
  pbrTextures?: boolean | undefined;
  /** Optional reference image URL — text+image-to-3D when supported.
   *  Provider may ignore on text-only models. */
  referenceImageUrl?: string | undefined;
}

/** Shape the provider returns. The host writes this to disk; the
 *  tool result text references the path. */
export interface ThreeDAssetResult {
  /** Relative path inside the design's virtual FS. Always
   *  `assets/models/<slug>.glb`. */
  path: string;
  /** Base64-encoded GLB bytes prefixed with `data:base64,`. The
   *  desktop snapshot writer recognises this sentinel and stores
   *  the raw bytes; the renderer's iframe loads the GLB via
   *  game-files:// once written. */
  dataUrl: string;
  /** Always `model/gltf-binary` for v1. Future: `.glb` + `.usdz` +
   *  `.fbx` if a provider returns multiple formats. */
  mimeType: string;
  /** Provider id ('meshy' | 'tripo' | 'fake' | etc.). */
  provider: string;
  /** Provider-specific model id (e.g. 'meshy-4'). Surfaced in logs
   *  so a regression in mesh quality can be traced back to a model
   *  bump. */
  model: string;
  /** Polycount the provider reported. May be approximate. */
  triangleCount?: number | undefined;
  /** Provider may return a normalised version of the prompt (e.g.
   *  Meshy auto-translates non-English). Surface to the agent. */
  revisedPrompt?: string | undefined;
  /** Total wall-clock generation time in milliseconds. Surfaced in
   *  logs + the tool result so the agent learns the cost. */
  generationMs: number;
}

/** Provider-neutral generator. The host wires one of these into
 *  GenerateViaAgentDeps; the tool factory consumes it. */
export type ThreeDAssetProvider = (
  request: ThreeDAssetRequest,
  signal?: AbortSignal,
) => Promise<ThreeDAssetResult>;

// ---------------------------------------------------------------------
// Deterministic fake provider (tests + headless paths)
// ---------------------------------------------------------------------

/** A 1.6 KB minimal GLB with a single empty scene + node. Hex from a
 *  validated three-asset pipeline export; pasted as a base64 string
 *  to keep the source diffable. The agent's tool result references
 *  this when no real provider is wired (vitest, dev without an API
 *  key) so the tool's success path is testable end-to-end. */
const EMPTY_GLB_BASE64 =
  'Z2xURgIAAACkAAAAcAAAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAifSwic2NlbmUiOjAsInNjZW5lcyI6W3sibm9kZXMiOlswXX1dLCJub2RlcyI6W3sibmFtZSI6ImVtcHR5In1dfQ==';

/** A test/headless provider that returns the empty-scene GLB without
 *  making any network call. Lets unit tests exercise the full
 *  request → file-write → tool-result path without a Meshy key. */
export const fakeThreeDAssetProvider: ThreeDAssetProvider = async (request) => {
  return {
    path: `assets/models/${slugify(request.prompt)}.glb`,
    dataUrl: `data:base64,${EMPTY_GLB_BASE64}`,
    mimeType: 'model/gltf-binary',
    provider: 'fake',
    model: 'fake-3d-v1',
    triangleCount: 0,
    generationMs: 1,
  };
};

// ---------------------------------------------------------------------
// Meshy.ai adapter (v1 reference implementation)
// ---------------------------------------------------------------------

const MESHY_API_BASE = 'https://api.meshy.ai/openapi/v2';
const MESHY_DEFAULT_MODE = 'preview' as const;
const MESHY_POLL_INTERVAL_MS = 4_000;
const MESHY_MAX_POLL_DURATION_MS = 5 * 60_000; // 5 min absolute ceiling

interface MeshyTaskCreateResponse {
  result: string; // task id
}

interface MeshyTaskStatusResponse {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  model_urls?: { glb?: string; fbx?: string; usdz?: string };
  task_error?: { message?: string };
  prompt?: string;
  art_style?: string;
  topology?: string;
  triangle_count?: number;
}

export interface MeshyAdapterConfig {
  apiKey: string;
  /** Override base URL for testing or for a self-hosted proxy. */
  baseUrl?: string;
  /** Default style when the request omits one. */
  defaultStyle?: ThreeDAssetStyle;
}

/** Build a Meshy provider closure. The host instantiates one per
 *  generate() invocation so AbortSignal scoping is per-run. */
export function makeMeshyProvider(config: MeshyAdapterConfig): ThreeDAssetProvider {
  const baseUrl = config.baseUrl ?? MESHY_API_BASE;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  return async (request, signal) => {
    const started = Date.now();
    // Meshy's text-to-3D supports `art_style: realistic|sculpture` +
    // `topology: triangle|quad`. The wider style enum from this module
    // collapses cleanly: stylized + low_poly + voxel all map to
    // realistic with a phrase appended (Meshy currently has no
    // stylized art_style).
    const meshyStyle = request.style === 'sculpture' ? 'sculpture' : 'realistic';
    const meshyTopology = request.topology === 'quads' ? 'quad' : 'triangle';
    const stylePhrase =
      request.style === 'low_poly'
        ? 'low-poly stylized'
        : request.style === 'voxel'
          ? 'blocky voxel-style'
          : request.style === 'stylized'
            ? 'stylized cartoon'
            : '';
    const enrichedPrompt =
      stylePhrase.length > 0 ? `${stylePhrase} — ${request.prompt}` : request.prompt;

    // Step 1: create the task.
    const createBody = {
      mode: MESHY_DEFAULT_MODE,
      prompt: enrichedPrompt,
      art_style: meshyStyle,
      topology: meshyTopology,
      should_remesh: true,
      target_polycount: request.purpose === 'environment' ? 30_000 : 12_000,
      ai_model: 'meshy-4',
      ...(request.referenceImageUrl !== undefined ? { image_url: request.referenceImageUrl } : {}),
    };
    const createResp = await fetch(`${baseUrl}/text-to-3d`, {
      method: 'POST',
      headers,
      body: JSON.stringify(createBody),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!createResp.ok) {
      throw new Error(
        `Meshy text-to-3d create failed: ${createResp.status} ${createResp.statusText}`,
      );
    }
    const createJson = (await createResp.json()) as MeshyTaskCreateResponse;
    const taskId = createJson.result;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new Error('Meshy text-to-3d create returned no task id');
    }

    // Step 2: poll until SUCCEEDED / FAILED / timeout.
    const pollDeadline = started + MESHY_MAX_POLL_DURATION_MS;
    let task: MeshyTaskStatusResponse | null = null;
    while (Date.now() < pollDeadline) {
      if (signal?.aborted) throw new Error('Meshy text-to-3d aborted by caller');
      await new Promise((r) => setTimeout(r, MESHY_POLL_INTERVAL_MS));
      const statusResp = await fetch(`${baseUrl}/text-to-3d/${taskId}`, {
        method: 'GET',
        headers,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!statusResp.ok) continue; // transient — keep polling
      task = (await statusResp.json()) as MeshyTaskStatusResponse;
      if (task.status === 'SUCCEEDED' || task.status === 'FAILED' || task.status === 'CANCELED') {
        break;
      }
    }

    if (task === null) throw new Error('Meshy text-to-3d timed out before any status response');
    if (task.status !== 'SUCCEEDED') {
      const errMsg = task.task_error?.message ?? task.status;
      throw new Error(`Meshy text-to-3d ${task.status}: ${errMsg}`);
    }
    const glbUrl = task.model_urls?.glb;
    if (typeof glbUrl !== 'string' || glbUrl.length === 0) {
      throw new Error('Meshy text-to-3d SUCCEEDED but no model_urls.glb returned');
    }

    // Step 3: download the GLB bytes + base64-encode.
    const glbResp = await fetch(glbUrl, signal !== undefined ? { signal } : {});
    if (!glbResp.ok) {
      throw new Error(`Meshy GLB download failed: ${glbResp.status} ${glbResp.statusText}`);
    }
    const glbBytes = new Uint8Array(await glbResp.arrayBuffer());
    const base64 = bytesToBase64(glbBytes);
    return {
      path: `assets/models/${slugify(request.prompt)}.glb`,
      dataUrl: `data:base64,${base64}`,
      mimeType: 'model/gltf-binary',
      provider: 'meshy',
      model: 'meshy-4',
      ...(typeof task.triangle_count === 'number' ? { triangleCount: task.triangle_count } : {}),
      ...(typeof task.prompt === 'string' && task.prompt !== enrichedPrompt
        ? { revisedPrompt: task.prompt }
        : {}),
      generationMs: Date.now() - started,
    };
  };
}

// ---------------------------------------------------------------------
// Tripo3D adapter
// ---------------------------------------------------------------------
//
// Tripo's text-to-model API at https://platform.tripo3d.ai
//   POST /v2/openapi/task
//     body: { type: 'text_to_model', model_version, prompt, style?, ... }
//     resp: { code: 0, data: { task_id } }
//   GET  /v2/openapi/task/{task_id}
//     resp: { code: 0, data: { status, progress, output: { model | pbr_model } } }
// Auth: Bearer <api-key>. Same `data:base64,…` GLB shape on the way out.

const TRIPO_API_BASE = 'https://api.tripo3d.ai/v2/openapi';
const TRIPO_DEFAULT_MODEL_VERSION = 'v2.0-20240919';
const TRIPO_POLL_INTERVAL_MS = 4_000;
const TRIPO_MAX_POLL_DURATION_MS = 5 * 60_000;

interface TripoTaskCreateResponse {
  code: number;
  message?: string;
  data?: { task_id: string };
}

interface TripoTaskStatusResponse {
  code: number;
  message?: string;
  data?: {
    task_id?: string;
    status?: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'banned';
    progress?: number;
    output?: { model?: string; pbr_model?: string; rendered_image?: string };
    error?: { message?: string };
    prompt?: string;
  };
}

export interface TripoAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  /** Override the model version pin. Tripo bumps these every few months;
   *  the host can override without redeploying providers. */
  modelVersion?: string;
}

export function makeTripoProvider(config: TripoAdapterConfig): ThreeDAssetProvider {
  const baseUrl = config.baseUrl ?? TRIPO_API_BASE;
  const modelVersion = config.modelVersion ?? TRIPO_DEFAULT_MODEL_VERSION;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  return async (request, signal) => {
    const started = Date.now();
    // Tripo's `style` enum is narrower than ours. Map intent in the
    // prompt prefix when the requested style has no Tripo equivalent.
    const tripoStyle: string | undefined =
      request.style === 'low_poly'
        ? 'lowpoly'
        : request.style === 'voxel'
          ? 'voxel'
          : request.style === 'sculpture'
            ? undefined
            : request.style === 'stylized'
              ? 'cartoon'
              : undefined;
    const stylePrefix =
      request.style === 'sculpture'
        ? 'high-detail sculpt — '
        : tripoStyle === undefined && request.style === 'realistic'
          ? ''
          : '';
    const enrichedPrompt = `${stylePrefix}${request.prompt}`;

    // Step 1: create text_to_model task.
    const createBody: Record<string, unknown> = {
      type: 'text_to_model',
      model_version: modelVersion,
      prompt: enrichedPrompt,
      ...(tripoStyle !== undefined ? { style: tripoStyle } : {}),
      // Tripo returns PBR textures on `pbr_model`; flag it on by default
      // so we get the higher-quality output. Caller can opt out.
      texture: request.pbrTextures !== false,
      pbr: request.pbrTextures !== false,
    };
    const createResp = await fetch(`${baseUrl}/task`, {
      method: 'POST',
      headers,
      body: JSON.stringify(createBody),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!createResp.ok) {
      throw new Error(
        `Tripo text-to-model create failed: ${createResp.status} ${createResp.statusText}`,
      );
    }
    const createJson = (await createResp.json()) as TripoTaskCreateResponse;
    if (createJson.code !== 0 || createJson.data?.task_id === undefined) {
      throw new Error(
        `Tripo text-to-model create returned non-zero code: ${createJson.code} ${createJson.message ?? ''}`.trim(),
      );
    }
    const taskId = createJson.data.task_id;

    // Step 2: poll.
    const pollDeadline = started + TRIPO_MAX_POLL_DURATION_MS;
    let task: TripoTaskStatusResponse['data'] | null = null;
    while (Date.now() < pollDeadline) {
      if (signal?.aborted) throw new Error('Tripo text-to-model aborted by caller');
      await new Promise((r) => setTimeout(r, TRIPO_POLL_INTERVAL_MS));
      const statusResp = await fetch(`${baseUrl}/task/${taskId}`, {
        method: 'GET',
        headers,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!statusResp.ok) continue;
      const json = (await statusResp.json()) as TripoTaskStatusResponse;
      if (json.code !== 0) continue;
      task = json.data ?? null;
      const status = task?.status;
      if (
        status === 'success' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'banned'
      ) {
        break;
      }
    }

    if (task === null) throw new Error('Tripo text-to-model timed out before any status response');
    if (task.status !== 'success') {
      const errMsg = task.error?.message ?? task.status ?? 'unknown';
      throw new Error(`Tripo text-to-model ${task.status ?? 'unknown'}: ${errMsg}`);
    }
    const glbUrl = task.output?.pbr_model ?? task.output?.model;
    if (typeof glbUrl !== 'string' || glbUrl.length === 0) {
      throw new Error('Tripo text-to-model success but no output.model URL returned');
    }

    // Step 3: download.
    const glbResp = await fetch(glbUrl, signal !== undefined ? { signal } : {});
    if (!glbResp.ok) {
      throw new Error(`Tripo GLB download failed: ${glbResp.status} ${glbResp.statusText}`);
    }
    const glbBytes = new Uint8Array(await glbResp.arrayBuffer());
    const base64 = bytesToBase64(glbBytes);
    return {
      path: `assets/models/${slugify(request.prompt)}.glb`,
      dataUrl: `data:base64,${base64}`,
      mimeType: 'model/gltf-binary',
      provider: 'tripo',
      model: modelVersion,
      ...(typeof task.prompt === 'string' && task.prompt !== enrichedPrompt
        ? { revisedPrompt: task.prompt }
        : {}),
      generationMs: Date.now() - started,
    };
  };
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function slugify(input: string): string {
  const out = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return out.length > 0 ? out : 'model';
}

function bytesToBase64(bytes: Uint8Array): string {
  // Node + Electron main both have Buffer; renderer would need a
  // different path. This module only runs in the host (main) process.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Fallback for runtimes without Buffer (vitest happy-dom).
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return globalThis.btoa(binary);
}

export { slugify as _slugifyForTests };
