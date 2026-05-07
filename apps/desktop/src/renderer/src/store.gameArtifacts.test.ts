/**
 * Renderer-side reducers for the game-artifacts slice (Phase 2). The store
 * actions don't depend on window.codesign for selection / preview-mode
 * transitions — the IPC-backed actions (load/import/bind) are exercised
 * indirectly via state mutations here.
 */

import type {
  AnimationArtifactMetadata,
  GameAnimationBinding,
  GameArtifact,
  SpriteArtifactMetadata,
} from '@open-codesign/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCodesignStore } from './store';

const initial = useCodesignStore.getState();

const SPRITE_META: SpriteArtifactMetadata = {
  version: 1,
  kind: 'sprite',
  visualType: '2d-sprite',
  tags: [],
  frameCount: 1,
};
const ANIM_META: AnimationArtifactMetadata = {
  version: 1,
  kind: 'animation',
  animationType: 'frame-sequence',
  durationMs: 800,
  loop: true,
  tags: [],
  requiredTags: [],
  channels: [],
};

function makeSprite(designId: string, id: string, name: string): GameArtifact {
  return {
    schemaVersion: 1,
    id,
    designId,
    kind: 'sprite',
    name,
    slug: name.toLowerCase(),
    promptAlias: `@sprite:${name.toLowerCase()}`,
    status: 'ready',
    engine: null,
    primaryFilePath: null,
    previewFilePath: null,
    thumbnailPath: null,
    metadata: SPRITE_META,
    provenance: { source: 'agent' },
    files: [],
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function makeAnim(designId: string, id: string, name: string): GameArtifact {
  return {
    schemaVersion: 1,
    id,
    designId,
    kind: 'animation',
    name,
    slug: name.toLowerCase(),
    promptAlias: `@animation:${name.toLowerCase()}`,
    status: 'ready',
    engine: null,
    primaryFilePath: null,
    previewFilePath: null,
    thumbnailPath: null,
    metadata: ANIM_META,
    provenance: { source: 'agent' },
    files: [],
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

const DESIGN_A = 'design-a';
const DESIGN_B = 'design-b';

beforeEach(() => {
  useCodesignStore.setState({
    ...initial,
    currentDesignId: DESIGN_A,
    gameArtifactsByDesign: {
      [DESIGN_A]: [
        makeSprite(DESIGN_A, 's-knight', 'Knight'),
        makeSprite(DESIGN_A, 's-mage', 'Mage'),
        makeAnim(DESIGN_A, 'a-walk', 'Walk'),
      ],
      [DESIGN_B]: [makeSprite(DESIGN_B, 's-other', 'Other')],
    },
    gameAnimationBindingsByDesign: {
      [DESIGN_A]: [
        {
          id: 'b-1',
          designId: DESIGN_A,
          animationId: 'a-walk',
          spriteId: 's-knight',
          bindingStatus: 'compatible',
          retarget: {},
          createdAt: '2026-05-06T00:00:00.000Z',
          updatedAt: '2026-05-06T00:00:00.000Z',
        } satisfies GameAnimationBinding,
      ],
      [DESIGN_B]: [],
    },
    gameArtifactsLoadedByDesign: { [DESIGN_A]: true, [DESIGN_B]: true },
    selectedSpriteIdByDesign: {},
    selectedAnimationIdByDesign: {},
    animationTargetSpriteIdByDesign: {},
    gamePreviewModeByDesign: { [DESIGN_A]: { mode: 'game' } },
    activeProjectTab: 'preview',
    promptDraft: '',
  });
});

describe('selectSprite', () => {
  it('sets the selected sprite, flips preview mode, and switches the tab', () => {
    useCodesignStore.getState().selectSprite('s-knight');
    const state = useCodesignStore.getState();
    expect(state.selectedSpriteIdByDesign[DESIGN_A]).toBe('s-knight');
    expect(state.activeProjectTab).toBe('sprites');
    expect(state.gamePreviewModeByDesign[DESIGN_A]).toEqual({
      mode: 'sprite',
      spriteId: 's-knight',
    });
  });

  it('seeds the animation target sprite when none was set', () => {
    useCodesignStore.getState().selectSprite('s-knight');
    expect(useCodesignStore.getState().animationTargetSpriteIdByDesign[DESIGN_A]).toBe('s-knight');
  });

  it('does not overwrite an existing animation target on resélection', () => {
    useCodesignStore.setState({
      animationTargetSpriteIdByDesign: { [DESIGN_A]: 's-mage' },
    });
    useCodesignStore.getState().selectSprite('s-knight');
    expect(useCodesignStore.getState().animationTargetSpriteIdByDesign[DESIGN_A]).toBe('s-mage');
  });
});

describe('selectAnimation', () => {
  it('requires a target sprite — falls back to the selected sprite when one exists', () => {
    useCodesignStore.setState({
      selectedSpriteIdByDesign: { [DESIGN_A]: 's-knight' },
    });
    useCodesignStore.getState().selectAnimation('a-walk');
    const state = useCodesignStore.getState();
    expect(state.selectedAnimationIdByDesign[DESIGN_A]).toBe('a-walk');
    expect(state.animationTargetSpriteIdByDesign[DESIGN_A]).toBe('s-knight');
    expect(state.gamePreviewModeByDesign[DESIGN_A]).toEqual({
      mode: 'animation',
      animationId: 'a-walk',
      spriteId: 's-knight',
    });
  });

  it('switches preview mode back to game when the animation is cleared', () => {
    useCodesignStore.setState({
      selectedSpriteIdByDesign: { [DESIGN_A]: 's-knight' },
      animationTargetSpriteIdByDesign: { [DESIGN_A]: 's-knight' },
    });
    useCodesignStore.getState().selectAnimation('a-walk');
    useCodesignStore.getState().selectAnimation(null);
    expect(useCodesignStore.getState().gamePreviewModeByDesign[DESIGN_A]).toEqual({
      mode: 'game',
    });
  });
});

describe('selectProjectTab', () => {
  it('flips preview mode when switching to sprites with a selection', () => {
    useCodesignStore.setState({
      selectedSpriteIdByDesign: { [DESIGN_A]: 's-knight' },
    });
    useCodesignStore.getState().selectProjectTab('sprites');
    expect(useCodesignStore.getState().gamePreviewModeByDesign[DESIGN_A]).toEqual({
      mode: 'sprite',
      spriteId: 's-knight',
    });
  });

  it('returns to game preview when switching to preview tab', () => {
    useCodesignStore.setState({
      gamePreviewModeByDesign: {
        [DESIGN_A]: { mode: 'sprite', spriteId: 's-knight' },
      },
    });
    useCodesignStore.getState().selectProjectTab('preview');
    expect(useCodesignStore.getState().gamePreviewModeByDesign[DESIGN_A]).toEqual({
      mode: 'game',
    });
  });
});

describe('appendArtifactRefToPrompt', () => {
  it('appends the alias to the prompt draft', () => {
    useCodesignStore.getState().appendArtifactRefToPrompt('s-knight');
    expect(useCodesignStore.getState().promptDraft).toBe('@sprite:knight ');
  });
});

describe('archiveGameArtifact', () => {
  it('clears selected sprite when the archived artifact was selected', async () => {
    const calls: Array<{ id: string }> = [];
    const g = globalThis as unknown as { window?: { codesign?: unknown } | undefined };
    const prev = g.window;
    g.window = {
      codesign: {
        gameArtifacts: {
          archive: async (designId: string, artifactId: string) => {
            calls.push({ id: artifactId });
            return { designId, artifacts: [], bindings: [] };
          },
        },
      },
    };
    try {
      useCodesignStore.setState({
        selectedSpriteIdByDesign: { [DESIGN_A]: 's-knight' },
        animationTargetSpriteIdByDesign: { [DESIGN_A]: 's-knight' },
      });
      await useCodesignStore.getState().archiveGameArtifact('s-knight');
      expect(calls).toHaveLength(1);
      expect(useCodesignStore.getState().selectedSpriteIdByDesign[DESIGN_A]).toBeNull();
      expect(useCodesignStore.getState().animationTargetSpriteIdByDesign[DESIGN_A]).toBeNull();
    } finally {
      g.window = prev;
    }
  });
});

describe('animation creation gating', () => {
  it('importAnimationFiles is a no-op when called without files', async () => {
    const g = globalThis as unknown as { window?: { codesign?: unknown } | undefined };
    const prev = g.window;
    g.window = { codesign: { gameArtifacts: {} } };
    try {
      const result = await useCodesignStore.getState().importAnimationFiles([], 's-knight');
      expect(result).toBeNull();
    } finally {
      g.window = prev;
    }
  });
});
