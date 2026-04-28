/**
 * `render_preview` — agent self-verification screenshot tool.
 *
 * The agent calls this near the end of a generation to confirm the
 * artifact actually fits the target viewport without overflow / clip /
 * dark-mode contrast issues. The host (Electron main) loads the
 * artifact in a hidden BrowserWindow at the chosen viewport, calls
 * `webContents.capturePage()`, and returns a PNG data URL.
 *
 * Core stays Electron-agnostic: the host injects a `RenderPreviewer`
 * function. When the host doesn't supply one (vitest, headless CI),
 * the tool isn't registered at all — the agent's tool catalog simply
 * lacks `render_preview`. See backlog-2 #5.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { TextEditorFsCallbacks } from './text-editor.js';

export type RenderPreviewViewport = 'iphone' | 'ipad' | 'desktop';

export interface RenderPreviewerInput {
  artifactSource: string;
  viewport: RenderPreviewViewport;
}

export interface RenderPreviewerOutput {
  /** `data:image/png;base64,…` URL ready to embed in an `image` content
   *  block. Caller owns no temp file. */
  pngDataUrl: string;
  widthPx: number;
  heightPx: number;
}

/** Host-injected screenshot function. Implementation lives in
 *  apps/desktop/src/main/render-preview.ts (Electron BrowserWindow). */
export type RenderPreviewer = (input: RenderPreviewerInput) => Promise<RenderPreviewerOutput>;

const RenderPreviewParams = Type.Object({
  /** Which preset viewport to capture. Defaults to `iphone` since that's
   *  the canonical use-case (mobile flow that has to fit 390×844). */
  viewport: Type.Optional(
    Type.Union([Type.Literal('iphone'), Type.Literal('ipad'), Type.Literal('desktop')]),
  ),
  /** Path of the artifact to render. Defaults to `index.html`. */
  path: Type.Optional(Type.String()),
});

export interface RenderPreviewDetails {
  viewport: RenderPreviewViewport;
  path: string;
  widthPx: number;
  heightPx: number;
  byteLen: number;
}

export function makeRenderPreviewTool(
  fs: TextEditorFsCallbacks,
  renderer: RenderPreviewer,
): AgentTool<typeof RenderPreviewParams, RenderPreviewDetails> {
  return {
    name: 'render_preview',
    label: 'Render preview screenshot',
    description:
      'Render the current artifact in a hidden BrowserWindow at a preset viewport (iphone / ipad / desktop) and return a PNG screenshot. ' +
      'Use this once before `done` on mobile artifacts to confirm the layout fits — overflow, clipping, and dark-mode contrast issues are ' +
      'easy to spot in the rendered screenshot. Tool result includes both a text summary and an image content block the model can read directly.',
    parameters: RenderPreviewParams,
    async execute(_id, params): Promise<AgentToolResult<RenderPreviewDetails>> {
      const viewport: RenderPreviewViewport = params.viewport ?? 'iphone';
      const path = params.path ?? 'index.html';
      const file = fs.view(path);
      if (file === null) {
        throw new Error(
          `render_preview: file "${path}" not found in the design fs. Use \`text_editor view\` to confirm the path or pass a different one.`,
        );
      }
      const out = await renderer({ artifactSource: file.content, viewport });
      const text = `Captured ${viewport} preview at ${out.widthPx}×${out.heightPx}px (${formatBytes(estimateBase64Bytes(out.pngDataUrl))}).`;
      // pi-ai's ImageContent shape: `{ type: 'image', data, mimeType }`
      // where `data` is raw base64 (no data: URL prefix). Strip the
      // header so we hand pi-ai the form it expects.
      const dataMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(out.pngDataUrl);
      const content: AgentToolResult<RenderPreviewDetails>['content'] = [{ type: 'text', text }];
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
          viewport,
          path,
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
  // Each 4 base64 chars carry 3 bytes; subtract 1-2 for trailing `=` padding.
  const b64 = dataUrl.slice(idx + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
