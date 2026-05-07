/**
 * motion-graphics-plan §3 / §4 — host-side wiring of the motion-mode
 * agent dependencies. The agent's tool factories are pure (live in
 * packages/core); the host supplies validator + still-renderer +
 * composition-registry callbacks here so the heavy `@remotion/bundler`
 * and `@remotion/renderer` imports stay lazy and only fire on motion
 * runs.
 */

import { writeFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { getLogger } from './logger';
import { bundleNow, scheduleBundle } from './motion-bundler';
import {
  insertMotionComposition,
  listMotionCompositions,
  upsertMotionComposition,
} from './motion-compositions-db';

const log = getLogger('motion-runtime');

export interface MotionValidationIssue {
  path: string;
  line?: number;
  message: string;
  severity: 'error' | 'warn';
}

export interface MotionValidationResult {
  ok: boolean;
  /** Bundle errors (if any) appear here as a single 'error' issue. */
  issues: MotionValidationIssue[];
}

export interface MotionRenderStillResult {
  pngDataUrl: string;
  widthPx: number;
  heightPx: number;
}

export interface MotionRenderStillInput {
  /** Composition id registered in src/Root.tsx. */
  compositionId: string;
  /** Frame number to render. 0-indexed. */
  frame: number;
}

export interface MotionCompositionRow {
  id: string;
  designId: string;
  compositionId: string;
  name: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  entryFile: string;
  createdAt: number;
  updatedAt: number;
}

export interface MotionCompositionRegistry {
  list(): MotionCompositionRow[];
  /** Insert or replace a composition row keyed on (designId, compositionId). */
  upsert(input: Omit<MotionCompositionRow, 'id' | 'createdAt' | 'updatedAt'>): MotionCompositionRow;
}

export interface MotionRuntime {
  validate: (
    files: ReadonlyArray<{ path: string; content: string }>,
  ) => Promise<MotionValidationResult>;
  renderStill?: ((input: MotionRenderStillInput) => Promise<MotionRenderStillResult>) | undefined;
  compositionRegistry?: MotionCompositionRegistry | undefined;
}

/** Construct the per-run runtime callbacks. The bundler is the ground
 *  truth for validation; the static regex pre-filter happens inside
 *  packages/core's `validate_motion_composition` tool, before we're called.
 *
 *  When `designId` is null (vitest, headless), we return a runtime that
 *  still answers `validate()` with a "no design wired" warning — the
 *  agent then surfaces that to the model and proceeds. */
export function buildMotionModeRuntime(
  designId: string | null,
  db: Database.Database | null = null,
): MotionRuntime {
  return {
    async validate() {
      if (designId === null) {
        return {
          ok: true,
          issues: [
            {
              path: '',
              message:
                'No design id wired into this run; bundle validation skipped (headless test path).',
              severity: 'warn' as const,
            },
          ],
        };
      }
      const result = await bundleNow(designId);
      if (result.ok) {
        return { ok: true, issues: [] };
      }
      return {
        ok: false,
        issues: [
          {
            path: result.entryPoint || 'src/Root.tsx',
            message: result.errorText ?? 'Bundle failed (no error text from bundler).',
            severity: 'error' as const,
          },
        ],
      };
    },
    renderStill:
      designId === null
        ? undefined
        : async (input) => {
            const bundle = await bundleNow(designId);
            if (!bundle.ok) {
              throw new Error(
                `render_motion_preview: bundle failed before render. ${bundle.errorText ?? ''}`,
              );
            }
            interface RemotionRenderer {
              selectComposition: (input: {
                serveUrl: string;
                id: string;
                inputProps: Record<string, unknown>;
              }) => Promise<{
                id: string;
                width: number;
                height: number;
                durationInFrames: number;
                fps: number;
              }>;
              renderStill: (input: {
                composition: {
                  id: string;
                  width: number;
                  height: number;
                  durationInFrames: number;
                  fps: number;
                };
                serveUrl: string;
                frame: number;
                inputProps: Record<string, unknown>;
                imageFormat: 'png' | 'jpeg';
                output?: string | undefined;
              }) => Promise<Buffer | { buffer: Buffer } | undefined>;
            }
            let renderer: RemotionRenderer;
            try {
              renderer = (await import('@remotion/renderer')) as unknown as RemotionRenderer;
            } catch (err) {
              throw new Error(
                `render_motion_preview: @remotion/renderer is not installed. ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
            const composition = await renderer.selectComposition({
              serveUrl: bundle.bundleDir,
              id: input.compositionId,
              inputProps: {},
            });
            const png = await renderer.renderStill({
              composition,
              serveUrl: bundle.bundleDir,
              frame: input.frame,
              inputProps: {},
              imageFormat: 'png',
              output: undefined,
            });
            const data = Buffer.isBuffer(png) ? png : (png?.buffer ?? Buffer.alloc(0));
            const widthPx = composition.width;
            const heightPx = composition.height;
            const dataUrl = `data:image/png;base64,${Buffer.from(data).toString('base64')}`;
            return { pngDataUrl: dataUrl, widthPx, heightPx };
          },
    ...(designId !== null && db !== null
      ? {
          compositionRegistry: {
            list: () => listMotionCompositions(db, designId),
            upsert: (input) => {
              const row = upsertMotionComposition(db, { ...input, designId });
              // Notify the renderer so the Compositions tab refreshes
              // without polling. Best-effort — when no main window is
              // open (headless), we silently drop the event.
              notifyCompositionRegistered(designId);
              return row;
            },
          } satisfies MotionCompositionRegistry,
        }
      : {}),
  };
}

let _compositionEventSink: ((designId: string) => void) | null = null;

/** Wire the renderer-event sink. Called from `apps/desktop/src/main/index.ts`
 *  once the main window exists; the sink turns into a `motion:event:v1`
 *  postMessage of type `motion:composition-registered` so the renderer
 *  can re-fetch the list. */
export function setMotionCompositionEventSink(sink: (designId: string) => void): void {
  _compositionEventSink = sink;
}

function notifyCompositionRegistered(designId: string): void {
  _compositionEventSink?.(designId);
}

/** Hook invoked from the IPC text_editor write path so saves trigger an
 *  incremental bundle. Cheap when the path is outside `src/`. */
export function notifyMotionFileWrite(designId: string, relPath: string): void {
  if (!relPath.startsWith('src/')) return;
  scheduleBundle(designId);
  log.info('write.scheduled', { designId, path: relPath });
}

/** Best-effort initial save of the agent's text_editor virtual fs to disk
 *  so the bundler can read source files. Apps wire an explicit fs adapter
 *  too — this is only the "main has a path, write through" helper used
 *  during development.
 */
export async function writeMotionFile(absPath: string, content: string): Promise<void> {
  await writeFile(absPath, content, 'utf8');
  void insertMotionComposition; // tree-shake guard
}
