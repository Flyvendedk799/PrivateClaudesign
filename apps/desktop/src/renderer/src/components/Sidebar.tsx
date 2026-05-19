import { useT } from '@open-codesign/i18n';
import {
  type DesignSnapshot,
  type EscalationSignal,
  type LocalInputFile,
  type OnboardingState,
  classifyAbortKind,
  selectEscalationHint,
  summarizeSnapshotDiff,
} from '@open-codesign/shared';
import {
  Download,
  FolderOpen,
  Link2,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStream } from '../hooks/useAgentStream';
import { useCodesignStore } from '../store';
import { EscalationHint } from './EscalationHint';
import { ModelSwitcher } from './ModelSwitcher';
import { AddMenu } from './chat/AddMenu';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatStatusHeader } from './chat/ChatStatusHeader';
import { CommentChipBar } from './chat/CommentChipBar';
import { EmptyState } from './chat/EmptyState';
import { PromptInput, type PromptInputHandle } from './chat/PromptInput';

export interface SidebarProps {
  prompt: string;
  setPrompt: (value: string) => void;
  onSubmit: () => void;
}

interface ComposerContextItem {
  key: string;
  label: string;
  icon: 'file' | 'url' | 'designSystem';
  actionLabel?: string;
}

export function buildComposerContextItems(input: {
  inputFiles: LocalInputFile[];
  referenceUrl: string;
  config: OnboardingState | null;
}): ComposerContextItem[] {
  const items: ComposerContextItem[] = input.inputFiles.map((file) => ({
    key: `file:${file.path}`,
    label: file.name,
    icon: 'file',
    actionLabel: file.path,
  }));

  const referenceUrl = input.referenceUrl.trim();
  if (referenceUrl.length > 0) {
    items.push({
      key: 'reference-url',
      label: referenceUrl,
      icon: 'url',
      actionLabel: referenceUrl,
    });
  }

  const designSystem = input.config?.designSystem ?? null;
  if (designSystem) {
    items.push({
      key: 'design-system',
      label: designSystem.summary,
      icon: 'designSystem',
      actionLabel: designSystem.rootPath,
    });
  }

  return items;
}

function ContextIcon({ icon }: { icon: ComposerContextItem['icon'] }) {
  if (icon === 'file') return <Paperclip className="w-3.5 h-3.5" aria-hidden />;
  if (icon === 'url') return <Link2 className="w-3.5 h-3.5" aria-hidden />;
  return <FolderOpen className="w-3.5 h-3.5" aria-hidden />;
}

interface ConversationTab {
  sessionId: number;
  label: string;
  title: string;
}

/**
 * Sidebar v2 — chat-style conversation pane.
 *
 * Replaces the single-shot prompt box with a chat history backed by the
 * chat_messages SQLite table. See docs/plans/2026-04-20-agentic-sidebar-
 * custom-endpoint-design.md §5 for the full spec. Multi-design switcher
 * stays deferred; the design name + "+" header shows the single current
 * design only.
 */
export function Sidebar({ prompt, setPrompt, onSubmit }: SidebarProps) {
  const t = useT();
  const config = useCodesignStore((s) => s.config);
  const isGenerating = useCodesignStore(
    (s) => s.isGenerating && s.generatingDesignId === s.currentDesignId,
  );
  const cancelGeneration = useCodesignStore((s) => s.cancelGeneration);
  const requestWrapUp = useCodesignStore((s) => s.requestWrapUp);
  const requestNewSession = useCodesignStore((s) => s.requestNewSession);
  const inputFiles = useCodesignStore((s) => s.inputFiles);
  const referenceUrl = useCodesignStore((s) => s.referenceUrl);
  const setReferenceUrl = useCodesignStore((s) => s.setReferenceUrl);
  const pickInputFiles = useCodesignStore((s) => s.pickInputFiles);
  const removeInputFile = useCodesignStore((s) => s.removeInputFile);
  const pickDesignSystemDirectory = useCodesignStore((s) => s.pickDesignSystemDirectory);
  const clearDesignSystem = useCodesignStore((s) => s.clearDesignSystem);
  const lastUsage = useCodesignStore((s) => s.lastUsage);

  const chatMessages = useCodesignStore((s) => s.chatMessages);
  const chatLoaded = useCodesignStore((s) => s.chatLoaded);
  const currentChatSessionId = useCodesignStore((s) => s.currentChatSessionId);
  const switchChatSession = useCodesignStore((s) => s.switchChatSession);
  const exportDebugHandoff = useCodesignStore((s) => s.exportDebugHandoff);
  const streamingAssistantText = useCodesignStore((s) => s.streamingAssistantText);
  const streamingThinking = useCodesignStore((s) => s.streamingThinking);
  const streamingToolDraft = useCodesignStore((s) => s.streamingToolDraft);
  const pendingToolCalls = useCodesignStore((s) => s.pendingToolCalls);
  const loadChatForCurrentDesign = useCodesignStore((s) => s.loadChatForCurrentDesign);
  const currentDesignId = useCodesignStore((s) => s.currentDesignId);
  const designs = useCodesignStore((s) => s.designs);
  const sidebarCollapsed = useCodesignStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useCodesignStore((s) => s.setSidebarCollapsed);

  // Mount useAgentStream here so streaming events route into the chat
  // as soon as the Sidebar is in the tree — matches the lifecycle of
  // chat visibility without needing an app-level hook.
  useAgentStream();

  const promptInputRef = useRef<PromptInputHandle>(null);
  const handlePickStarter = (starterPrompt: string): void => {
    setPrompt(starterPrompt);
    promptInputRef.current?.focus();
  };

  const designSystem = config?.designSystem ?? null;
  const currentDesign = designs.find((d) => d.id === currentDesignId) ?? null;
  const contextItems = buildComposerContextItems({ inputFiles, referenceUrl, config });

  useEffect(() => {
    if (currentDesignId && !chatLoaded) {
      void loadChatForCurrentDesign();
    }
  }, [currentDesignId, chatLoaded, loadChatForCurrentDesign]);

  const activeModelLine =
    config?.hasKey && config.modelPrimary ? config.modelPrimary : t('sidebar.chat.noModel');
  const lastTokens = lastUsage ? lastUsage.inputTokens + lastUsage.outputTokens : null;
  // may9 follow-up #36 — cache hit rate from the latest run.
  // cachedInputTokens / inputTokens; null when no run has landed
  // yet OR the input was zero (degenerate, but skip the divide).
  const cacheHitRate =
    lastUsage !== null && lastUsage.inputTokens > 0
      ? lastUsage.cachedInputTokens / lastUsage.inputTokens
      : null;

  // may9 Phase 13 follow-up #35 — compute the escalation hint from
  // recent error rows in the chat. The selector reads chat_messages
  // kind='error' rows with model context, classifies via
  // classifyAbortKind, and considers only failures (not paused or
  // user_aborted). The active model is the config primary; opus has
  // no further escalation so the selector returns null there.
  const escalationHint = useMemo(() => {
    if (!config?.hasKey || !config.modelPrimary) return null;
    const signals: EscalationSignal[] = [];
    for (const msg of chatMessages) {
      if (msg.kind !== 'error') continue;
      const p = msg.payload as { message?: string; model?: string; modelId?: string } | null;
      if (p === null) continue;
      const message = p.message ?? '';
      const kind = classifyAbortKind(message);
      // Only count "real" failures — skip user-initiated aborts and
      // paused-at-safe-boundary which are routine.
      if (kind === 'paused_safe_boundary' || kind === 'user_aborted') continue;
      const modelId = p.modelId ?? p.model ?? config.modelPrimary;
      signals.push({
        modelId,
        at: msg.createdAt ?? new Date().toISOString(),
        kind: kind === 'overloaded' ? 'overloaded' : 'failed',
      });
    }
    return selectEscalationHint(signals, config.modelPrimary);
  }, [chatMessages, config?.hasKey, config?.modelPrimary]);
  const openSettingsTab = useCodesignStore((s) => s.openSettingsTab);

  // Sequence-7 (game-mode guardrails) — load snapshots for the current
  // design so we can compute per-snapshot "what changed" diff lines and
  // surface them next to the artifact_delivered tile in the chat.
  // chatMessages.length / isGenerating trigger a refresh when a new
  // artifact_delivered row lands or generation finishes — they're not
  // used inside the body, so Biome flags them; the suppression is
  // intentional (trigger-only deps).
  const [designSnapshots, setDesignSnapshots] = useState<ReadonlyArray<DesignSnapshot>>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps for snapshot refresh
  useEffect(() => {
    if (!currentDesignId) {
      setDesignSnapshots([]);
      return;
    }
    const codesign = window.codesign;
    if (codesign === undefined) return;
    let cancelled = false;
    void codesign.snapshots
      .list(currentDesignId)
      .then((snaps: ReadonlyArray<DesignSnapshot>) => {
        if (cancelled) return;
        setDesignSnapshots(snaps);
      })
      .catch(() => {
        // Decorative — empty list silently disables the diff badge.
      });
    return () => {
      cancelled = true;
    };
  }, [currentDesignId, chatMessages.length, isGenerating]);

  const snapshotDiffsBySnapshotId = useMemo(() => {
    if (designSnapshots.length === 0) return null;
    const byId = new Map<string, DesignSnapshot>();
    for (const s of designSnapshots) byId.set(s.id, s);
    const out: Record<string, ReadonlyArray<string>> = {};
    for (const snap of designSnapshots) {
      const parent = snap.parentId !== null ? (byId.get(snap.parentId) ?? null) : null;
      const lines = summarizeSnapshotDiff(parent?.artifactSource ?? null, snap.artifactSource);
      if (lines.length > 0) out[snap.id] = lines;
    }
    return out;
  }, [designSnapshots]);

  const conversationTabs = useMemo<ConversationTab[]>(() => {
    const ids = new Set<number>([currentChatSessionId]);
    for (const msg of chatMessages) ids.add(msg.sessionId ?? 0);
    return [...ids]
      .sort((a, b) => a - b)
      .map((sessionId, index) => {
        const firstUser = chatMessages.find(
          (msg) => (msg.sessionId ?? 0) === sessionId && msg.kind === 'user',
        );
        const rawTitle =
          (firstUser?.payload as { text?: string } | null | undefined)?.text?.trim() ?? '';
        const fallback = t('chat.newSession.tabFallback', { number: String(index + 1) });
        const title = rawTitle.length > 0 ? rawTitle : fallback;
        return {
          sessionId,
          label:
            rawTitle.length > 0
              ? rawTitle.length > 24
                ? `${rawTitle.slice(0, 24).trim()}...`
                : rawTitle
              : fallback,
          title,
        };
      });
  }, [chatMessages, currentChatSessionId, t]);

  const visibleChatMessages = useMemo(
    () => chatMessages.filter((msg) => (msg.sessionId ?? 0) === currentChatSessionId),
    [chatMessages, currentChatSessionId],
  );

  // plan0305 P3.2 — running design total ("$0.34 across 4 runs"). Re-fetched
  // when the active design changes or a generation just completed; bypassed
  // during streaming so we don't churn the renderer on every token.
  const [designCostUsd, setDesignCostUsd] = useState<{ total: number; runs: number } | null>(null);
  useEffect(() => {
    if (!currentDesignId || isGenerating) return;
    const codesign = window.codesign;
    if (codesign === undefined) return;
    let cancelled = false;
    void codesign
      .getDesignUsage(currentDesignId)
      .then((u: { costUsd: number; runs: number }) => {
        if (cancelled) return;
        setDesignCostUsd(u.runs > 0 ? { total: u.costUsd, runs: u.runs } : null);
      })
      .catch(() => {
        // Silent — the footer is decorative, not load-bearing.
      });
    return () => {
      cancelled = true;
    };
  }, [currentDesignId, isGenerating]);

  return (
    <aside
      className="flex flex-col h-full overflow-x-hidden border-r border-[var(--color-border)] bg-[var(--color-background-secondary)]"
      style={{ minHeight: 0, minWidth: 0 }}
      aria-label={t('sidebar.ariaLabel')}
    >
      {/* Header — clean, no collapse */}
      <div className="h-[var(--space-3)] shrink-0" />
      {/* In-design conversation tabs. A new conversation stays inside the
          same project/design but gets its own active session pointer, so
          follow-up prompts only see the selected tab's transcript. */}
      {currentDesignId !== null && chatMessages.length > 0 ? (
        <div className="flex items-center gap-[var(--space-2)] px-[var(--space-4)] pb-[var(--space-2)]">
          <div
            className="min-w-0 flex-1 flex items-center gap-[4px] overflow-x-auto"
            role="tablist"
            aria-label={t('chat.newSession.tabsAria')}
          >
            {conversationTabs.map((tab) => {
              const active = tab.sessionId === currentChatSessionId;
              return (
                <button
                  key={tab.sessionId}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={isGenerating}
                  title={tab.title}
                  onClick={() => void switchChatSession(tab.sessionId)}
                  className={[
                    'inline-flex max-w-[150px] shrink-0 items-center gap-[5px] rounded-[var(--radius-2)] border px-[var(--space-2)] py-[3px] text-[11.5px] transition-colors disabled:opacity-50 disabled:pointer-events-none',
                    active
                      ? 'border-[var(--color-accent)]/45 bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                      : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-tertiary,_rgba(0,0,0,0.04))]',
                  ].join(' ')}
                >
                  <MessageSquare className="w-[12px] h-[12px] shrink-0" aria-hidden />
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void requestNewSession()}
            disabled={isGenerating}
            title={t('chat.newSession.tooltip')}
            aria-label={t('chat.newSession.label')}
            className="inline-flex items-center gap-[4px] rounded-[var(--radius-2)] px-[var(--space-2)] py-[2px] text-[var(--text-xs)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-tertiary,_rgba(0,0,0,0.04))] disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            <MessageSquarePlus className="w-[12px] h-[12px]" aria-hidden />
            <span>{t('chat.newSession.label')}</span>
          </button>
        </div>
      ) : null}

      <>
        {/* Chat scroll area */}
        <div className="flex-1 overflow-y-auto px-[var(--space-4)] py-[var(--space-4)]">
          <ChatStatusHeader />
          <ChatMessageList
            messages={visibleChatMessages}
            loading={!chatLoaded}
            isGenerating={isGenerating}
            pendingToolCalls={pendingToolCalls}
            snapshotDiffsBySnapshotId={snapshotDiffsBySnapshotId}
            streamingText={
              streamingAssistantText && streamingAssistantText.designId === currentDesignId
                ? streamingAssistantText.text
                : null
            }
            streamingThinking={
              streamingThinking && streamingThinking.designId === currentDesignId
                ? streamingThinking.text
                : null
            }
            streamingToolDraft={
              streamingToolDraft && streamingToolDraft.designId === currentDesignId
                ? { toolName: streamingToolDraft.toolName, bytes: streamingToolDraft.bytes }
                : null
            }
            empty={<EmptyState onPickStarter={handlePickStarter} />}
          />
        </div>

        {/* Skill chips + prompt input + model/tokens line */}
        <div className="border-t border-[var(--color-border-subtle)] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-3)] space-y-[10px] bg-[var(--color-background-secondary)]">
          <CommentChipBar />
          {escalationHint !== null ? (
            <EscalationHint
              hint={escalationHint}
              onOpenSettings={() => openSettingsTab('models')}
            />
          ) : null}
          <PromptInput
            ref={promptInputRef}
            prompt={prompt}
            setPrompt={setPrompt}
            onSubmit={onSubmit}
            onCancel={cancelGeneration}
            onWrapUp={() => void requestWrapUp()}
            isGenerating={isGenerating}
            contextSummary={
              contextItems.length > 0 ? (
                <div className="flex flex-wrap gap-[8px]">
                  {inputFiles.map((file) => (
                    <span
                      key={file.path}
                      className="inline-flex max-w-full items-center gap-[6px] rounded-full border border-[var(--color-border)] bg-[var(--color-background-secondary)] px-[10px] py-[5px] text-[11px] text-[var(--color-text-secondary)]"
                      title={file.path}
                    >
                      <ContextIcon icon="file" />
                      <span className="truncate max-w-[180px]">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeInputFile(file.path)}
                        aria-label={t('sidebar.removeFile', { name: file.name })}
                        className="inline-flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                      >
                        <X className="w-3 h-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                  {referenceUrl.trim() ? (
                    <span
                      className="inline-flex max-w-full items-center gap-[6px] rounded-full border border-[var(--color-border)] bg-[var(--color-background-secondary)] px-[10px] py-[5px] text-[11px] text-[var(--color-text-secondary)]"
                      title={referenceUrl.trim()}
                    >
                      <ContextIcon icon="url" />
                      <span className="truncate max-w-[220px]">{referenceUrl.trim()}</span>
                    </span>
                  ) : null}
                  {designSystem ? (
                    <span
                      className="inline-flex max-w-full items-center gap-[6px] rounded-full border border-[var(--color-border)] bg-[var(--color-background-secondary)] px-[10px] py-[5px] text-[11px] text-[var(--color-text-secondary)]"
                      title={designSystem.rootPath}
                    >
                      <ContextIcon icon="designSystem" />
                      <span className="truncate max-w-[220px]">{designSystem.summary}</span>
                      <button
                        type="button"
                        onClick={() => {
                          void clearDesignSystem();
                        }}
                        aria-label={t('sidebar.clear')}
                        className="inline-flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                      >
                        <X className="w-3 h-3" aria-hidden />
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null
            }
            leadingAction={
              <AddMenu
                onAttachFiles={() => {
                  void pickInputFiles();
                }}
                onLinkDesignSystem={() => {
                  void pickDesignSystemDirectory();
                }}
                referenceUrl={referenceUrl}
                onReferenceUrlChange={setReferenceUrl}
                hasDesignSystem={Boolean(designSystem)}
                disabled={isGenerating}
              />
            }
          />
          <div className="flex items-center justify-between gap-[var(--space-2)] px-[2px]">
            <div className="flex min-w-0 items-center gap-[var(--space-2)]">
              {currentDesignId !== null ? (
                <button
                  type="button"
                  onClick={() => void exportDebugHandoff(currentChatSessionId)}
                  disabled={!chatLoaded}
                  title={t('chat.debugExport.tooltip')}
                  aria-label={t('chat.debugExport.label')}
                  className="inline-flex h-[24px] shrink-0 items-center gap-[5px] rounded-[var(--radius-2)] px-[var(--space-2)] text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-tertiary,_rgba(0,0,0,0.04))] disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  <Download className="w-[12px] h-[12px]" aria-hidden />
                  <span className="truncate">{t('chat.debugExport.shortLabel')}</span>
                </button>
              ) : null}
              <ModelSwitcher variant="sidebar" />
            </div>
            <div
              className="flex shrink-0 items-center gap-[var(--space-2)] tabular-nums text-[10.5px] text-[var(--color-text-muted)]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {lastTokens !== null ? (
                <span>{t('sidebar.chat.tokensLine', { count: lastTokens })}</span>
              ) : null}
              {cacheHitRate !== null ? (
                <span title="Cache hit rate on the last run (cached_input_tokens / input_tokens). Higher is cheaper.">
                  {`cache ${(cacheHitRate * 100).toFixed(0)}%`}
                </span>
              ) : null}
              {designCostUsd !== null ? (
                <span title={t('sidebar.chat.designCostTooltip', { runs: designCostUsd.runs })}>
                  {`$${designCostUsd.total < 0.01 ? designCostUsd.total.toFixed(4) : designCostUsd.total.toFixed(2)}`}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </>
    </aside>
  );
}
