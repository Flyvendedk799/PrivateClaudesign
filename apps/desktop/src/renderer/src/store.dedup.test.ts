/**
 * Gameimprove §4 — sendPrompt drops near-duplicate adjacent submissions
 * so a double-click or auto-retry doesn't waste a full agent run on the
 * same brief (BRAWL ARENA seq 0 + seq 2).
 */

import type { ChatMessageRow } from '@open-codesign/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodesignStore } from './store';

const RESET = useCodesignStore.getState();

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useCodesignStore.setState({ ...RESET, isGenerating: false }, true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedChatWithUserPrompt(designId: string, text: string, ageMs = 5000) {
  const row: ChatMessageRow = {
    schemaVersion: 2,
    id: 1,
    designId,
    seq: 0,
    kind: 'user',
    payload: { text },
    snapshotId: null,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
  };
  useCodesignStore.setState({
    currentDesignId: designId,
    chatMessages: [row],
    config: {
      provider: 'anthropic',
      modelPrimary: 'claude-sonnet-4-6',
      hasKey: true,
      pricing: null,
      onboarded: true,
      designSystem: null,
    } as never,
    configLoaded: true,
  });
}

describe('sendPrompt dedup (Gameimprove §4)', () => {
  it('skips when the new prompt matches the most recent user message within 60s', async () => {
    const generate = vi.fn();
    vi.stubGlobal('window', { codesign: { generate } });
    seedChatWithUserPrompt('design-1', 'create a topview 3d fighting game');

    await useCodesignStore.getState().sendPrompt({ prompt: 'create a topview 3d fighting game' });

    expect(generate).not.toHaveBeenCalled();
    // A toast should have been pushed to surface the skip to the user.
    const toasts = useCodesignStore.getState().toasts;
    expect(toasts.some((t) => t.variant === 'info')).toBe(true);
  });

  it('does NOT skip when the prompt differs even slightly', async () => {
    const generate = vi.fn();
    vi.stubGlobal('window', { codesign: { generate } });
    seedChatWithUserPrompt('design-1', 'create a topview 3d fighting game');

    await useCodesignStore
      .getState()
      .sendPrompt({ prompt: 'create a topview 3d fighting game please' });

    // Dedup did NOT fire (different text). Other gates may abort the
    // run later — we only assert no dedup-info toast was pushed.
    const dedupToast = useCodesignStore
      .getState()
      .toasts.find((t) => t.variant === 'info' && t.title.includes('Identical prompt'));
    expect(dedupToast).toBeUndefined();
  });

  it('does NOT skip when the prior user message is older than 60s', async () => {
    const generate = vi.fn();
    vi.stubGlobal('window', { codesign: { generate } });
    seedChatWithUserPrompt('design-1', 'same prompt', 90_000);

    await useCodesignStore.getState().sendPrompt({ prompt: 'same prompt' });

    const dedupToast = useCodesignStore
      .getState()
      .toasts.find((t) => t.variant === 'info' && t.title.includes('Identical prompt'));
    expect(dedupToast).toBeUndefined();
  });

  it('does NOT skip silent submissions (auto-polish path)', async () => {
    const generate = vi.fn();
    vi.stubGlobal('window', { codesign: { generate } });
    seedChatWithUserPrompt('design-1', 'auto-polish injected text');

    await useCodesignStore
      .getState()
      .sendPrompt({ prompt: 'auto-polish injected text', silent: true });

    const dedupToast = useCodesignStore
      .getState()
      .toasts.find((t) => t.variant === 'info' && t.title.includes('Identical prompt'));
    expect(dedupToast).toBeUndefined();
  });

  it('does NOT skip when _autoRetried is set (transient-cut retry path)', async () => {
    const generate = vi.fn();
    vi.stubGlobal('window', { codesign: { generate } });
    seedChatWithUserPrompt('design-1', 'retried prompt');

    await useCodesignStore.getState().sendPrompt({ prompt: 'retried prompt', _autoRetried: true });

    const dedupToast = useCodesignStore
      .getState()
      .toasts.find((t) => t.variant === 'info' && t.title.includes('Identical prompt'));
    expect(dedupToast).toBeUndefined();
  });

  it('does NOT skip when skipPromptAssist resumes the dialog flow', async () => {
    const generate = vi.fn();
    vi.stubGlobal('window', { codesign: { generate } });
    seedChatWithUserPrompt('design-1', 'first attempt');

    await useCodesignStore
      .getState()
      .sendPrompt({ prompt: 'first attempt', skipPromptAssist: true });

    const dedupToast = useCodesignStore
      .getState()
      .toasts.find((t) => t.variant === 'info' && t.title.includes('Identical prompt'));
    expect(dedupToast).toBeUndefined();
  });
});
