import { useEffect, useMemo } from 'react';
import { useCodesignStore } from '../../store';

/** motion-graphics-plan §4 — embedded `<Player>` from @remotion/player. The
 *  iframe loads the fixed shell template at
 *  `motion-files://designs/{id}/.bundle/index.html?compositionId={id}`. The
 *  shell instantiates `<Player>` against the bundled JS produced by the
 *  main-process bundler. Bundle status (success/error) lands here over IPC
 *  via the `motion:event:v1` channel. */
export function MotionPreviewPane() {
  const designId = useCodesignStore((s) => s.currentDesignId);
  const compositions = useCodesignStore((s) =>
    designId !== null ? (s.motionCompositionsByDesign[designId] ?? []) : [],
  );
  const selectedId = useCodesignStore((s) =>
    designId !== null ? (s.selectedCompositionIdByDesign[designId] ?? null) : null,
  );
  const status = useCodesignStore((s) =>
    designId !== null ? s.motionBundleStatusByDesign[designId] : undefined,
  );
  const applyMotionBundleEvent = useCodesignStore((s) => s.applyMotionBundleEvent);

  // Subscribe once per design to the main-process IPC stream. The handler
  // is fire-and-forget (we drop the unsubscribe ref after the component
  // unmounts because the listener is keyed on designId in the apply
  // function).
  useEffect(() => {
    if (designId === null) return;
    const off = window.codesign?.motion?.onBundleEvent?.((event) => {
      if (event.designId !== designId) return;
      applyMotionBundleEvent(event);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [designId, applyMotionBundleEvent]);

  const compositionId = useMemo(() => {
    if (selectedId !== null) return selectedId;
    return compositions[0]?.compositionId ?? null;
  }, [selectedId, compositions]);

  if (designId === null) return null;

  const iframeSrc =
    compositionId !== null
      ? `motion-files://designs/${designId}/.bundle/index.html?compositionId=${encodeURIComponent(compositionId)}`
      : `motion-files://designs/${designId}/.bundle/index.html`;

  return (
    <div className="relative flex h-full w-full flex-col bg-[var(--color-background)]">
      {status?.state === 'error' ? (
        <div className="border-b border-[var(--color-border-error)] bg-[var(--color-background-error)] px-[var(--space-3)] py-[var(--space-2)] text-[var(--text-xs)] text-[var(--color-text-error)]">
          <div className="font-medium mb-1">Bundle failed</div>
          <pre className="font-mono whitespace-pre-wrap break-all max-h-32 overflow-auto">
            {(status.errorText ?? '').split('\n').slice(0, 20).join('\n')}
          </pre>
        </div>
      ) : null}
      <iframe
        title="Remotion preview"
        data-testid="motion-preview-iframe"
        src={iframeSrc}
        sandbox="allow-scripts allow-same-origin"
        className="flex-1 w-full bg-black"
      />
      {compositions.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-background)]/95">
          <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">
            Waiting for the agent to register a composition…
          </p>
        </div>
      ) : null}
    </div>
  );
}
