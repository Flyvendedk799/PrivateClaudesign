/**
 * Tests for the wall_clock graceful-checkpoint code path in
 * `generateViaAgent` (packages/core/src/agent.ts). The 2026-04-26 latency
 * work made wall_clock budget exhaustion graceful (returns the partial
 * artifact + a "Paused" hint) while leaving tool_calls budget HARD (still
 * throws). Without these tests a regression in the `isWallClockCheckpoint`
 * branch would silently turn real errors into "successful" partial
 * results — high-blast-radius silent failure.
 *
 * Coverage:
 * - wall_clock budget fires → no throw, message includes "Paused after"
 * - tool_calls budget fires → still throws AGENT_BUDGET_EXCEEDED
 * - user signal abort (no budget) → throws (non-budget abort)
 */

import type { ModelRef } from '@open-codesign/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted lets the mock factory and the test share module-level state
// despite the factory being hoisted to the top of the file.
const mockState = vi.hoisted(() => ({
  pendingPromptResolver: null as (() => void) | null,
  stopReason: 'stop' as 'stop' | 'aborted',
  emitToolBeforeAbort: false,
  // When true, emit periodic turn_end events so consumers using the
  // deferred-abort pattern (real agent.ts wall_clock branch) can hook
  // on a turn_end after their budget timer fires.
  heartbeat: false,
}));

vi.mock('@mariozechner/pi-agent-core', () => {
  type Listener = (e: unknown) => void;
  class MockAgent {
    readonly state: { messages: unknown[] };
    private readonly listeners: Listener[] = [];

    constructor(options: { initialState?: { messages?: unknown[] } }) {
      const seed = options.initialState?.messages ?? [];
      this.state = { messages: [...seed] };
    }

    subscribe(listener: Listener): () => void {
      this.listeners.push(listener);
      return () => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      };
    }

    async prompt(message: unknown): Promise<void> {
      this.emit({ type: 'agent_start' });
      this.emit({ type: 'turn_start' });
      this.state.messages.push({
        role: 'user',
        content: typeof message === 'string' ? message : '',
        timestamp: 1,
      });

      return new Promise<void>((resolve) => {
        let heartbeat: ReturnType<typeof setInterval> | null = null;

        // Wire the resolver up FIRST so a synchronous abort() (e.g. from
        // a tool_calls subscriber firing inside emit() below) can find it.
        mockState.pendingPromptResolver = () => {
          mockState.pendingPromptResolver = null;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          const assistantMsg = {
            role: 'assistant',
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'mock',
            content: [{ type: 'text', text: 'partial work landed' }],
            usage: {
              input: 100,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 150,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: mockState.stopReason,
            timestamp: 2,
          };
          this.state.messages.push(assistantMsg);
          this.emit({ type: 'turn_end', message: assistantMsg, toolResults: [] });
          this.emit({ type: 'agent_end', messages: this.state.messages });
          resolve();
        };

        // Simulate "tool call" emission for tests that exercise the
        // tool_calls budget. Real code's subscription (agent.ts ~905)
        // increments toolCallCount and aborts when it exceeds maxToolCalls.
        // The abort fires synchronously here and finds pendingPromptResolver
        // already set (above).
        if (mockState.emitToolBeforeAbort) {
          this.emit({
            type: 'tool_execution_start',
            toolCallId: 'mock-tool-1',
            toolName: 'mock_tool',
            args: {},
          });
        }

        // Heartbeat turn_end emissions so the deferred-abort hook in real
        // code (agent.ts ~924, "abort at next turn_end") can fire after
        // its wall_clock budget timer trips. Without this the mock would
        // park forever and a deferred-abort would never land.
        if (mockState.heartbeat) {
          heartbeat = setInterval(() => {
            const intermediateMsg = {
              role: 'assistant',
              api: 'anthropic-messages',
              provider: 'anthropic',
              model: 'mock',
              content: [{ type: 'text', text: '' }],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'toolUse',
              timestamp: Date.now(),
            };
            this.emit({ type: 'turn_end', message: intermediateMsg, toolResults: [] });
          }, 5);
        }
      });
    }

    async waitForIdle(): Promise<void> {}

    /** Stub for agent.steer(): real code calls this from the budget-
     *  awareness branch in agent.ts (60% / 90% nudges). The mock just
     *  swallows the steering message — tests assert downstream end
     *  state, not steering injection. */
    steer(): void {}

    abort(): void {
      mockState.stopReason = 'aborted';
      const resolver = mockState.pendingPromptResolver;
      mockState.pendingPromptResolver = null;
      resolver?.();
    }

    private emit(e: unknown): void {
      for (const l of this.listeners) l(e);
    }
  }
  return { Agent: MockAgent };
});

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: (provider: string, modelId: string) => ({
    id: modelId,
    name: modelId,
    api: 'anthropic-messages',
    provider,
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  }),
}));

vi.mock('@open-codesign/providers', async () => {
  const actual = await vi.importActual<typeof import('@open-codesign/providers')>(
    '@open-codesign/providers',
  );
  return {
    ...actual,
    complete: vi.fn(),
    completeWithRetry: (
      _model: unknown,
      _messages: unknown,
      _opts: unknown,
      _retryOpts: unknown,
      impl: (...args: unknown[]) => unknown,
    ) => impl(_model, _messages, _opts),
  };
});

import { generateViaAgent } from './index.js';

const MODEL: ModelRef = { provider: 'anthropic', modelId: 'claude-sonnet-4-6' };

beforeEach(() => {
  mockState.pendingPromptResolver = null;
  mockState.stopReason = 'stop';
  mockState.emitToolBeforeAbort = false;
  mockState.heartbeat = false;
});

describe('generateViaAgent — graceful wall_clock checkpoint', () => {
  it('returns partial GenerateOutput with "Paused after" message when wall_clock fires', async () => {
    // Tiny budget — the agent.ts setTimeout fires almost immediately and
    // sets the deferred-abort flag. The mock's heartbeat then emits a
    // turn_end which the deferred-abort consumer hooks; that fires
    // agent.abort(); the mock's abort resolves the prompt with
    // stopReason='aborted', and the real code falls through to
    // parse_response instead of throwing.
    mockState.heartbeat = true;
    const result = await generateViaAgent({
      prompt: 'design something long',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
      agentBudget: { maxWallClockMs: 20 },
    });
    expect(result).toBeDefined();
    expect(result.message).toMatch(/Paused after/);
    // The structured flag is what auto-continue (Step 5) keys off — assert
    // it explicitly, not just the appended prose hint.
    expect(result.interrupted).toBe(true);
    // Output token bookkeeping should still surface (aggregated from the
    // mock assistant message's usage block).
    expect(result.outputTokens).toBe(50);
  });

  it('still throws AGENT_BUDGET_EXCEEDED on tool_calls overrun', async () => {
    // maxToolCalls: 0 → real code aborts on the first tool_execution_start
    // with budgetReason='tool_calls'. Mock emits one tool_execution_start
    // before parking, so the subscriber fires and triggers the cap.
    mockState.emitToolBeforeAbort = true;
    await expect(
      generateViaAgent({
        prompt: 'runaway prompt',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
        agentBudget: { maxToolCalls: 0, maxWallClockMs: 60_000 },
      }),
    ).rejects.toThrow(/safety budget.*tool_calls/);
  });

  it('throws on non-budget user-signal abort (no graceful checkpoint)', async () => {
    // User-initiated cancel → input.signal aborts → real code calls
    // agent.abort() with budgetReason still null. The catch-block else
    // branch should propagate the failure instead of treating it as a
    // checkpoint.
    const controller = new AbortController();
    // Abort after a tick so the run starts before the signal fires; that
    // keeps the failure path through the run-failure branch (not the
    // pre-flight `signal.aborted` short-circuit).
    setTimeout(() => controller.abort(), 5);
    await expect(
      generateViaAgent({
        prompt: 'will be cancelled',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
        signal: controller.signal,
        // Wall clock comfortably beyond the test's 5ms abort, so wall_clock
        // can NOT fire first.
        agentBudget: { maxWallClockMs: 60_000 },
      }),
    ).rejects.toBeDefined();
  });
});
