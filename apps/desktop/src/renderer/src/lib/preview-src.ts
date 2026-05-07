/**
 * Pure URL builders for the preview iframe. Extracted from PreviewPane.tsx
 * so they can be imported by main-process / vitest paths that don't have
 * JSX enabled.
 *
 *  - `resolveGameSrc`        — picks the iframe src for full game preview.
 *  - `resolveGamePreviewSrc` — picks the iframe src for sprite/animation
 *                              inspect modes (game-artifacts §3).
 */

import type { GamePreviewMode } from '@open-codesign/shared';

export function resolveGameSrc(
  designId: string,
  engine: 'three' | 'phaser' | 'pygame' | 'godot' | null,
  godotPreviewByDesign: Record<string, 'project' | 'build'>,
): string | undefined {
  if (engine === 'three' || engine === 'phaser' || engine === 'pygame') {
    return `game-files://designs/${designId}/index.html`;
  }
  if (engine === 'godot' && godotPreviewByDesign[designId] === 'build') {
    return `game-files://designs/${designId}/_build/index.html`;
  }
  return undefined;
}

export function resolveGamePreviewSrc(args: {
  designId: string;
  engine: 'three' | 'phaser' | 'pygame' | 'godot' | null;
  previewMode: GamePreviewMode;
  godotPreviewByDesign: Record<string, 'project' | 'build'>;
}): string | undefined {
  const { designId, engine, previewMode, godotPreviewByDesign } = args;
  if (previewMode.mode === 'sprite') {
    const params = new URLSearchParams({ artifactId: previewMode.spriteId });
    return `game-files://designs/${designId}/__preview/sprite.html?${params.toString()}`;
  }
  if (previewMode.mode === 'animation') {
    const params = new URLSearchParams({
      artifactId: previewMode.animationId,
      spriteId: previewMode.spriteId,
    });
    return `game-files://designs/${designId}/__preview/animation.html?${params.toString()}`;
  }
  return resolveGameSrc(designId, engine, godotPreviewByDesign);
}

/** Pick the iframe src for a multi-file design-mode artifact. Returns a
 *  `design-files://` URL with a cache-busting query string. */
export function resolveDesignFilesSrc(
  designId: string,
  multiFile: boolean,
  reloadTick: number,
): string | undefined {
  if (!multiFile) return undefined;
  return `design-files://designs/${designId}/index.html?v=${reloadTick}`;
}
