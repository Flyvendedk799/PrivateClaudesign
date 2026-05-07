/**
 * motion-graphics-plan §3 / §0.1 — `render_motion_preview` agent tool.
 *
 * Renders a single still frame of a registered composition via the host's
 * `@remotion/renderer.renderStill` shim. Returns a PNG content block the
 * model can read directly so it can visually spot-check timing, missing
 * assets, off-by-one easing, etc.
 *
 * Same return shape as the design-mode `render_preview` tool — just routed
 * through Remotion's renderer instead of the iframe screenshot pipeline.
 * Host injects the renderer; vitest / headless paths simply omit it and
 * the tool isn't registered.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { TextEditorFsCallbacks } from './text-editor.js';

const Params = Type.Object({
  /** The Remotion <Composition id="..."> value to render. */
  compositionId: Type.String(),
  /** Frame to render. 0-indexed. Defaults to 0. */
  frame: Type.Optional(Type.Integer({ minimum: 0 })),
});

export interface MotionRenderStillOutput {
  /** `data:image/png;base64,…` URL ready to embed in an `image` content block. */
  pngDataUrl: string;
  widthPx: number;
  heightPx: number;
}

export interface MotionRenderStillInput {
  compositionId: string;
  frame: number;
}

export type MotionRenderStillFn = (
  input: MotionRenderStillInput,
) => Promise<MotionRenderStillOutput>;

export interface RenderMotionPreviewDetails {
  compositionId: string;
  frame: number;
  widthPx: number;
  heightPx: number;
  byteLen: number;
}

export function makeRenderMotionPreviewTool(
  fs: TextEditorFsCallbacks,
  renderer: MotionRenderStillFn,
): AgentTool<typeof Params, RenderMotionPreviewDetails> {
  return {
    name: 'render_motion_preview',
    label: 'Render motion still',
    description:
      'Render a single still frame of a registered Remotion composition via @remotion/renderer.renderStill. ' +
      'Use this once or twice before `done` to spot-check the entry / mid / exit frames — catches timing off-by-ones, ' +
      'missing assets, and CSS scaling bugs that static analysis misses. Returns a PNG you can read directly. ' +
      'Cheap (~1–2 s on a warm bundle); no harm in calling it a few times.',
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<RenderMotionPreviewDetails>> {
      // Sanity-check that the composition's entry file exists in the fs.
      // The bundler will catch a deeper issue — this is just a friendly
      // hint so the model doesn't fire renderStill against a missing file.
      const root = fs.view('src/Root.tsx');
      if (root === null) {
        throw new Error(
          'render_motion_preview: src/Root.tsx not found. Author it via text_editor.create first.',
        );
      }
      const frame = params.frame ?? 0;
      const out = await renderer({ compositionId: params.compositionId, frame });
      const text = `Rendered ${params.compositionId} at frame ${frame} (${out.widthPx}×${out.heightPx}px, ${formatBytes(estimateBase64Bytes(out.pngDataUrl))}).`;
      const dataMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(out.pngDataUrl);
      const content: AgentToolResult<RenderMotionPreviewDetails>['content'] = [
        { type: 'text', text },
      ];
      if (dataMatch !== null) {
        content.push({
          type: 'image',
          mimeType: dataMatch[1] ?? 'image/png',
          data: dataMatch[2] ?? '',
        });
      }
      return {
        content,
        details: {
          compositionId: params.compositionId,
          frame,
          widthPx: out.widthPx,
          heightPx: out.heightPx,
          byteLen: estimateBase64Bytes(out.pngDataUrl),
        },
      };
    },
  };
}

function estimateBase64Bytes(dataUrl: string): number {
  const idx = dataUrl.indexOf(',');
  if (idx === -1) return 0;
  const b64 = dataUrl.slice(idx + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
