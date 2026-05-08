import type { GameArtifact } from '@open-codesign/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCodesignStore } from '../../store';

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

function readFileAsBase64Sentinel(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const r = reader.result;
      if (typeof r !== 'string') {
        reject(new Error('reader did not return string'));
        return;
      }
      const idx = r.indexOf(',');
      resolve(idx < 0 ? r : `data:base64,${r.slice(idx + 1)}`);
    };
    reader.readAsDataURL(file);
  });
}

function isTextLike(name: string): boolean {
  return /\.(json|txt|gltf)$/i.test(name);
}

export function AnimationsTabView() {
  const designId = useCodesignStore((s) => s.currentDesignId);
  // Same selector-stability fix as GameProjectTabs / SpritesTabView —
  // select the raw arrays once, filter via useMemo so we don't return
  // a fresh reference on every render and trip zustand's loop guard.
  const allArtifacts = useCodesignStore((s) =>
    designId !== null ? (s.gameArtifactsByDesign[designId] ?? null) : null,
  );
  const sprites = useMemo(
    () => (allArtifacts ?? []).filter((a) => a.kind === 'sprite'),
    [allArtifacts],
  );
  const animations = useMemo(
    () => (allArtifacts ?? []).filter((a) => a.kind === 'animation'),
    [allArtifacts],
  );
  const rawBindings = useCodesignStore((s) =>
    designId !== null ? (s.gameAnimationBindingsByDesign[designId] ?? null) : null,
  );
  const bindings = useMemo(() => rawBindings ?? [], [rawBindings]);
  const targetSpriteId = useCodesignStore((s) =>
    designId !== null ? (s.animationTargetSpriteIdByDesign[designId] ?? null) : null,
  );
  const selectedAnimationId = useCodesignStore((s) =>
    designId !== null ? (s.selectedAnimationIdByDesign[designId] ?? null) : null,
  );
  const setAnimationTargetSprite = useCodesignStore((s) => s.setAnimationTargetSprite);
  const selectAnimation = useCodesignStore((s) => s.selectAnimation);
  const archive = useCodesignStore((s) => s.archiveGameArtifact);
  const importAnimationFiles = useCodesignStore((s) => s.importAnimationFiles);
  const bindAnimation = useCodesignStore((s) => s.bindAnimationToSprite);
  const unbindAnimation = useCodesignStore((s) => s.unbindAnimationFromSprite);
  const appendArtifactRef = useCodesignStore((s) => s.appendArtifactRefToPrompt);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const visibleAnimations = useMemo(() => {
    if (showAll || targetSpriteId === null) return animations;
    return animations.filter((anim) =>
      bindings.some((b) => b.animationId === anim.id && b.spriteId === targetSpriteId),
    );
  }, [animations, bindings, showAll, targetSpriteId]);

  const onPickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const onFilesPicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0 || targetSpriteId === null) return;
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
        await importAnimationFiles(payload, targetSpriteId, inferredName);
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [importAnimationFiles, targetSpriteId],
  );

  if (designId === null) return null;

  const targetSprite = sprites.find((s) => s.id === targetSpriteId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 bg-[var(--color-background)]">
      <div className="flex w-[300px] flex-col border-r border-[var(--color-border-muted)]">
        <div className="space-y-[var(--space-2)] p-[var(--space-3)]">
          <h3 className="text-[13px] font-medium text-[var(--color-text-primary)]">Animations</h3>
          <label className="flex flex-col gap-[var(--space-1)] text-[11px]">
            <span className="text-[var(--color-text-muted)]">Target sprite</span>
            <select
              value={targetSpriteId ?? ''}
              onChange={(e) => setAnimationTargetSprite(e.target.value || null)}
              className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] bg-[var(--color-background-secondary)] px-[var(--space-2)] py-[var(--space-1)] text-[12px] text-[var(--color-text-primary)]"
            >
              <option value="">Pick a sprite…</option>
              {sprites.map((sprite) => (
                <option key={sprite.id} value={sprite.id}>
                  {sprite.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center justify-between gap-[var(--space-2)]">
            <button
              type="button"
              onClick={onPickFiles}
              disabled={targetSpriteId === null || importing}
              className="rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)] px-[var(--space-2)] py-[2px] text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? 'Importing…' : 'Import animation'}
            </button>
            <label className="flex items-center gap-[var(--space-1)] text-[11px] text-[var(--color-text-muted)]">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              Show all
            </label>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".json,.glb,.gltf,.png,.webp,application/json,model/gltf-binary"
            onChange={onFilesPicked}
            className="hidden"
          />
        </div>
        {visibleAnimations.length === 0 ? (
          <AnimationsEmptyState hasTarget={targetSpriteId !== null} onImport={onPickFiles} />
        ) : (
          <ul className="flex-1 overflow-y-auto px-[var(--space-2)] pb-[var(--space-2)]">
            {visibleAnimations.map((anim) => (
              <AnimationRow
                key={anim.id}
                animation={anim}
                bindings={bindings.filter((b) => b.animationId === anim.id)}
                active={anim.id === selectedAnimationId}
                onSelect={() => selectAnimation(anim.id, targetSpriteId ?? undefined)}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-1 flex-col p-[var(--space-3)]">
        {selectedAnimationId !== null ? (
          (() => {
            const anim = animations.find((a) => a.id === selectedAnimationId);
            if (!anim) return null;
            return (
              <AnimationDetail
                animation={anim}
                sprites={sprites}
                bindings={bindings.filter((b) => b.animationId === anim.id)}
                targetSpriteId={targetSpriteId}
                onArchive={() => archive(anim.id)}
                onCopyAlias={() => appendArtifactRef(anim.id)}
                onBind={(spriteId) => bindAnimation(anim.id, spriteId)}
                onUnbind={(spriteId) => unbindAnimation(anim.id, spriteId)}
                targetSprite={targetSprite}
              />
            );
          })()
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">
            {targetSpriteId === null
              ? 'Pick a target sprite first.'
              : 'Select an animation to inspect or preview it.'}
          </div>
        )}
      </div>
    </div>
  );
}

function AnimationsEmptyState({
  hasTarget,
  onImport,
}: {
  hasTarget: boolean;
  onImport: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[var(--space-2)] p-[var(--space-3)] text-center text-[12px] text-[var(--color-text-muted)]">
      <p>No animations yet for this sprite.</p>
      {hasTarget ? (
        <>
          <p className="text-[11px]">
            Import a clip JSON, GLB, or spritesheet — or ask the agent to make one.
          </p>
          <button
            type="button"
            onClick={onImport}
            className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-[var(--space-3)] py-[var(--space-1)] text-[12px] text-white hover:opacity-90"
          >
            Import animation
          </button>
        </>
      ) : (
        <p className="text-[11px]">
          Select a target sprite above before importing or creating an animation.
        </p>
      )}
    </div>
  );
}

function AnimationRow({
  animation,
  bindings,
  active,
  onSelect,
}: {
  animation: GameArtifact;
  bindings: Array<{ id: string; spriteId: string; bindingStatus: string }>;
  active: boolean;
  onSelect: () => void;
}) {
  const meta = animation.metadata.kind === 'animation' ? animation.metadata : null;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        data-testid={`animation-row-${animation.id}`}
        className={`my-[2px] w-full rounded-[var(--radius-sm)] p-[var(--space-2)] text-left ${
          active
            ? 'bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]'
            : 'hover:bg-[var(--color-surface-elevated)]'
        }`}
      >
        <div className="flex items-center gap-[var(--space-2)]">
          <div className="h-8 w-8 shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-elevated)]" />
          <div className="flex flex-1 flex-col gap-[2px] overflow-hidden">
            <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">
              {animation.name}
            </span>
            <span className="truncate text-[10px] text-[var(--color-text-muted)]">
              {meta?.animationType ?? 'animation'} ·{' '}
              {meta ? `${(meta.durationMs / 1000).toFixed(2)}s` : ''} · {bindings.length} bound
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

function AnimationDetail({
  animation,
  sprites,
  bindings,
  targetSpriteId,
  onArchive,
  onCopyAlias,
  onBind,
  onUnbind,
  targetSprite,
}: {
  animation: GameArtifact;
  sprites: GameArtifact[];
  bindings: Array<{ id: string; spriteId: string; bindingStatus: string }>;
  targetSpriteId: string | null;
  onArchive: () => void;
  onCopyAlias: () => void;
  onBind: (spriteId: string) => Promise<void>;
  onUnbind: (spriteId: string) => Promise<void>;
  targetSprite: GameArtifact | null;
}) {
  const meta = animation.metadata.kind === 'animation' ? animation.metadata : null;
  const boundSpriteIds = new Set(bindings.map((b) => b.spriteId));
  const unboundSprites = sprites.filter((s) => !boundSpriteIds.has(s.id));

  return (
    <div className="flex flex-col gap-[var(--space-3)] text-[12px]">
      <div className="flex items-start justify-between gap-[var(--space-2)]">
        <div>
          <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
            {animation.name}
          </h2>
          <code className="text-[11px] text-[var(--color-text-muted)]">
            {animation.promptAlias}
          </code>
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
        <dt className="text-[var(--color-text-muted)]">Type</dt>
        <dd className="text-[var(--color-text-primary)]">{meta?.animationType ?? '—'}</dd>
        <dt className="text-[var(--color-text-muted)]">Duration</dt>
        <dd className="text-[var(--color-text-primary)]">
          {meta ? `${meta.durationMs}ms` : '—'} {meta?.fps ? `@ ${meta.fps}fps` : ''}
        </dd>
        <dt className="text-[var(--color-text-muted)]">Loop</dt>
        <dd className="text-[var(--color-text-primary)]">{meta?.loop ? 'Yes' : 'No'}</dd>
        <dt className="text-[var(--color-text-muted)]">Provenance</dt>
        <dd className="text-[var(--color-text-primary)]">{animation.provenance.source}</dd>
      </dl>
      <section>
        <h3 className="mb-[var(--space-1)] text-[11px] font-medium uppercase text-[var(--color-text-muted)]">
          Bound sprites
        </h3>
        {bindings.length === 0 ? (
          <p className="text-[11px] text-[var(--color-text-muted)]">No sprites bound yet.</p>
        ) : (
          <ul className="flex flex-col gap-[var(--space-1)]">
            {bindings.map((b) => {
              const sprite = sprites.find((s) => s.id === b.spriteId);
              return (
                <li
                  key={b.id}
                  className="flex items-center justify-between rounded-[var(--radius-sm)] px-[var(--space-2)] py-[var(--space-1)] hover:bg-[var(--color-surface-elevated)]"
                >
                  <span className="text-[var(--color-text-primary)]">
                    {sprite?.name ?? b.spriteId}
                  </span>
                  <span className="flex items-center gap-[var(--space-2)] text-[10px] text-[var(--color-text-muted)]">
                    {b.bindingStatus}
                    <button
                      type="button"
                      onClick={() => onUnbind(b.spriteId)}
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                    >
                      Unbind
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {unboundSprites.length > 0 ? (
        <section>
          <h3 className="mb-[var(--space-1)] text-[11px] font-medium uppercase text-[var(--color-text-muted)]">
            Apply to another sprite
          </h3>
          <div className="flex flex-wrap gap-[var(--space-1)]">
            {unboundSprites.map((sprite) => (
              <button
                key={sprite.id}
                type="button"
                onClick={() => onBind(sprite.id)}
                className="rounded-[var(--radius-sm)] border border-[var(--color-border-muted)] px-[var(--space-2)] py-[var(--space-1)] text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-elevated)]"
              >
                {sprite.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {targetSprite !== null ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Currently previewing on {targetSprite.name}.
        </p>
      ) : (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Pick a target sprite above to play this animation.
        </p>
      )}
    </div>
  );
}
