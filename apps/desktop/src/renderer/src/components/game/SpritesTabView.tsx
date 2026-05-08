import type { GameArtifact } from '@open-codesign/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCodesignStore } from '../../store';

const ROLE_LABELS: Record<string, string> = {
  texture: 'Texture',
  spritesheet: 'Spritesheet',
  atlas: 'Atlas',
  model: 'Model',
  source: 'Source',
  thumbnail: 'Thumbnail',
};

function readFileAsBase64Sentinel(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('reader did not return string'));
        return;
      }
      // Convert ArrayBuffer-as-data-URL to our base64 sentinel.
      const idx = result.indexOf(',');
      if (idx < 0) {
        reject(new Error('result missing comma'));
        return;
      }
      resolve(`data:base64,${result.slice(idx + 1)}`);
    };
    reader.readAsDataURL(file);
  });
}

function isTextLike(name: string): boolean {
  return /\.(json|txt|gltf)$/i.test(name);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const r = reader.result;
      if (typeof r !== 'string') {
        reject(new Error('reader did not return string'));
        return;
      }
      resolve(r);
    };
    reader.readAsText(file);
  });
}

export function SpritesTabView() {
  const designId = useCodesignStore((s) => s.currentDesignId);
  // Select the stable raw array, derive the filtered subset via
  // useMemo. Inline `.filter()` inside a zustand selector returns a
  // new reference per call → re-render → infinite loop.
  const allArtifacts = useCodesignStore((s) =>
    designId !== null ? (s.gameArtifactsByDesign[designId] ?? null) : null,
  );
  const artifacts = useMemo(
    () => (allArtifacts ?? []).filter((a) => a.kind === 'sprite'),
    [allArtifacts],
  );
  const selectedSpriteId = useCodesignStore((s) =>
    designId !== null ? (s.selectedSpriteIdByDesign[designId] ?? null) : null,
  );
  const selectSprite = useCodesignStore((s) => s.selectSprite);
  const archive = useCodesignStore((s) => s.archiveGameArtifact);
  const importSpriteFiles = useCodesignStore((s) => s.importSpriteFiles);
  const appendArtifactRef = useCodesignStore((s) => s.appendArtifactRefToPrompt);
  const setPromptDraft = useCodesignStore((s) => s.setPromptDraft);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  const selected = useMemo(
    () => artifacts.find((a) => a.id === selectedSpriteId) ?? null,
    [artifacts, selectedSpriteId],
  );

  const onPickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const onFilesPicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      setImporting(true);
      try {
        const payload: Array<{ relativePath: string; content: string }> = [];
        for (const f of Array.from(files)) {
          const content = isTextLike(f.name)
            ? await readFileAsText(f)
            : await readFileAsBase64Sentinel(f);
          payload.push({ relativePath: f.name, content });
        }
        const inferredName =
          files.length === 1 && files[0] ? files[0].name.replace(/\.[^.]+$/, '') : undefined;
        await importSpriteFiles(payload, inferredName);
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [importSpriteFiles],
  );

  if (designId === null) return null;

  return (
    <div className="flex h-full min-h-0 flex-1 bg-[var(--color-background)]">
      <div className="flex w-[280px] flex-col border-r border-[var(--color-border-muted)]">
        <div className="flex items-center justify-between p-[var(--space-3)]">
          <h3 className="text-[13px] font-medium text-[var(--color-text-primary)]">Sprites</h3>
          <button
            type="button"
            onClick={onPickFiles}
            disabled={importing}
            className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-[var(--space-2)] py-[2px] text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]"
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/webp,image/jpeg,model/gltf-binary,application/octet-stream,.png,.webp,.jpg,.jpeg,.glb,.gltf,.json"
            onChange={onFilesPicked}
            className="hidden"
          />
        </div>
        {artifacts.length === 0 ? (
          <SpriteEmptyState
            onImport={onPickFiles}
            onSeedExtractionPrompt={() => {
              setPromptDraft(SPRITE_EXTRACTION_BRIEF);
            }}
          />
        ) : (
          <ul className="flex-1 overflow-y-auto px-[var(--space-2)] pb-[var(--space-2)]">
            {artifacts.map((sprite) => (
              <SpriteRow
                key={sprite.id}
                sprite={sprite}
                active={sprite.id === selectedSpriteId}
                onSelect={() => selectSprite(sprite.id)}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-1 flex-col p-[var(--space-3)]">
        {selected ? (
          <SpriteDetail
            sprite={selected}
            onArchive={() => archive(selected.id)}
            onCopyAlias={() => appendArtifactRef(selected.id)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">
            Select a sprite to inspect it.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pre-filled brief that the "Extract from existing artwork" empty-state
 * button drops into the prompt draft. Tight scoping is intentional —
 * historically the agent has rewritten the whole game when given any
 * weapon/HUD-shaped prompt (see .claude/workspace/2026-05-08-pause-prune-
 * continuation-fix.md). The brief explicitly names the slugs, points at
 * canonical paths the indexer recognises (assets/sprites/<slug>/sprite.svg),
 * and forbids touching unrelated game logic.
 */
const SPRITE_EXTRACTION_BRIEF = [
  'Decompose the inline weapon / character viewmodels in `index.html` into',
  'sprite files so the Sprites tab can index them.',
  '',
  'For each major `<svg>` block representing a discrete asset, extract the markup',
  'into a new file at `assets/sprites/<slug>/sprite.svg` (slug = stable kebab-case',
  'name, e.g. `m4a1`, `desert-eagle`, `knife`, `enemy-grunt`).',
  '',
  'Hard rules:',
  '- DO NOT rewrite unrelated parts of `index.html`. Make targeted edits only.',
  '- Keep the in-game render working — either reference the sprite via `<img>` /',
  '  fetch + inline, or duplicate the markup. Visual parity is mandatory.',
  '- After each extraction call `verify_artifact` and `render_preview` to confirm',
  '  the game still loads. If a render shows the scene gone, revert that edit.',
  '- Do NOT change game logic, weapon switching, melee combos, or animations.',
  '- After all extractions, call `done`.',
].join('\n');

function SpriteEmptyState({
  onImport,
  onSeedExtractionPrompt,
}: {
  onImport: () => void;
  onSeedExtractionPrompt: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[var(--space-2)] p-[var(--space-3)] text-center text-[12px] text-[var(--color-text-muted)]">
      <p>No sprites yet.</p>
      <p className="text-[11px]">
        Import an image / GLB / atlas, or extract sprites from this design's existing inline
        artwork.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-[var(--space-2)]">
        <button
          type="button"
          onClick={onImport}
          className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-[var(--space-3)] py-[var(--space-1)] text-[12px] text-white hover:opacity-90"
        >
          Import sprite files
        </button>
        <button
          type="button"
          onClick={onSeedExtractionPrompt}
          title="Seed the prompt with a pre-flighted brief that asks the agent to extract inline SVG / canvas art into assets/sprites/<slug>/ without rewriting the game"
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-3)] py-[var(--space-1)] text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          Extract from existing artwork
        </button>
      </div>
    </div>
  );
}

function SpriteRow({
  sprite,
  active,
  onSelect,
}: {
  sprite: GameArtifact;
  active: boolean;
  onSelect: () => void;
}) {
  const meta = sprite.metadata.kind === 'sprite' ? sprite.metadata : null;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        data-testid={`sprite-row-${sprite.id}`}
        className={`my-[2px] w-full rounded-[var(--radius-sm)] p-[var(--space-2)] text-left ${
          active
            ? 'bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]'
            : 'hover:bg-[var(--color-surface-elevated)]'
        }`}
      >
        <div className="flex items-center gap-[var(--space-2)]">
          <SpriteThumbnail sprite={sprite} />
          <div className="flex flex-1 flex-col gap-[2px] overflow-hidden">
            <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">
              {sprite.name}
            </span>
            <span className="truncate text-[10px] text-[var(--color-text-muted)]">
              {meta?.visualType ?? 'sprite'} · {sprite.promptAlias}
            </span>
          </div>
          {sprite.provenance.source === 'user-import' ? (
            <span className="rounded-full bg-[var(--color-surface-elevated)] px-[6px] py-[1px] text-[9px] uppercase text-[var(--color-text-muted)]">
              Import
            </span>
          ) : null}
        </div>
      </button>
    </li>
  );
}

function SpriteThumbnail({ sprite }: { sprite: GameArtifact }) {
  const designId = useCodesignStore((s) => s.currentDesignId);
  const path =
    sprite.thumbnailPath ??
    sprite.files.find((f) => f.role === 'texture' || f.role === 'thumbnail')?.path ??
    null;
  if (path === null || designId === null) {
    return (
      <div className="h-8 w-8 shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)]" />
    );
  }
  return (
    <img
      src={`game-files://designs/${designId}/${path}`}
      alt=""
      className="h-8 w-8 shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] object-contain"
    />
  );
}

function SpriteDetail({
  sprite,
  onArchive,
  onCopyAlias,
}: {
  sprite: GameArtifact;
  onArchive: () => void;
  onCopyAlias: () => void;
}) {
  const meta = sprite.metadata.kind === 'sprite' ? sprite.metadata : null;
  const bindings = useCodesignStore((s) =>
    sprite.designId in s.gameAnimationBindingsByDesign
      ? (s.gameAnimationBindingsByDesign[sprite.designId] ?? [])
      : [],
  );
  const animations = useCodesignStore((s) =>
    (s.gameArtifactsByDesign[sprite.designId] ?? []).filter((a) => a.kind === 'animation'),
  );
  const compatibleAnimations = animations.filter((anim) =>
    bindings.some((b) => b.animationId === anim.id && b.spriteId === sprite.id),
  );

  return (
    <div className="flex flex-col gap-[var(--space-3)] text-[12px]">
      <div className="flex items-start justify-between gap-[var(--space-2)]">
        <div>
          <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
            {sprite.name}
          </h2>
          <code className="text-[11px] text-[var(--color-text-muted)]">{sprite.promptAlias}</code>
        </div>
        <div className="flex gap-[var(--space-2)]">
          <button
            type="button"
            onClick={onCopyAlias}
            className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-[var(--space-2)] py-[2px] text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]"
          >
            Use in prompt
          </button>
          <button
            type="button"
            onClick={onArchive}
            className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-[var(--space-2)] py-[2px] text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]"
          >
            Archive
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-[120px_1fr] gap-x-[var(--space-3)] gap-y-[var(--space-1)] text-[11px]">
        <dt className="text-[var(--color-text-muted)]">Visual type</dt>
        <dd className="text-[var(--color-text-primary)]">{meta?.visualType ?? '—'}</dd>
        <dt className="text-[var(--color-text-muted)]">Frames</dt>
        <dd className="text-[var(--color-text-primary)]">{meta?.frameCount ?? 1}</dd>
        {meta?.dimensions ? (
          <>
            <dt className="text-[var(--color-text-muted)]">Dimensions</dt>
            <dd className="text-[var(--color-text-primary)]">
              {meta.dimensions.width}×{meta.dimensions.height}
              {meta.dimensions.depth !== undefined ? `×${meta.dimensions.depth}` : ''}
            </dd>
          </>
        ) : null}
        <dt className="text-[var(--color-text-muted)]">Provenance</dt>
        <dd className="text-[var(--color-text-primary)]">{sprite.provenance.source}</dd>
        <dt className="text-[var(--color-text-muted)]">Updated</dt>
        <dd className="text-[var(--color-text-primary)]">{sprite.updatedAt}</dd>
      </dl>
      <section>
        <h3 className="mb-[var(--space-1)] text-[11px] font-medium uppercase text-[var(--color-text-muted)]">
          Files
        </h3>
        <ul className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)]">
          {sprite.files.length === 0 ? (
            <li className="px-[var(--space-2)] py-[var(--space-1)] text-[11px] text-[var(--color-text-muted)]">
              No linked files yet.
            </li>
          ) : (
            sprite.files.map((file) => (
              <li
                key={file.id}
                className="flex items-center justify-between border-b border-[var(--color-border-muted)] px-[var(--space-2)] py-[var(--space-1)] last:border-b-0"
              >
                <code className="truncate text-[11px] text-[var(--color-text-primary)]">
                  {file.path}
                </code>
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {ROLE_LABELS[file.role] ?? file.role}
                </span>
              </li>
            ))
          )}
        </ul>
      </section>
      <section>
        <h3 className="mb-[var(--space-1)] text-[11px] font-medium uppercase text-[var(--color-text-muted)]">
          Compatible animations
        </h3>
        {compatibleAnimations.length === 0 ? (
          <p className="text-[11px] text-[var(--color-text-muted)]">
            No animations bound yet. Open the Animations tab to create one.
          </p>
        ) : (
          <ul className="text-[11px]">
            {compatibleAnimations.map((anim) => (
              <li
                key={anim.id}
                className="flex items-center justify-between rounded-[var(--radius-sm)] px-[var(--space-2)] py-[var(--space-1)] hover:bg-[var(--color-surface-elevated)]"
              >
                <span className="text-[var(--color-text-primary)]">{anim.name}</span>
                <span className="flex items-center gap-[var(--space-1)]">
                  <code className="text-[10px] text-[var(--color-text-muted)]">
                    {anim.promptAlias}
                  </code>
                  <PreviewWithAnimationButton spriteId={sprite.id} animationId={anim.id} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PreviewWithAnimationButton({
  spriteId,
  animationId,
}: {
  spriteId: string;
  animationId: string;
}) {
  const selectAnimation = useCodesignStore((s) => s.selectAnimation);
  return (
    <button
      type="button"
      onClick={() => selectAnimation(animationId, spriteId)}
      className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] px-[var(--space-2)] py-[1px] text-[10px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]"
    >
      Preview
    </button>
  );
}
