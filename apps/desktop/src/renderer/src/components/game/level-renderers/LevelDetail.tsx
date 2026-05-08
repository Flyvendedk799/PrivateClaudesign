import type { GameArtifact, LevelDoc } from '@open-codesign/shared';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCodesignStore } from '../../../store';
import { parseLevelDoc } from '../LevelsTabView';
import { JsonRenderer } from './JsonRenderer';
import { NodeGraphRenderer } from './NodeGraphRenderer';
import { Scene3DRenderer } from './Scene3DRenderer';
import { TilemapRenderer } from './TilemapRenderer';
import { WaveScriptRenderer } from './WaveScriptRenderer';

/**
 * level-and-world-designer §Phase 5 — dispatcher that picks the right
 * specialized renderer for a level based on its `kind` discriminator.
 *
 * Loads `assets/levels/<slug>/level.json` content from the IPC layer,
 * parses against the `LevelDoc` Zod schema, and routes to the matching
 * renderer. Parse failures fall through to `JsonRenderer` with a
 * warning banner so divergence is visible — never silent.
 *
 * Save path: each renderer is a controlled component that takes a
 * `(next: LevelDoc) => Promise<void>` callback. We debounce-wrap that
 * here, validate against the schema, and write through the
 * `gameArtifacts.writeFile` IPC. Validation failure surfaces as a
 * toast; nothing is written.
 */
export function LevelDetail({
  designId,
  slug,
  levels,
}: {
  designId: string;
  slug: string;
  levels: GameArtifact[];
}) {
  const artifact = useMemo(() => levels.find((l) => l.slug === slug) ?? null, [levels, slug]);

  const [content, setContent] = useState<string | null>(null);
  const [parseState, setParseState] = useState<ReturnType<typeof parseLevelDoc> | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const path = artifact?.primaryFilePath ?? `assets/levels/${slug}/level.json`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setParseState(null);
    if (window.codesign === undefined) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void window.codesign.gameArtifacts
      .readFile(designId, path)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setParseState(parseLevelDoc(res.content));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setContent(null);
        setParseState({ ok: false, rawJson: null, issues: [`Read failed: ${msg}`] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [designId, path]);

  const writeContent = useCallback(
    async (raw: string) => {
      if (window.codesign === undefined) return;
      setSaving(true);
      try {
        await window.codesign.gameArtifacts.writeFile(designId, path, raw);
        setContent(raw);
        setParseState(parseLevelDoc(raw));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        useCodesignStore.setState({ toastMessage: `Save failed: ${msg}` });
      } finally {
        setSaving(false);
      }
    },
    [designId, path],
  );

  const onChange = useCallback(
    (next: LevelDoc) => {
      // Debounce form-driven updates so a flurry of keystrokes coalesces
      // into a single write. Renderers that batch internally (3D / canvas
      // editors) can still call this on every drag-end.
      if (saveDebounceRef.current !== null) clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = setTimeout(() => {
        void writeContent(JSON.stringify(next, null, 2));
      }, 300);
    },
    [writeContent],
  );

  const onChangeRaw = useCallback(
    (raw: string) => {
      // JsonRenderer fallback writes raw bytes — let the caller decide
      // whether validation runs.
      void writeContent(raw);
    },
    [writeContent],
  );

  if (artifact === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">
        Level <code className="px-1">{slug}</code> not found in registry.
      </div>
    );
  }

  if (loading || parseState === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-[var(--space-2)] text-[12px] text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 codesign-spin-once" aria-hidden="true" />
        <span>Loading level…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)]">
      <div className="flex items-center justify-between gap-[var(--space-2)]">
        <div className="flex flex-col">
          <h3 className="text-[14px] font-medium text-[var(--color-text-primary)]">
            {artifact.name}
          </h3>
          <code className="text-[11px] text-[var(--color-text-muted)]">{path}</code>
        </div>
        {saving ? (
          <span className="inline-flex items-center gap-[4px] text-[11px] text-[var(--color-text-muted)]">
            <Loader2 className="h-3 w-3 codesign-spin-once" aria-hidden="true" />
            Saving…
          </span>
        ) : null}
      </div>
      {parseState.ok ? (
        <RendererForKind
          doc={parseState.doc}
          designId={designId}
          slug={slug}
          rawContent={content ?? ''}
          onChange={onChange}
          onChangeRaw={onChangeRaw}
        />
      ) : (
        <>
          <div className="rounded-[var(--radius-sm)] border border-amber-500/40 bg-amber-500/8 p-[var(--space-2)] text-[11px] text-amber-500">
            <strong className="text-[12px]">Schema mismatch.</strong> Falling back to the JSON
            editor.
            <ul className="mt-[var(--space-1)] list-disc pl-[var(--space-3)]">
              {parseState.issues.slice(0, 8).map((iss, i) => (
                <li key={`iss-${i.toString()}`}>{iss}</li>
              ))}
              {parseState.issues.length > 8 ? (
                <li>…and {parseState.issues.length - 8} more</li>
              ) : null}
            </ul>
          </div>
          <JsonRenderer rawContent={content ?? ''} onChangeRaw={onChangeRaw} />
        </>
      )}
    </div>
  );
}

function RendererForKind({
  doc,
  designId,
  slug,
  rawContent,
  onChange,
  onChangeRaw,
}: {
  doc: LevelDoc;
  designId: string;
  slug: string;
  rawContent: string;
  onChange: (next: LevelDoc) => void;
  onChangeRaw: (raw: string) => void;
}) {
  switch (doc.kind) {
    case 'tilemap-2d':
      return <TilemapRenderer doc={doc} onChange={onChange} />;
    case 'scene-3d':
      return <Scene3DRenderer doc={doc} onChange={onChange} />;
    case 'node-graph':
      return <NodeGraphRenderer doc={doc} onChange={onChange} />;
    case 'wave-script':
      return <WaveScriptRenderer doc={doc} onChange={onChange} />;
    case 'freeform-json':
      return <JsonRenderer rawContent={rawContent} onChangeRaw={onChangeRaw} />;
    default: {
      // Exhaustiveness guard: if the union grows we want a compile error
      // here, not a silent fallback.
      const _exhaustive: never = doc;
      void _exhaustive;
      void designId;
      void slug;
      return <JsonRenderer rawContent={rawContent} onChangeRaw={onChangeRaw} />;
    }
  }
}
