/**
 * may9 step 1 — `generate_3d_asset` agent tool.
 *
 * Calls the host-injected ThreeDAssetProvider (Meshy by default) to
 * produce a GLB for the design's `assets/models/<slug>.glb`. The agent
 * uses this whenever the brief names a recognizable real-world object
 * (weapon, vehicle, character, branded item) — the may9 Phase 12 D7
 * anti-slop rule explicitly redirects the agent here from procedural
 * primitives.
 *
 * Provider-neutral: the host wires whichever provider the user has a
 * key for. Without a wired provider the tool isn't registered and the
 * agent falls back to procedural geometry + the D7 advisory still
 * fires from done's heuristics.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type {
  ThreeDAssetProvider,
  ThreeDAssetPurpose,
  ThreeDAssetResult,
  ThreeDAssetStyle,
} from '@open-codesign/providers';
import { Type } from '@sinclair/typebox';
import { type CoreLogger, NOOP_LOGGER } from '../logger.js';
import type { TextEditorFsCallbacks } from './text-editor';

const Generate3dAssetParams = Type.Object({
  prompt: Type.String({
    description:
      'Natural-language description of the model. Be specific about geometry + ' +
      'material (e.g. "Desert Eagle .50AE handgun, brushed steel slide, polymer grip" ' +
      'beats "pistol"). The provider may revise non-English prompts.',
  }),
  purpose: Type.Union([
    Type.Literal('character'),
    Type.Literal('weapon'),
    Type.Literal('vehicle'),
    Type.Literal('prop'),
    Type.Literal('environment'),
    Type.Literal('creature'),
    Type.Literal('other'),
  ]),
  style: Type.Optional(
    Type.Union([
      Type.Literal('realistic'),
      Type.Literal('stylized'),
      Type.Literal('sculpture'),
      Type.Literal('low_poly'),
      Type.Literal('voxel'),
    ]),
  ),
  topology: Type.Optional(Type.Union([Type.Literal('tris'), Type.Literal('quads')])),
  filenameHint: Type.Optional(
    Type.String({
      description: 'Override slug for the output path. Sanitised to kebab-case.',
    }),
  ),
});

export interface Generate3dAssetDetails {
  path: string;
  purpose: ThreeDAssetPurpose;
  mimeType: string;
  provider: string;
  model: string;
  triangleCount?: number | undefined;
  generationMs: number;
  revisedPrompt?: string | undefined;
}

const PURPOSE_STYLE_HINT: Record<ThreeDAssetPurpose, string> = {
  character:
    'Humanoid character: bipedal proportions, T-pose if no animation requested, ' +
    'separable head/body/limbs for rigging, neutral lighting in baked materials.',
  weapon:
    'Weapon: held in third-person hand position, single piece, brushed/painted ' +
    'metal where realistic, no muzzle flash baked in, scale appropriate to a ' +
    '6-foot character.',
  vehicle:
    'Vehicle: drivable scale (~5 m wheelbase for a car, ~3 m for a bike), ' +
    'hollow interior if cabin is visible, wheels as separate meshes if possible.',
  prop:
    'Game prop: neutral pose, scale ~1 m, decorative geometry, no embedded text ' +
    'unless prompted. Suitable for placement in the scene without further edits.',
  environment:
    'Environment chunk: tileable bounds where possible, mid-density polycount, ' +
    'modular pieces (walls, props) preferred over a single monolithic mesh.',
  creature:
    'Creature: anatomically plausible mesh, articulated limbs separable for ' +
    'rigging, scale appropriate to the brief (small if pet-class, large if ' +
    'boss-class).',
  other: '',
};

export function enrichThreeDPromptForPurpose(prompt: string, purpose: ThreeDAssetPurpose): string {
  const base = prompt.trim();
  const hint = PURPOSE_STYLE_HINT[purpose];
  if (hint.length === 0) return base;
  // Cheap dedupe — don't re-append if the agent already put the
  // first phrase in the prompt.
  const firstPhrase = hint.split(':')[0]?.toLowerCase() ?? '';
  if (firstPhrase.length > 0 && base.toLowerCase().includes(firstPhrase)) return base;
  return `${base}\n\n${hint}`;
}

export type Generate3dAssetFn = ThreeDAssetProvider;

export function makeGenerate3dAssetTool(
  generate: Generate3dAssetFn,
  fs: TextEditorFsCallbacks | undefined,
  logger: CoreLogger = NOOP_LOGGER,
): AgentTool<typeof Generate3dAssetParams, Generate3dAssetDetails> {
  return {
    name: 'generate_3d_asset',
    label: 'Generate 3D model',
    description:
      'Generate one game-ready GLB model for the project. Call this whenever the ' +
      'brief names a recognizable real-world object (weapon/vehicle/branded item/' +
      'named character) instead of building it from procedural primitives — ' +
      "primitives can't approximate recognizable shapes (FPS Wave Defense user: " +
      '"the M4 doesn\'t look like an M4"). Async (~30-90s per model). Output ' +
      'lands at assets/models/<slug>.glb, loadable via three.js GLTFLoader, ' +
      'Phaser BabylonJSPlugin, or Godot import. ABSTRACT shapes (generic platform, ' +
      'blob enemy, ground plane) should still use primitives.',
    parameters: Generate3dAssetParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<Generate3dAssetDetails>> {
      const rawPrompt = params.prompt.trim();
      if (rawPrompt.length === 0) throw new Error('3D asset prompt cannot be empty');
      const enrichedPrompt = enrichThreeDPromptForPurpose(rawPrompt, params.purpose);
      const request = {
        prompt: enrichedPrompt,
        purpose: params.purpose,
        ...(params.style !== undefined ? { style: params.style as ThreeDAssetStyle } : {}),
        ...(params.topology !== undefined ? { topology: params.topology } : {}),
      };
      const started = Date.now();
      logger.info('[3d_asset] step=start', {
        purpose: params.purpose,
        style: params.style ?? 'default',
        topology: params.topology ?? 'tris',
        promptChars: enrichedPrompt.length,
        promptPreview: enrichedPrompt.slice(0, 160),
      });
      let asset: ThreeDAssetResult;
      try {
        asset = await generate(request, signal);
      } catch (err) {
        logger.error('[3d_asset] step=fail', {
          purpose: params.purpose,
          ms: Date.now() - started,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      // Override path slug if the agent passed a filenameHint.
      let finalPath = asset.path;
      if (params.filenameHint !== undefined) {
        const stem = params.filenameHint
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (stem.length > 0) finalPath = `assets/models/${stem}.glb`;
      }
      if (fs !== undefined) {
        fs.create(finalPath, asset.dataUrl);
      }
      logger.info('[3d_asset] step=ok', {
        purpose: params.purpose,
        path: finalPath,
        provider: asset.provider,
        model: asset.model,
        triangleCount: asset.triangleCount ?? null,
        generationMs: asset.generationMs,
        ms: Date.now() - started,
      });
      const triangleSuffix =
        asset.triangleCount !== undefined ? ` (~${asset.triangleCount} tris)` : '';
      const revisedSuffix =
        asset.revisedPrompt !== undefined ? `\nRevised prompt: ${asset.revisedPrompt}` : '';
      const text = `Generated 3D model at ${finalPath}${triangleSuffix}. Load via three.js: \`new GLTFLoader().load("${finalPath}", gltf => scene.add(gltf.scene))\`. For Phaser: \`BabylonJSPlugin.load("${finalPath}")\`. For Godot: \`var gltf = preload("res://${finalPath}")\`.${revisedSuffix}`;
      return {
        content: [{ type: 'text', text }],
        details: {
          path: finalPath,
          purpose: params.purpose,
          mimeType: asset.mimeType,
          provider: asset.provider,
          model: asset.model,
          generationMs: asset.generationMs,
          ...(asset.triangleCount !== undefined ? { triangleCount: asset.triangleCount } : {}),
          ...(asset.revisedPrompt !== undefined ? { revisedPrompt: asset.revisedPrompt } : {}),
        },
      };
    },
  };
}
