import { useT } from '@open-codesign/i18n';
import {
  Download,
  FolderTree,
  Hammer,
  Loader2,
  MessageSquare,
  Monitor,
  Play,
  RefreshCw,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { ExportFormat } from '../../../preload/index';
import { useDesignFiles } from '../hooks/useDesignFiles';
import { type GameAspect, type PreviewViewport, useCodesignStore } from '../store';

const GAME_ASPECT_OPTIONS: GameAspect[] = ['16:9', '4:3', '1:1', '9:16'];

const VIEWPORT_OPTIONS: Array<{
  value: PreviewViewport;
  Icon: typeof Monitor;
  label: 'preview.viewport.desktop' | 'preview.viewport.tablet' | 'preview.viewport.mobile';
}> = [
  { value: 'desktop', Icon: Monitor, label: 'preview.viewport.desktop' },
  { value: 'tablet', Icon: Tablet, label: 'preview.viewport.tablet' },
  { value: 'mobile', Icon: Smartphone, label: 'preview.viewport.mobile' },
];

interface ExportItem {
  format: ExportFormat;
  label: string;
  hint?: string;
  ready: boolean;
}

const ZOOM_OPTIONS = [50, 75, 90, 100, 110, 125, 150, 175, 200] as const;

export function PreviewToolbar(): ReactElement {
  const t = useT();
  const previewHtml = useCodesignStore((s) => s.previewHtml);
  const exportActive = useCodesignStore((s) => s.exportActive);
  const toastMessage = useCodesignStore((s) => s.toastMessage);
  const dismissToast = useCodesignStore((s) => s.dismissToast);
  const previewViewport = useCodesignStore((s) => s.previewViewport);
  const setPreviewViewport = useCodesignStore((s) => s.setPreviewViewport);
  const previewZoom = useCodesignStore((s) => s.previewZoom);
  const setPreviewZoom = useCodesignStore((s) => s.setPreviewZoom);
  const interactionMode = useCodesignStore((s) => s.interactionMode);
  const setInteractionMode = useCodesignStore((s) => s.setInteractionMode);
  const bumpPreviewReload = useCodesignStore((s) => s.bumpPreviewReload);
  const currentDesignId = useCodesignStore((s) => s.currentDesignId);
  const currentDesignEngine = useCodesignStore((s) => s.currentDesignEngine);
  const godotBuildStatus = useCodesignStore((s) =>
    currentDesignId ? (s.godotBuildStatusByDesign[currentDesignId] ?? null) : null,
  );
  const godotPreview = useCodesignStore((s) =>
    currentDesignId ? (s.godotPreviewByDesign[currentDesignId] ?? 'project') : 'project',
  );
  const buildGodotWebPreview = useCodesignStore((s) => s.buildGodotWebPreview);
  const gameAspect = useCodesignStore((s) => s.gameAspect);
  const setGameAspect = useCodesignStore((s) => s.setGameAspect);
  const isGameMode = currentDesignEngine !== null;
  // Multi-file affordance — surface "N files" when the design has
  // sidecars in `design_files`. Click switches the canvas to the
  // Files tab so the user can inspect the tree.
  const designFiles = useDesignFiles(currentDesignId);
  const canvasTabs = useCodesignStore((s) => s.canvasTabs);
  const setActiveCanvasTab = useCodesignStore((s) => s.setActiveCanvasTab);
  const filesTabIndex = canvasTabs.findIndex((tab) => tab.kind === 'files');
  const [refreshSpinning, setRefreshSpinning] = useState(false);
  const [open, setOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!zoomOpen) return;
    function onClick(e: MouseEvent): void {
      if (zoomRef.current && !zoomRef.current.contains(e.target as Node)) setZoomOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [zoomOpen]);

  useEffect(() => {
    if (!toastMessage) return;
    const timeout = setTimeout(() => dismissToast(), 4000);
    return () => clearTimeout(timeout);
  }, [toastMessage, dismissToast]);

  const disabled = !previewHtml;
  const commentActive = interactionMode === 'comment';
  const exportItems: ExportItem[] = [
    {
      format: 'html',
      label: t('export.items.html.label'),
      ready: true,
      hint: t('export.items.html.hint'),
    },
    {
      format: 'pdf',
      label: t('export.items.pdf.label'),
      ready: true,
      hint: t('export.items.pdf.hint'),
    },
    {
      format: 'pptx',
      label: t('export.items.pptx.label'),
      ready: true,
      hint: t('export.items.pptx.hint'),
    },
    {
      format: 'zip',
      label: t('export.items.zip.label'),
      ready: true,
      hint: t('export.items.zip.hint'),
    },
    {
      format: 'markdown',
      label: t('export.items.markdown.label'),
      ready: true,
      hint: t('export.items.markdown.hint'),
    },
  ];

  return (
    <div className="ml-auto flex items-center justify-end gap-[var(--space-1)] pr-[var(--space-4)] py-[3px]">
      {toastMessage && (
        <output className="mr-auto text-[var(--text-xs)] text-[var(--color-text-secondary)] truncate max-w-[60%]">
          {toastMessage}
        </output>
      )}
      {designFiles.multiFile && filesTabIndex >= 0 ? (
        <button
          type="button"
          onClick={() => setActiveCanvasTab(filesTabIndex)}
          aria-label={`${designFiles.files.length} files in this design — click to view file tree`}
          title={`${designFiles.files.length} files — click to view file tree`}
          className="inline-flex items-center gap-[4px] rounded-[var(--radius-sm)] px-[var(--space-2)] h-[22px] text-[11px] tabular-nums text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          <FolderTree className="w-[12px] h-[12px]" aria-hidden />
          <span>{designFiles.files.length} files</span>
        </button>
      ) : null}

      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          bumpPreviewReload();
          setRefreshSpinning(true);
          // Match the 0.6 s CSS spin so the icon settles after one full
          // rotation regardless of how fast the iframe reloads.
          window.setTimeout(() => setRefreshSpinning(false), 600);
        }}
        aria-label={t('preview.refresh.label')}
        title={t('preview.refresh.label')}
        className="inline-flex items-center justify-center w-[28px] h-[26px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-[background-color,color,transform] duration-[var(--duration-faster)] active:scale-[var(--scale-press-down)] disabled:opacity-40 disabled:pointer-events-none"
      >
        <RefreshCw
          className={`w-3.5 h-3.5 ${refreshSpinning ? 'codesign-spin-once' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isGameMode ? (
        <div
          role="group"
          aria-label={t('preview.aspect.label', { defaultValue: 'Aspect ratio' })}
          className="inline-flex items-center"
        >
          {GAME_ASPECT_OPTIONS.map((value) => {
            const isActive = gameAspect === value;
            return (
              <button
                key={value}
                type="button"
                disabled={disabled}
                aria-pressed={isActive}
                aria-label={value}
                title={value}
                onClick={() => setGameAspect(value)}
                className={`inline-flex items-center justify-center px-[8px] h-[26px] text-[11px] tabular-nums transition-[background-color,color,transform] duration-[var(--duration-faster)] active:scale-[var(--scale-press-down)] disabled:opacity-40 disabled:pointer-events-none ${
                  isActive
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
                }`}
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {value}
              </button>
            );
          })}
        </div>
      ) : (
        <div
          role="group"
          aria-label={t('preview.viewport.label')}
          className="inline-flex items-center"
        >
          {VIEWPORT_OPTIONS.map(({ value, Icon, label }) => {
            const isActive = previewViewport === value;
            return (
              <button
                key={value}
                type="button"
                disabled={disabled}
                aria-pressed={isActive}
                aria-label={t(label)}
                title={t(label)}
                onClick={() => setPreviewViewport(value)}
                className={`inline-flex items-center justify-center w-[28px] h-[26px] transition-[background-color,color,transform] duration-[var(--duration-faster)] active:scale-[var(--scale-press-down)] disabled:opacity-40 disabled:pointer-events-none ${
                  isActive
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        disabled={disabled}
        aria-pressed={commentActive}
        onClick={() => setInteractionMode(commentActive ? 'default' : 'comment')}
        className={`inline-flex items-center gap-[6px] h-[26px] px-[10px] text-[12px] transition-[background-color,color,transform] duration-[var(--duration-faster)] active:scale-[var(--scale-press-down)] disabled:opacity-40 disabled:pointer-events-none ${
          commentActive
            ? 'text-[var(--color-accent)]'
            : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
        {t('preview.commentMode')}
      </button>

      <div className="relative" ref={zoomRef}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setZoomOpen((v) => !v)}
          className="inline-flex items-center justify-end w-[56px] h-[26px] pr-[10px] text-[12px] tabular-nums text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:pointer-events-none transition-[background-color,color,transform] duration-[var(--duration-faster)] active:scale-[var(--scale-press-down)]"
          aria-haspopup="menu"
          aria-expanded={zoomOpen}
          aria-label={t('preview.zoom')}
          style={{ fontFamily: 'var(--font-mono)', fontFeatureSettings: "'tnum'" }}
        >
          {previewZoom}%
        </button>

        {zoomOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-[var(--space-1_5)] w-[56px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-elevated)] p-[var(--space-1)] z-10"
          >
            {ZOOM_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={previewZoom === value}
                onClick={() => {
                  setPreviewZoom(value);
                  setZoomOpen(false);
                }}
                className={`block w-full pr-[10px] py-[var(--space-1)] text-[12px] text-right rounded-[var(--radius-sm)] tabular-nums transition-colors duration-100 hover:bg-[var(--color-surface-hover)] ${previewZoom === value ? 'text-[var(--color-accent)] font-medium' : 'text-[var(--color-text-primary)]'}`}
                style={{ fontFamily: 'var(--font-mono)', fontFeatureSettings: "'tnum'" }}
              >
                {value}%
              </button>
            ))}
          </div>
        )}
      </div>

      {currentDesignEngine === 'godot' && currentDesignId !== null && (
        <GodotBuildButton
          designId={currentDesignId}
          status={godotBuildStatus}
          previewMode={godotPreview}
          onBuild={() => void buildGodotWebPreview(currentDesignId)}
        />
      )}

      <div className="relative" ref={ref}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-[6px] h-[26px] px-[10px] text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:pointer-events-none transition-[background-color,color,transform] duration-[var(--duration-faster)] active:scale-[var(--scale-press-down)]"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          {t('export.button')}
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-[var(--space-1_5)] min-w-[320px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-elevated)] p-[var(--space-1)] z-10"
          >
            {exportItems.map((item) => (
              <button
                key={item.format}
                type="button"
                role="menuitem"
                disabled={!item.ready}
                onClick={() => {
                  setOpen(false);
                  void exportActive(item.format);
                }}
                className="w-full flex flex-col items-start gap-[2px] px-[var(--space-3)] py-[var(--space-2)] text-left rounded-[var(--radius-sm)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-100"
              >
                <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-primary)]">
                  {item.label}
                </span>
                {item.hint && (
                  <span className="text-[11px] text-[var(--color-text-muted)] leading-[var(--leading-ui)]">
                    {item.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface GodotBuildButtonProps {
  designId: string;
  status:
    | { status: 'idle' }
    | { status: 'building'; phase: string; line?: string }
    | { status: 'failed'; reason: string; detail: string }
    | { status: 'ok' }
    | null;
  previewMode: 'project' | 'build';
  onBuild: () => void;
}

/** A6.x — Godot-only toolbar button. Shows three visual states:
 *  - idle / failed: "Build web preview" (Hammer icon)
 *  - building: spinner + current phase
 *  - ok: "Re-build" with a Play icon (the iframe has already been
 *    switched to the build output by the action that set status='ok')
 */
function GodotBuildButton({
  designId: _designId,
  status,
  previewMode,
  onBuild,
}: GodotBuildButtonProps) {
  const t = useT();
  const isBuilding = status?.status === 'building';
  const isOk = status?.status === 'ok' && previewMode === 'build';
  const Icon = isBuilding ? Loader2 : isOk ? Play : Hammer;
  const label = isBuilding
    ? t('preview.godot.building', { defaultValue: 'Building…' })
    : isOk
      ? t('preview.godot.rebuild', { defaultValue: 'Re-build' })
      : t('preview.godot.build', { defaultValue: 'Build web preview' });
  const title = isBuilding && status.line ? status.line : label;
  return (
    <button
      type="button"
      disabled={isBuilding}
      onClick={onBuild}
      title={title}
      aria-label={label}
      className={`inline-flex items-center gap-[6px] h-[26px] px-[10px] text-[12px] transition-[background-color,color,transform] duration-[var(--duration-faster)] active:scale-[var(--scale-press-down)] disabled:opacity-60 disabled:pointer-events-none ${
        isOk
          ? 'text-[var(--color-success,_#4ade80)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
          : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <Icon className={`w-3.5 h-3.5 ${isBuilding ? 'animate-spin' : ''}`} aria-hidden="true" />
      {label}
    </button>
  );
}
