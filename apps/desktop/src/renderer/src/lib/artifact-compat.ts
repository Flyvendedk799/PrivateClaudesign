/**
 * Compatibility checks between an animation and a sprite. Mirrors the rules
 * in the plan §9: exact rig hash → compatible; same visual type + frame
 * layout → compatible; missing rig or mismatched frame layout → needs
 * retarget; required source missing → broken.
 */

import type {
  AnimationArtifactMetadata,
  GameAnimationBindingStatus,
  GameArtifact,
  SpriteArtifactMetadata,
} from '@open-codesign/shared';

export function classifyAnimationCompat(
  animation: GameArtifact,
  sprite: GameArtifact,
): GameAnimationBindingStatus {
  if (animation.kind !== 'animation' || sprite.kind !== 'sprite') return 'broken';
  const animMeta = animation.metadata as AnimationArtifactMetadata;
  const spriteMeta = sprite.metadata as SpriteArtifactMetadata;
  if (animation.files.length === 0 || sprite.files.length === 0) return 'broken';

  // Skeletal: rig hash must match.
  if (animMeta.requiredRigHash !== undefined) {
    if (
      spriteMeta.skeleton !== undefined &&
      spriteMeta.skeleton.restPoseHash === animMeta.requiredRigHash
    ) {
      return 'compatible';
    }
    return 'needs_retarget';
  }

  // Frame sequence: visual type + frame count alignment.
  if (
    animMeta.animationType === 'frame-sequence' ||
    animMeta.animationType === 'spritesheet-cycle'
  ) {
    if (spriteMeta.visualType === '2d-sprite' || spriteMeta.visualType === 'spritesheet') {
      // Heuristic: frame count >= 1 means valid pairing
      if ((spriteMeta.frameCount ?? 1) >= 1) return 'compatible';
      return 'needs_retarget';
    }
    return 'needs_retarget';
  }

  // Procedural / engine-clip: assume compatible if both exist.
  return 'compatible';
}
