import type { GameArtifact, LevelDoc } from '@open-codesign/shared';
import { Download, Loader2, PlayCircle, Redo2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCodesignStore } from '../../../store';
import { parseLevelDoc } from '../LevelsTabView';
import { JsonRenderer } from './JsonRenderer';
import { NodeGraphRenderer } from './NodeGraphRenderer';
import { PlaytestModal } from './PlaytestModal';
import { Scene3DRenderer } from './Scene3DRenderer';
import { TilemapRenderer } from './TilemapRenderer';
import { WaveScriptRenderer } from './WaveScriptRenderer';
import { useDocHistory } from './useDocHistory';

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

  return parseState.ok ? (
    <LevelDetailParsed
      artifact={artifact}
      doc={parseState.doc}
      designId={designId}
      slug={slug}
      path={path}
      rawContent={content ?? ''}
      saving={saving}
      onChange={onChange}
      onChangeRaw={onChangeRaw}
    />
  ) : (
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
      <div className="rounded-[var(--radius-sm)] border border-amber-500/40 bg-amber-500/8 p-[var(--space-2)] text-[11px] text-amber-500">
        <strong className="text-[12px]">Schema mismatch.</strong> Falling back to the JSON editor.
        <ul className="mt-[var(--space-1)] list-disc pl-[var(--space-3)]">
          {parseState.issues.slice(0, 8).map((iss, i) => (
            <li key={`iss-${i.toString()}`}>{iss}</li>
          ))}
          {parseState.issues.length > 8 ? <li>…and {parseState.issues.length - 8} more</li> : null}
        </ul>
      </div>
      <JsonRenderer rawContent={content ?? ''} onChangeRaw={onChangeRaw} />
    </div>
  );
}

/** Browser-side download helper. Used by Phase 8.7 export buttons —
 *  keeps the export path renderer-only so we don't need a new IPC
 *  channel for what is just "save bytes the renderer already has". */
function downloadStringAsFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next tick — synchronous click consumes the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Parsed-doc subtree — owns the undo/redo history. Pulled out of the
 *  LevelDetail body so the useDocHistory hook only mounts after the
 *  doc has actually parsed (avoids resetting history every load). */
function LevelDetailParsed({
  artifact,
  doc,
  designId,
  slug,
  path,
  rawContent,
  saving,
  onChange,
  onChangeRaw,
}: {
  artifact: GameArtifact;
  doc: LevelDoc;
  designId: string;
  slug: string;
  path: string;
  rawContent: string;
  saving: boolean;
  onChange: (next: LevelDoc) => void;
  onChangeRaw: (raw: string) => void;
}) {
  const history = useDocHistory<LevelDoc>(doc);
  const [playtestOpen, setPlaytestOpen] = useState(false);

  // When the upstream doc changes (e.g. another tab wrote the file),
  // resync the history to the new value. useDocHistory's effect handles
  // this on referential change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: history identity flips per render; depending only on doc is intentional
  useEffect(() => {
    history.replace(doc);
  }, [doc]);

  const handleChange = useCallback(
    (next: LevelDoc) => {
      history.push(next);
      onChange(next);
    },
    [history, onChange],
  );

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-2)]">
      <div className="flex items-center justify-between gap-[var(--space-2)]">
        <div className="flex flex-col">
          <h3 className="text-[14px] font-medium text-[var(--color-text-primary)]">
            {artifact.name}
          </h3>
          <code className="text-[11px] text-[var(--color-text-muted)]">{path}</code>
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <div className="inline-flex items-center gap-[2px]">
            <button
              type="button"
              disabled={!history.canUndo}
              onClick={history.undo}
              aria-label="Undo"
              title="Undo (cmd-z)"
              className="rounded-[var(--radius-sm)] p-[4px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:pointer-events-none"
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={!history.canRedo}
              onClick={history.redo}
              aria-label="Redo"
              title="Redo (cmd-shift-z)"
              className="rounded-[var(--radius-sm)] p-[4px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:pointer-events-none"
            >
              <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                downloadStringAsFile(JSON.stringify(history.value, null, 2), `${slug}.json`)
              }
              aria-label="Export level"
              title="Export this level as a standalone .json file"
              className="rounded-[var(--radius-sm)] p-[4px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setPlaytestOpen(true)}
              aria-label="Playtest level"
              title="Open this level in a sandboxed iframe with the design's previewHtml + the level injected as window.__OPEN_CODESIGN_LEVEL"
              className="rounded-[var(--radius-sm)] p-[4px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          {saving ? (
            <span className="inline-flex items-center gap-[4px] text-[11px] text-[var(--color-text-muted)]">
              <Loader2 className="h-3 w-3 codesign-spin-once" aria-hidden="true" />
              Saving…
            </span>
          ) : null}
        </div>
      </div>
      <RendererForKind
        doc={history.value}
        designId={designId}
        slug={slug}
        rawContent={rawContent}
        onChange={handleChange}
        onChangeRaw={onChangeRaw}
      />
      {playtestOpen ? (
        <PlaytestModal doc={history.value} slug={slug} onClose={() => setPlaytestOpen(false)} />
      ) : null}
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
