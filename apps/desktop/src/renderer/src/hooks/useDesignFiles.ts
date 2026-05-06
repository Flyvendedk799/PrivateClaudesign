import { useEffect, useState } from 'react';
import { useCodesignStore } from '../store';

export type DesignFileKind = 'html' | 'asset';

export interface DesignFileEntry {
  path: string;
  kind: DesignFileKind;
  updatedAt: string;
  size?: number;
}

export interface UseDesignFilesResult {
  files: DesignFileEntry[];
  loading: boolean;
  /** `'design-files'` when the snapshots:v1:list-files IPC returned the
   *  real `design_files` tree (post-multi-file). `'snapshots'` when we
   *  fell back to deriving a synthetic single `index.html` from the
   *  latest snapshot — happens for designs that haven't been touched
   *  since the multi-file feature shipped, or when the IPC throws. */
  backend: 'design-files' | 'snapshots';
  /** True when the design has more than one file in `design_files` —
   *  PreviewPane uses this to switch from the cheap `srcdoc` path to
   *  the `design-files://` protocol so sidecar `.css` / `.js` resolve.
   *  False for trivial single-file designs and legacy fallback. */
  multiFile: boolean;
}

function classifyKind(path: string): DesignFileKind {
  return path.toLowerCase().endsWith('.html') ? 'html' : 'asset';
}

/**
 * Lists the design's persisted file tree. Prefers the live
 * `design_files` IPC; falls back to a synthetic single-`index.html`
 * row derived from `previewHtml` so the Files panel + preview-source
 * helper keep working on legacy single-file designs.
 *
 * Refreshes when the FS-write tick advances (`previewReloadTick`),
 * when the user generates fresh content (`previewHtml`), or when the
 * design id changes. Cheap — IPC returns metadata only, no file
 * bodies.
 */
export function useDesignFiles(designId: string | null): UseDesignFilesResult {
  const previewHtml = useCodesignStore((s) => s.previewHtml);
  const designs = useCodesignStore((s) => s.designs);
  const previewReloadTick = useCodesignStore((s) => s.previewReloadTick);
  const [latestSnapshotAt, setLatestSnapshotAt] = useState<string | null>(null);
  const [files, setFiles] = useState<DesignFileEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [backend, setBackend] = useState<'design-files' | 'snapshots'>('snapshots');

  // Try the live IPC first. If it returns rows, those are the source of
  // truth (Phase 1.2 of the multi-file plan). Otherwise we'll fall through
  // to the legacy single-file derivation below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewHtml + previewReloadTick are intentional fresh-generation signals
  useEffect(() => {
    let cancelled = false;
    if (!designId || !window.codesign) {
      setFiles([]);
      setBackend('snapshots');
      return;
    }
    const listFiles = (
      window.codesign.snapshots as unknown as {
        listFiles?: (
          id: string,
        ) => Promise<Array<{ path: string; sizeBytes: number; updatedAt: string }>>;
      }
    ).listFiles;
    if (typeof listFiles !== 'function') {
      // Preload bridge predates the multi-file IPC. Stay on snapshot fallback.
      return;
    }
    setLoading(true);
    listFiles(designId)
      .then((rows) => {
        if (cancelled) return;
        if (rows.length === 0) {
          // No real rows yet (legacy design, or pre-first-write). Leave
          // `backend` at 'snapshots' so the previewHtml-derived row
          // below populates.
          setFiles([]);
          setBackend('snapshots');
          return;
        }
        setFiles(
          rows.map((r) => ({
            path: r.path,
            kind: classifyKind(r.path),
            updatedAt: r.updatedAt,
            size: r.sizeBytes,
          })),
        );
        setBackend('design-files');
      })
      .catch(() => {
        if (cancelled) return;
        setBackend('snapshots');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [designId, previewHtml, previewReloadTick]);

  // Snapshot fallback — single synthetic `index.html` derived from
  // `previewHtml` when the IPC didn't return anything. Keeps Files panel
  // useful for legacy single-file designs and during the first turn
  // before any text_editor.create has fired.
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewHtml is intentionally listed as a fresh-generation signal
  useEffect(() => {
    let cancelled = false;
    if (!designId || !window.codesign) {
      setLatestSnapshotAt(null);
      return;
    }
    window.codesign.snapshots
      .list(designId)
      .then((snaps) => {
        if (cancelled) return;
        setLatestSnapshotAt(snaps[0]?.createdAt ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setLatestSnapshotAt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [designId, previewHtml]);

  if (backend === 'design-files') {
    return { files, loading, backend, multiFile: files.length > 1 };
  }

  // Legacy single-file fallback.
  const fallback: DesignFileEntry[] = [];
  if (designId && previewHtml) {
    const design = designs.find((d) => d.id === designId);
    const updatedAt = latestSnapshotAt ?? design?.updatedAt ?? new Date().toISOString();
    fallback.push({ path: 'index.html', kind: 'html', updatedAt, size: previewHtml.length });
  }
  return { files: fallback, loading, backend: 'snapshots', multiFile: false };
}

// Format an ISO timestamp as "22h ago" / "3d ago". Pure for testability.
export function formatRelativeTime(isoTime: string, now: Date = new Date()): string {
  const then = new Date(isoTime).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Math.max(0, now.getTime() - then);
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

// Precise tooltip form: "Modified Apr 20, 2026, 14:32".
export function formatAbsoluteTime(isoTime: string): string {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
