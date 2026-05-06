import type { AgentEvent, AgentMessage, AgentOptions } from '@mariozechner/pi-agent-core';
import type { LoadedSkill, ModelRef } from '@open-codesign/shared';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadBuiltinSkillsMock = vi.fn(async (): Promise<LoadedSkill[]> => []);

/** Captured constructor options + prompt calls for the mocked Agent. */
interface AgentCall {
  options: AgentOptions;
  prompts: Array<{ message: unknown }>;
  listeners: Array<(e: AgentEvent) => void>;
  aborted: boolean;
  /** Improver1 §3 — captured agent.steer() calls so tests can assert
   *  the stuck-detector emitted the right reminder. */
  steers: Array<{ role: string; content: string; timestamp: number }>;
}

const agentCalls: AgentCall[] = [];

/** Scripted per-test: what the Agent should emit via its subscribe listener
 *  and what assistant content should end up in state.messages after prompt(). */
interface AgentScript {
  events?: AgentEvent[];
  assistantText: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason?: 'stop' | 'error' | 'aborted';
  errorMessage?: string;
  promptThrows?: Error;
  /**
   * When > 0, `promptThrows` is thrown only on the first N prompt() calls;
   * subsequent calls resolve normally. Lets tests script "transient failure
   * then success" sequences for first-turn retry coverage.
   */
  promptThrowsTimes?: number;
  /**
   * When true together with `promptThrows`, the mock pushes a partial
   * assistant message onto `agent.state.messages` BEFORE throwing on
   * each failing attempt. Simulates "model streamed tokens / tool call
   * then the connection dropped" — the real pi-agent-core path where a
   * retry at the outer send boundary would replay tool side effects.
   */
  promptPushesAssistantBeforeThrow?: boolean;
  /**
   * When set, the mock invokes `options.getApiKey` before emitting the
   * assistant response and — if it throws — converts the throw into an
   * 'error' AgentMessage (matching pi-agent-core's `handleRunFailure`
   * behavior that flattens getApiKey throws into `errorMessage: string`).
   */
  invokeGetApiKey?: boolean;
  /**
   * When set, the first N prompt() calls push a stopReason='error' assistant
   * message with `streamErrorMessage` instead of the normal success message.
   * Mirrors pi-agent-core's behaviour of swallowing stream-level upstream
   * failures (Anthropic 529 / 429) into the final assistant message.
   * Subsequent calls fall through to the normal success path.
   */
  streamErrorTimes?: number;
  streamErrorMessage?: string;
}

let scriptedAgent: AgentScript = { assistantText: '' };

vi.mock('@mariozechner/pi-agent-core', () => {
  class MockAgent {
    readonly state: { messages: AgentMessage[] };
    private readonly call: AgentCall;
    constructor(options: AgentOptions) {
      this.call = { options, prompts: [], listeners: [], aborted: false, steers: [] };
      agentCalls.push(this.call);
      const seed = (options.initialState?.messages ?? []) as AgentMessage[];
      this.state = { messages: [...seed] };
    }
    subscribe(listener: (e: AgentEvent, signal?: AbortSignal) => void): () => void {
      this.call.listeners.push((e) => listener(e));
      return () => {};
    }
    async prompt(message: unknown): Promise<void> {
      this.call.prompts.push({ message });
      if (scriptedAgent.promptThrows) {
        const limit = scriptedAgent.promptThrowsTimes ?? Number.POSITIVE_INFINITY;
        if (this.call.prompts.length <= limit) {
          if (scriptedAgent.promptPushesAssistantBeforeThrow) {
            const partial: AgentMessage = {
              role: 'assistant',
              // biome-ignore lint/suspicious/noExplicitAny: same.
              api: 'anthropic-messages' as any,
              // biome-ignore lint/suspicious/noExplicitAny: same.
              provider: 'anthropic' as any,
              model: 'mock-model',
              content: [{ type: 'text', text: 'partial tokens before drop' }],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'error',
              timestamp: Date.now(),
            };
            this.state.messages.push(partial);
          }
          throw scriptedAgent.promptThrows;
        }
      }

      // Simulate pi-agent-core's per-turn getApiKey invocation. Real
      // runAgentLoop calls `await config.getApiKey(provider)` (line 156 of
      // agent-loop.js); if that rejects, `runWithLifecycle` catches it and
      // emits a failure AgentMessage with just `errorMessage: string` —
      // which is why our code captures the original throw in a closure.
      if (scriptedAgent.invokeGetApiKey && this.call.options.getApiKey) {
        try {
          await this.call.options.getApiKey('test-provider');
        } catch (err) {
          const failMsg: AgentMessage = {
            role: 'assistant',
            // biome-ignore lint/suspicious/noExplicitAny: mock literal union.
            api: 'anthropic-messages' as any,
            // biome-ignore lint/suspicious/noExplicitAny: same.
            provider: 'anthropic' as any,
            model: 'mock-model',
            content: [{ type: 'text', text: '' }],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          };
          this.state.messages.push(failMsg);
          this.emit({ type: 'agent_end', messages: [failMsg] });
          return;
        }
      }

      // Stream-level error simulation: pi-agent-core flattens upstream stream
      // failures (Anthropic 529 / 429 etc.) into a final assistant message
      // with stopReason='error' rather than throwing. Returning early here —
      // BEFORE pushing the user message — means the only newly-added entry is
      // the error itself, which is the exact precondition our agent.ts code
      // requires to lift the error into a retryable throw.
      if (
        scriptedAgent.streamErrorTimes !== undefined &&
        this.call.prompts.length <= scriptedAgent.streamErrorTimes
      ) {
        const errorMsg: AgentMessage = {
          role: 'assistant',
          // biome-ignore lint/suspicious/noExplicitAny: same as below.
          api: 'anthropic-messages' as any,
          // biome-ignore lint/suspicious/noExplicitAny: same.
          provider: 'anthropic' as any,
          model: 'mock-model',
          content: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error',
          errorMessage: scriptedAgent.streamErrorMessage ?? 'stream error',
          timestamp: Date.now(),
        };
        this.state.messages.push(errorMsg);
        this.emit({ type: 'agent_end', messages: [errorMsg] });
        return;
      }

      this.emit({ type: 'agent_start' });
      this.emit({ type: 'turn_start' });
      const userMsg: AgentMessage = {
        role: 'user',
        content: typeof message === 'string' ? message : '',
        timestamp: Date.now(),
      };
      this.state.messages.push(userMsg);
      this.emit({ type: 'message_start', message: userMsg });
      this.emit({ type: 'message_end', message: userMsg });

      const assistantMsg: AgentMessage = {
        role: 'assistant',
        // biome-ignore lint/suspicious/noExplicitAny: matches pi-ai Api/Provider literal unions in mocks.
        api: 'anthropic-messages' as any,
        // biome-ignore lint/suspicious/noExplicitAny: same.
        provider: 'anthropic' as any,
        model: 'mock-model',
        content: [{ type: 'text', text: scriptedAgent.assistantText }],
        usage: scriptedAgent.usage ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: scriptedAgent.stopReason ?? 'stop',
        ...(scriptedAgent.errorMessage ? { errorMessage: scriptedAgent.errorMessage } : {}),
        timestamp: Date.now(),
      };
      this.state.messages.push(assistantMsg);

      for (const e of scriptedAgent.events ?? []) this.emit(e);
      this.emit({
        type: 'message_update',
        message: assistantMsg,
        // biome-ignore lint/suspicious/noExplicitAny: AssistantMessageEvent shape not re-exported.
        assistantMessageEvent: { type: 'text_delta', delta: scriptedAgent.assistantText } as any,
      });
      this.emit({ type: 'message_end', message: assistantMsg });
      this.emit({ type: 'turn_end', message: assistantMsg, toolResults: [] });
      this.emit({ type: 'agent_end', messages: this.state.messages });
    }
    async waitForIdle(): Promise<void> {
      // no-op in mock
    }
    abort(): void {
      this.call.aborted = true;
    }
    steer(msg: { role: string; content: string; timestamp: number }): void {
      this.call.steers.push(msg);
    }
    private emit(e: AgentEvent): void {
      for (const l of this.call.listeners) l(e);
    }
  }
  return { Agent: MockAgent };
});

vi.mock('./skills/loader.js', async () => {
  const actual = await vi.importActual<typeof import('./skills/loader.js')>('./skills/loader.js');
  return {
    ...actual,
    loadBuiltinSkills: () => loadBuiltinSkillsMock(),
  };
});

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: (provider: string, modelId: string) => ({
    id: modelId,
    name: modelId,
    api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    provider,
    baseUrl: provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
    reasoning: true,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  }),
}));

import { generateViaAgent } from './agent.js';

const MODEL: ModelRef = { provider: 'anthropic', modelId: 'claude-sonnet-4-6' };

const SAMPLE_HTML = `<!doctype html><html lang="en"><body><h1>Hi</h1></body></html>`;
const RESPONSE_WITH_ARTIFACT = `Here is your design.

<artifact identifier="design-1" type="html" title="Hello world">
${SAMPLE_HTML}
</artifact>`;

beforeEach(() => {
  agentCalls.length = 0;
  scriptedAgent = { assistantText: '' };
  loadBuiltinSkillsMock.mockReset();
  loadBuiltinSkillsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('generateViaAgent() — Phase 1 pass-through', () => {
  it('throws CodesignError on empty prompt (matches generate())', async () => {
    await expect(
      generateViaAgent({ prompt: '  ', history: [], model: MODEL, apiKey: 'sk-test' }),
    ).rejects.toBeInstanceOf(CodesignError);
    expect(agentCalls).toHaveLength(0);
  });

  it('throws INPUT_UNSUPPORTED_MODE when mode is not create (no systemPrompt)', async () => {
    await expect(
      generateViaAgent({
        prompt: 'tweak my design',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
        // Cast: type narrows to 'create' at compile time; runtime guard checks the
        // non-create branch explicitly.
        mode: 'tweak' as 'create',
      }),
    ).rejects.toMatchObject({ code: 'INPUT_UNSUPPORTED_MODE' });
  });

  it('constructs an Agent with empty tools, system prompt, and supplied history', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent(
      {
        prompt: 'design a landing page',
        history: [{ role: 'user', content: 'prior turn' }],
        model: MODEL,
        apiKey: 'sk-test',
      },
      // Opt out of the default toolset so this test continues to pin the
      // Phase 1 zero-tool shape of the Agent init state.
      { tools: [] },
    );

    expect(agentCalls).toHaveLength(1);
    const call = agentCalls[0];
    if (!call) throw new Error('expected agent call');
    const init = call.options.initialState;
    expect(init?.tools).toEqual([]);
    expect(init?.systemPrompt).toContain('open-codesign');
    expect(init?.messages).toHaveLength(1);
    const seed = init?.messages?.[0];
    expect(seed?.role).toBe('user');
  });

  it('forwards apiKey through getApiKey callback', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent({
      prompt: 'design a meditation app',
      history: [],
      model: MODEL,
      apiKey: 'sk-token-123',
    });

    const resolver = agentCalls[0]?.options.getApiKey;
    expect(resolver).toBeDefined();
    await expect(Promise.resolve(resolver?.('anthropic'))).resolves.toBe('sk-token-123');
  });

  it('prefers the dynamic input.getApiKey over the static apiKey when provided', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent({
      prompt: 'long-running agent task',
      history: [],
      model: MODEL,
      apiKey: 'stale-static-token',
      getApiKey: async () => 'fresh-rotating-token',
    });

    const resolver = agentCalls[0]?.options.getApiKey;
    // Each agent turn re-invokes the getter, so a rotated OAuth token picked
    // up by the token store reaches the next LLM round-trip without
    // recomputing anything from the IPC layer.
    await expect(Promise.resolve(resolver?.('openai-codex'))).resolves.toBe('fresh-rotating-token');
  });

  it('falls back to static apiKey when input.getApiKey returns an empty string', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent({
      prompt: 'fallback behavior',
      history: [],
      model: MODEL,
      apiKey: 'fallback-token',
      getApiKey: async () => '',
    });

    const resolver = agentCalls[0]?.options.getApiKey;
    await expect(Promise.resolve(resolver?.('openai-codex'))).resolves.toBe('fallback-token');
  });

  it('rethrows the original input.getApiKey error (preserves structured code)', async () => {
    // Simulates: user signs out of ChatGPT mid-agent-run. Token store throws
    // CodesignError(PROVIDER_AUTH_MISSING). Without the capture-and-rethrow
    // dance, pi-agent-core would flatten the throw into a plain errorMessage
    // string and our post-agent branch would re-wrap as PROVIDER_ERROR —
    // losing the code the renderer needs to show "sign in again".
    scriptedAgent = { assistantText: '', invokeGetApiKey: true };
    const authErr = new CodesignError('ChatGPT 订阅已失效', ERROR_CODES.PROVIDER_AUTH_MISSING);
    await expect(
      generateViaAgent({
        prompt: 'midrun logout scenario',
        history: [],
        model: MODEL,
        apiKey: 'already-expired',
        getApiKey: async () => {
          throw authErr;
        },
      }),
    ).rejects.toBe(authErr);
  });

  it('overrides pi-ai model baseUrl when input.baseUrl is provided', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent({
      prompt: 'design a landing page',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example.com/v1',
    });
    const model = agentCalls[0]?.options.initialState?.model as unknown as {
      baseUrl?: string;
    };
    expect(model?.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('extracts artifact and returns usage mapped from pi-ai assistant usage', async () => {
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      usage: {
        input: 42,
        output: 84,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 126,
        cost: { input: 0.0002, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.0012 },
      },
    };
    const result = await generateViaAgent({
      prompt: 'design a meditation app',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.id).toBe('design-1');
    expect(result.artifacts[0]?.content.trim()).toBe(SAMPLE_HTML);
    expect(result.message).toContain('Here is your design.');
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(84);
    expect(result.costUsd).toBeCloseTo(0.0012);
  });

  it('emits agent lifecycle events through onEvent subscriber in order', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    const seen: AgentEvent['type'][] = [];
    await generateViaAgent(
      {
        prompt: 'design a landing page',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      },
      { onEvent: (e) => seen.push(e.type) },
    );

    // Must start with agent_start/turn_start and end with agent_end.
    expect(seen[0]).toBe('agent_start');
    expect(seen[1]).toBe('turn_start');
    expect(seen).toContain('message_update');
    expect(seen[seen.length - 1]).toBe('agent_end');
  });

  it('propagates stopReason=error as a PROVIDER_ERROR via remap', async () => {
    scriptedAgent = {
      assistantText: '',
      stopReason: 'error',
      errorMessage: 'upstream blew up',
    };
    await expect(
      generateViaAgent({
        prompt: 'design a dashboard',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('upstream blew up') });
  });

  it('abort signal cascades into agent.abort()', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    const controller = new AbortController();
    const promise = generateViaAgent({
      prompt: 'design a dashboard',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
      signal: controller.signal,
    });
    controller.abort();
    // With first-turn withBackoff the pre-call signal check may short-circuit
    // the prompt entirely (throwing PROVIDER_ABORTED), or the prompt may have
    // already completed; either way the `signal → agent.abort()` listener
    // registered before sending should have fired.
    await promise.catch(() => {
      // Expected when abort arrives before the withBackoff loop enters its
      // first iteration.
    });
    expect(agentCalls[0]?.aborted).toBe(true);
  });

  it('reports skill-loader failure via warnings without blocking the artifact', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    loadBuiltinSkillsMock.mockRejectedValue(new Error('disk read failed'));
    const warnLogs: Array<{ msg: string; meta?: unknown }> = [];
    const logger = {
      info: () => {},
      warn: (msg: string, meta?: unknown) => {
        warnLogs.push({ msg, meta });
      },
      error: () => {},
    };
    const result = await generateViaAgent({
      prompt: 'make a dashboard',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
      logger,
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.stringContaining('Builtin skills unavailable: disk read failed'),
    ]);
    const warnEntry = warnLogs.find((entry) => entry.msg.includes('step=load_skills.fail'));
    expect(warnEntry).toBeDefined();
    expect(warnEntry?.meta).toMatchObject({
      errorClass: 'Error',
      message: 'disk read failed',
    });
  });

  it('returns no artifacts when prose contains a fenced ```html block but no <artifact> wrapper and no fs is provided', async () => {
    // Locks in the post-fallback contract: prose-only HTML is no longer
    // rescued. The host must rely on the text_editor + fs path.
    scriptedAgent = {
      assistantText: 'Here you go:\n\n```html\n<!doctype html><html><body>Hi</body></html>\n```',
    };
    const result = await generateViaAgent(
      {
        prompt: 'design a meditation app',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      },
      { tools: [] },
    );
    expect(result.artifacts).toHaveLength(0);
  });

  it('augments the system prompt with the file-output policy when tools are active', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent({
      prompt: 'design a landing page',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const sys = agentCalls[0]?.options.initialState?.systemPrompt as string;
    expect(sys).toContain('str_replace_based_edit_tool');
    // The slimmed AGENTIC_TOOL_GUIDANCE (2026-04-27) replaced the old
    // 'Do NOT emit `<artifact>`' phrasing with the tighter 'NEVER inline
    // source in prose'. Both intents are equivalent for the test.
    expect(sys).toContain('NEVER inline source in prose');
  });

  it('pins follow-up turns to str_replace (no text_editor.create on existing files)', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent({
      prompt: 'tweak the hero copy',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const sys = agentCalls[0]?.options.initialState?.systemPrompt as string;
    // Slimmed phrasing: "Follow-up turns" header is gone, replaced with
    // a single bullet. The intent ("don't recreate, use str_replace")
    // is now expressed as "use `str_replace`, NEVER `create`".
    expect(sys).toMatch(/Follow-up turns when `index\.html` already exists/);
    expect(sys).toContain('NEVER `create`');
    expect(sys).toContain('start over');
  });

  it('adds explicit bitmap trigger guidance when image asset tool is enabled', async () => {
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    await generateViaAgent(
      {
        prompt: 'design a landing page with a hand-painted background illustration',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      },
      {
        generateImageAsset: async () => ({
          path: 'assets/hero.png',
          dataUrl: 'data:image/png;base64,aW1n',
          mimeType: 'image/png',
          model: 'gpt-image-2',
          provider: 'openai',
        }),
      },
    );
    const sys = agentCalls[0]?.options.initialState?.systemPrompt as string;
    expect(sys).toContain('MANDATORY asset inventory');
    expect(sys).toContain('One call per named asset');
    expect(sys).toContain("`purpose='logo'`");
  });
});

describe('generateViaAgent() — first-turn retry', () => {
  class HttpError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = 'HttpError';
    }
  }

  it('retries a transient 500 on the first turn and resolves on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      scriptedAgent = {
        assistantText: RESPONSE_WITH_ARTIFACT,
        promptThrows: new HttpError('upstream 500', 500),
        promptThrowsTimes: 1,
      };
      const onRetry = vi.fn();
      const promise = generateViaAgent(
        {
          prompt: 'design a meditation app',
          history: [],
          model: MODEL,
          apiKey: 'sk-test',
        },
        { onRetry },
      );
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.artifacts).toHaveLength(1);
      expect(agentCalls[0]?.prompts.length).toBe(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry.mock.calls[0]?.[0].reason).toMatch(/server error/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws after three consecutive 500s on the first turn (retries exhausted)', async () => {
    vi.useFakeTimers();
    try {
      scriptedAgent = {
        assistantText: '',
        promptThrows: new HttpError('still down', 500),
      };
      const promise = generateViaAgent({
        prompt: 'design a dashboard',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      });
      // Swallow the expected rejection while we drain timers so the test
      // does not surface it as an unhandled promise.
      const settled = promise.catch((err: unknown) => ({ rejected: err }));
      await vi.runAllTimersAsync();
      const outcome = (await settled) as { rejected?: unknown };
      expect(outcome.rejected).toBeDefined();
      expect(agentCalls[0]?.prompts.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry 4xx client errors (no 401 replay)', async () => {
    scriptedAgent = {
      assistantText: '',
      promptThrows: new HttpError('unauthorized', 401),
    };
    await expect(
      generateViaAgent({
        prompt: 'design a dashboard',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      }),
    ).rejects.toBeTruthy();
    expect(agentCalls[0]?.prompts.length).toBe(1);
  });

  it('lifts a stream-level overloaded_error into a retryable throw and succeeds on the second attempt', async () => {
    // pi-agent-core flattens upstream stream errors into a stopReason='error'
    // assistant message instead of throwing. Without lifting, withBackoff
    // never sees the failure and the user gets a one-shot 529 in the dialog.
    vi.useFakeTimers();
    try {
      scriptedAgent = {
        assistantText: RESPONSE_WITH_ARTIFACT,
        streamErrorTimes: 1,
        streamErrorMessage:
          '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_xyz"}',
      };
      const onRetry = vi.fn();
      const promise = generateViaAgent(
        {
          prompt: 'design a meditation app',
          history: [],
          model: MODEL,
          apiKey: 'sk-test',
        },
        { onRetry },
      );
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.artifacts).toHaveLength(1);
      expect(agentCalls[0]?.prompts.length).toBe(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry.mock.calls[0]?.[0].reason).toMatch(/server error \(529\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lifts a stream-level rate_limit_error into a retryable throw', async () => {
    vi.useFakeTimers();
    try {
      scriptedAgent = {
        assistantText: RESPONSE_WITH_ARTIFACT,
        streamErrorTimes: 1,
        streamErrorMessage: '{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}',
      };
      const onRetry = vi.fn();
      const promise = generateViaAgent(
        {
          prompt: 'design a dashboard',
          history: [],
          model: MODEL,
          apiKey: 'sk-test',
        },
        { onRetry },
      );
      await vi.runAllTimersAsync();
      await promise;
      expect(agentCalls[0]?.prompts.length).toBe(2);
      expect(onRetry.mock.calls[0]?.[0].reason).toMatch(/rate-limited \(429\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a stream-level authentication_error (4xx)', async () => {
    scriptedAgent = {
      assistantText: '',
      streamErrorTimes: 5,
      streamErrorMessage:
        '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}',
    };
    await expect(
      generateViaAgent({
        prompt: 'design a dashboard',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_MISSING' });
    expect(agentCalls[0]?.prompts.length).toBe(1);
  });

  it('does not retry once the agent has produced an assistant message (side-effect guard)', async () => {
    // First-turn + transient 500, BUT the mock pushes a partial assistant
    // message before throwing, simulating "model already emitted tokens /
    // tool calls before the connection dropped". Replaying would re-run
    // any text_editor / set_todos side effects, so retry must be blocked
    // regardless of the HTTP status. A single attempt is the only safe move.
    scriptedAgent = {
      assistantText: '',
      promptThrows: new HttpError('upstream 500', 500),
      promptPushesAssistantBeforeThrow: true,
    };
    await expect(
      generateViaAgent({
        prompt: 'design a dashboard',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      }),
    ).rejects.toBeTruthy();
    expect(agentCalls[0]?.prompts.length).toBe(1);
  });

  it('does not retry when history is non-empty (protects multi-turn agent state)', async () => {
    scriptedAgent = {
      assistantText: '',
      promptThrows: new HttpError('upstream 500', 500),
    };
    await expect(
      generateViaAgent({
        prompt: 'refine this',
        history: [
          { role: 'user', content: 'first request' },
          { role: 'assistant', content: 'first reply' },
        ],
        model: MODEL,
        apiKey: 'sk-test',
      }),
    ).rejects.toBeTruthy();
    // Single attempt: replaying a partial multi-turn session would corrupt
    // tool state, so the second+ turn must surface transient errors directly.
    expect(agentCalls[0]?.prompts.length).toBe(1);
  });
});

describe('generateViaAgent() — per-run safety budget', () => {
  it('aborts and throws AGENT_BUDGET_EXCEEDED when tool-call budget is exceeded', async () => {
    scriptedAgent = {
      assistantText: '',
      stopReason: 'aborted',
      events: [
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'text_editor', args: {} },
        { type: 'tool_execution_start', toolCallId: 't2', toolName: 'text_editor', args: {} },
      ],
    };
    await expect(
      generateViaAgent({
        prompt: 'design a dashboard',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
        agentBudget: { maxToolCalls: 1 },
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.AGENT_BUDGET_EXCEEDED });
    expect(agentCalls[0]?.aborted).toBe(true);
  });

  it('does NOT abort when tool-call count stays within budget', async () => {
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      events: [
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'text_editor', args: {} },
      ],
    };
    const result = await generateViaAgent({
      prompt: 'design a dashboard',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
      agentBudget: { maxToolCalls: 5 },
    });
    expect(result.artifacts).toHaveLength(1);
    expect(agentCalls[0]?.aborted).toBe(false);
  });
});

describe('generateViaAgent() — zero-output guard', () => {
  it('throws MODEL_RETURNED_ONLY_THINKING when assistant produced no text and no artifact', async () => {
    // The 2026-05-06 first-person shooter wave-defense run exhibited this:
    // 1 turn, 0 tool calls, 0 streamed text deltas, outputTokens hit the
    // 65,536 cap (model spent everything on extended thinking). Without
    // this guard, generate() returned `{ artifacts: [], message: "" }`
    // and the renderer happily rendered "Done" with an empty iframe.
    scriptedAgent = { assistantText: '' };
    await expect(
      generateViaAgent(
        {
          prompt: 'create a first-person shooter wave defense',
          history: [],
          model: MODEL,
          apiKey: 'sk-test',
        },
        { tools: [] },
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.MODEL_RETURNED_ONLY_THINKING });
  });

  it('does NOT throw when assistant produced text but no artifact', async () => {
    // Pure-text response without an <artifact> tag is still meaningful
    // output (e.g. a "here's the plan, ready to start?" first turn).
    // The guard should NOT fire — only the no-text + no-artifact case is
    // the runaway-thinking signature.
    scriptedAgent = { assistantText: 'Here is the design summary…' };
    const result = await generateViaAgent(
      {
        prompt: 'design a hero section',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      },
      { tools: [] },
    );
    expect(result.message).toContain('Here is the design summary');
    expect(result.artifacts).toHaveLength(0);
  });

  it('does NOT throw when assistant produced an artifact but no prose', async () => {
    // Tool-only run that delivered the artifact via the parser. Message
    // is empty but `collected.artifacts.length > 0` keeps the guard quiet.
    scriptedAgent = { assistantText: RESPONSE_WITH_ARTIFACT };
    const result = await generateViaAgent(
      {
        prompt: 'design a hero',
        history: [],
        model: MODEL,
        apiKey: 'sk-test',
      },
      { tools: [] },
    );
    expect(result.artifacts).toHaveLength(1);
  });
});

describe('FRAME_TEMPLATES — device frame starter assets', () => {
  it('exposes iphone, ipad, watch, android, and macos-safari frames as JSX modules with EDITMODE markers', async () => {
    const { FRAME_TEMPLATES } = await import('./frames/index.js');
    const names = FRAME_TEMPLATES.map(([n]) => n);
    expect(names).toEqual([
      'iphone.jsx',
      'ipad.jsx',
      'watch.jsx',
      'android.jsx',
      'macos-safari.jsx',
    ]);
    for (const [name, jsx] of FRAME_TEMPLATES) {
      expect(jsx.length, `${name} should be non-empty`).toBeGreaterThan(200);
      expect(jsx, `${name} must declare an EDITMODE block`).toMatch(/EDITMODE-BEGIN/);
      expect(jsx, `${name} must declare an EDITMODE block`).toMatch(/EDITMODE-END/);
      expect(jsx, `${name} must call ReactDOM.createRoot`).toMatch(/ReactDOM\.createRoot/);
    }
  });

  it('seeds an agent-host fsMap so the agent can `view` frames/<name>', async () => {
    const { FRAME_TEMPLATES } = await import('./frames/index.js');
    const fsMap = new Map<string, string>();
    for (const [name, content] of FRAME_TEMPLATES) {
      fsMap.set(`frames/${name}`, content);
    }
    expect(fsMap.get('frames/iphone.jsx')).toMatch(/IOSDevice/);
    expect(fsMap.get('frames/ipad.jsx')).toMatch(/ReactDOM\.createRoot/);
    expect(fsMap.get('frames/watch.jsx')).toMatch(/ReactDOM\.createRoot/);
  });
});

describe('chatMessageToAgentMessage — Gameimprove §1 tool transcript persistence', () => {
  const piModel = {
    id: 'claude-sonnet-4-6',
    api: 'anthropic',
    provider: 'anthropic',
  } as unknown as Parameters<typeof import('./agent').chatMessageToAgentMessage>[2];

  it('converts a plain user message into a UserMessage', async () => {
    const { chatMessageToAgentMessage } = await import('./agent');
    const out = chatMessageToAgentMessage(
      { role: 'user', content: 'hello' },
      1700000000000,
      piModel,
    );
    expect(out).toEqual({ role: 'user', content: 'hello', timestamp: 1700000000000 });
  });

  it('converts a plain assistant text message into an AssistantMessage with stopReason=stop', async () => {
    const { chatMessageToAgentMessage } = await import('./agent');
    const out = chatMessageToAgentMessage(
      { role: 'assistant', content: 'sure' },
      1700000000000,
      piModel,
    ) as { role: string; content: unknown[]; stopReason: string };
    expect(out.role).toBe('assistant');
    expect(out.content).toEqual([{ type: 'text', text: 'sure' }]);
    expect(out.stopReason).toBe('stop');
  });

  it('reconstructs an AssistantMessage with toolCall content + stopReason=toolUse when toolCalls present', async () => {
    const { chatMessageToAgentMessage } = await import('./agent');
    const out = chatMessageToAgentMessage(
      {
        role: 'assistant',
        content: 'editing index.html',
        toolCalls: [
          {
            id: 'call-1',
            name: 'text_editor',
            argsJson: '{"command":"str_replace","path":"index.html"}',
          },
        ],
      },
      1700000000000,
      piModel,
    ) as { role: string; content: Array<{ type: string }>; stopReason: string };
    expect(out.role).toBe('assistant');
    expect(out.stopReason).toBe('toolUse');
    expect(out.content).toEqual([
      { type: 'text', text: 'editing index.html' },
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'text_editor',
        arguments: { command: 'str_replace', path: 'index.html' },
      },
    ]);
  });

  it('emits a toolResult message for role=tool and pairs by toolCallId', async () => {
    const { chatMessageToAgentMessage } = await import('./agent');
    const out = chatMessageToAgentMessage(
      {
        role: 'tool',
        content: '<file content>',
        toolCallId: 'call-1',
        toolName: 'text_editor',
      },
      1700000000000,
      piModel,
    ) as {
      role: string;
      toolCallId: string;
      toolName: string;
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(out.role).toBe('toolResult');
    expect(out.toolCallId).toBe('call-1');
    expect(out.toolName).toBe('text_editor');
    expect(out.content).toEqual([{ type: 'text', text: '<file content>' }]);
    expect(out.isError).toBe(false);
  });

  it('marks tool results as isError=true when isError flag is set', async () => {
    const { chatMessageToAgentMessage } = await import('./agent');
    const out = chatMessageToAgentMessage(
      {
        role: 'tool',
        content: 'old_str not found',
        toolCallId: 'call-2',
        toolName: 'text_editor',
        isError: true,
      },
      1700000000000,
      piModel,
    ) as { isError: boolean };
    expect(out.isError).toBe(true);
  });

  it('handles a tool message with malformed argsJson by emitting an empty arg bag (preserves id pairing)', async () => {
    const { chatMessageToAgentMessage } = await import('./agent');
    const out = chatMessageToAgentMessage(
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-3', name: 'text_editor', argsJson: '{not json' }],
      },
      1700000000000,
      piModel,
    ) as unknown as { content: Array<Record<string, unknown>> };
    // Empty assistant text → no leading text block, just the toolCall.
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toMatchObject({
      type: 'toolCall',
      id: 'call-3',
      name: 'text_editor',
      arguments: {},
    });
  });
});

describe('generateViaAgent() — stuck-detector — Improver1 §3', () => {
  it('region-repeat gate: fires steer after 3 failed edits on the same content target across str_replace + patch', async () => {
    // Today's run-1 thrash on `// ── Body bob + head ──` lines
    // 1346-1392: 4 mixed str_replace + patch failures didn't trigger
    // the original args-hash detector because the args differed
    // between attempts. The new content-bucket gate fires when 3
    // failures share the same path + first-non-empty-line probe.
    const probeLine = '// ── Body bob + head ──';
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      events: [
        // 1st attempt — str_replace whose old_str leads with the
        // probe line.
        {
          type: 'tool_execution_start',
          toolCallId: 'sr-1',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'str_replace',
            path: 'index.html',
            old_str: `${probeLine}\n  const bob = 0;`,
            new_str: 'X',
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'sr-1',
          toolName: 'str_replace_based_edit_tool',
          result: 'old_str not found',
          isError: true,
        },
        // 2nd attempt — patch with expectedOriginal leading with the
        // SAME probe line. Same content bucket → same target.
        {
          type: 'tool_execution_start',
          toolCallId: 'p-1',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              {
                startLine: 1346,
                endLine: 1392,
                replacement: 'X',
                expectedOriginal: `${probeLine}\n  const bob = 0;\n  // …more`,
              },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'p-1',
          toolName: 'str_replace_based_edit_tool',
          result: 'mismatch',
          isError: true,
        },
        // 3rd attempt — patch again, same probe line.
        {
          type: 'tool_execution_start',
          toolCallId: 'p-2',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              {
                startLine: 1340,
                endLine: 1390,
                replacement: 'X',
                expectedOriginal: `${probeLine}\n different content here`,
              },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'p-2',
          toolName: 'str_replace_based_edit_tool',
          result: 'mismatch',
          isError: true,
        },
      ],
    };
    await generateViaAgent({
      prompt: 'fix the body bob',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const steers = agentCalls[0]?.steers ?? [];
    expect(steers).toHaveLength(1);
    expect(steers[0]?.content).toMatch(/index\.html/);
    expect(steers[0]?.content).toMatch(/failed \d+ attempts to edit/i);
    expect(steers[0]?.content).toMatch(/view.*range/i);
    // Last attempt carried lines 1340-1390 → message includes them.
    expect(steers[0]?.content).toMatch(/lines 1340-1390/);
  });

  it('region-repeat gate does NOT fire when failures target different content blocks', async () => {
    // Three failures, different content probe each time → different
    // buckets, no individual bucket reaches threshold.
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      events: [
        {
          type: 'tool_execution_start',
          toolCallId: 'a',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              { startLine: 100, endLine: 110, replacement: 'X', expectedOriginal: '// HEADER' },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'a',
          toolName: 'str_replace_based_edit_tool',
          result: 'fail',
          isError: true,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'b',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              { startLine: 500, endLine: 510, replacement: 'X', expectedOriginal: '// FOOTER' },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'b',
          toolName: 'str_replace_based_edit_tool',
          result: 'fail',
          isError: true,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'c',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              { startLine: 1000, endLine: 1010, replacement: 'X', expectedOriginal: '// BODY' },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'c',
          toolName: 'str_replace_based_edit_tool',
          result: 'fail',
          isError: true,
        },
      ],
    };
    await generateViaAgent({
      prompt: 'edits',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    expect(agentCalls[0]?.steers).toHaveLength(0);
  });

  it('region-repeat gate does NOT fire on successful tool calls (only failures count)', async () => {
    // Same content bucket on each attempt. Different replacement so
    // the args-repeat detector doesn't fire either. Verify the
    // region-repeat path requires isError=true.
    const probeLine = '// SECTION X';
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      events: [
        {
          type: 'tool_execution_start',
          toolCallId: 'ok-1',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              { startLine: 100, endLine: 110, replacement: 'A', expectedOriginal: probeLine },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'ok-1',
          toolName: 'str_replace_based_edit_tool',
          result: 'edit applied',
          isError: false,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'ok-2',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              { startLine: 100, endLine: 110, replacement: 'B', expectedOriginal: probeLine },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'ok-2',
          toolName: 'str_replace_based_edit_tool',
          result: 'edit applied',
          isError: false,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'ok-3',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'index.html',
            hunks: [
              { startLine: 100, endLine: 110, replacement: 'C', expectedOriginal: probeLine },
            ],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'ok-3',
          toolName: 'str_replace_based_edit_tool',
          result: 'edit applied',
          isError: false,
        },
      ],
    };
    await generateViaAgent({
      prompt: 'edits',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    expect(agentCalls[0]?.steers).toHaveLength(0);
  });

  it('args-repeat gate (original Backlog-3 §3) still fires for identical tool calls 3× in 5 turns', async () => {
    // Same tool, identical args 3 times. The original detector should
    // fire even before the region detector accumulates (no isError
    // events here).
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      events: [
        {
          type: 'tool_execution_start',
          toolCallId: 'x',
          toolName: 'set_todos',
          args: { items: [{ text: 'do thing', checked: false }] },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'y',
          toolName: 'set_todos',
          args: { items: [{ text: 'do thing', checked: false }] },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'z',
          toolName: 'set_todos',
          args: { items: [{ text: 'do thing', checked: false }] },
        },
      ],
    };
    await generateViaAgent({
      prompt: 'do thing',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const steers = agentCalls[0]?.steers ?? [];
    expect(steers).toHaveLength(1);
    expect(steers[0]?.content).toMatch(/repeated the same tool call/i);
  });

  it('only one steer fires per run (no double-fire when both gates would trigger)', async () => {
    // Same args triplet (would trip args-repeat) on the same line range
    // (also trips region-repeat after isError). Verify only ONE steer.
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      events: [
        {
          type: 'tool_execution_start',
          toolCallId: 'a',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'f.html',
            hunks: [{ startLine: 50, endLine: 60, replacement: 'X' }],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'a',
          toolName: 'str_replace_based_edit_tool',
          result: 'fail',
          isError: true,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'b',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'f.html',
            hunks: [{ startLine: 50, endLine: 60, replacement: 'X' }],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'b',
          toolName: 'str_replace_based_edit_tool',
          result: 'fail',
          isError: true,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'c',
          toolName: 'str_replace_based_edit_tool',
          args: {
            command: 'patch',
            path: 'f.html',
            hunks: [{ startLine: 50, endLine: 60, replacement: 'X' }],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'c',
          toolName: 'str_replace_based_edit_tool',
          result: 'fail',
          isError: true,
        },
      ],
    };
    await generateViaAgent({
      prompt: 'edits',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    expect(agentCalls[0]?.steers).toHaveLength(1);
  });
});

describe('generateViaAgent() — convergence-detector — Improver1 §7', () => {
  /** Build a script of N small-edit turns on `path` with no
   *  verify_artifact between them. Each turn = a turn_start, a tiny
   *  str_replace tool start, then a turn_end. Returns the AgentEvent
   *  array suitable for scriptedAgent.events. */
  function scriptSmallEditTurns(path: string, n: number): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i += 1) {
      events.push({ type: 'turn_start' });
      events.push({
        type: 'tool_execution_start',
        toolCallId: `e${i}`,
        toolName: 'str_replace_based_edit_tool',
        args: { command: 'str_replace', path, old_str: 'a', new_str: 'b' },
      });
      events.push({ type: 'turn_end' });
    }
    return events;
  }

  it('fires convergence steer after 25+ turns of small edits on a single file with no verify', async () => {
    const events = scriptSmallEditTurns('index.html', 30);
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      // biome-ignore lint/suspicious/noExplicitAny: AgentEvent literal shapes.
      events: events as any,
    };
    await generateViaAgent({
      prompt: 'iterate forever',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const steers = agentCalls[0]?.steers ?? [];
    const convergenceSteer = steers.find((s) =>
      /converged or the requirement is unclear/i.test(s.content),
    );
    expect(convergenceSteer).toBeDefined();
    expect(convergenceSteer?.content).toMatch(/index\.html/);
    expect(convergenceSteer?.content).toMatch(/verify_artifact/);
    expect(convergenceSteer?.content).toMatch(/done/);
  });

  it('does NOT fire under the 25-turn floor', async () => {
    const events = scriptSmallEditTurns('index.html', 10);
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      // biome-ignore lint/suspicious/noExplicitAny: AgentEvent literal shapes.
      events: events as any,
    };
    await generateViaAgent({
      prompt: 'short run',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const steers = agentCalls[0]?.steers ?? [];
    const convergenceSteer = steers.find((s) =>
      /converged or the requirement is unclear/i.test(s.content),
    );
    expect(convergenceSteer).toBeUndefined();
  });

  it('does NOT fire when a verify_artifact landed inside the 5-turn lookback', async () => {
    // 22 small edits + one verify_artifact + 3 more small edits = 26
    // turns total (above the 25-turn floor) but the verify still
    // sits inside the rolling 5-turn window — steer must NOT fire.
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 22; i += 1) {
      events.push({ type: 'turn_start' });
      events.push({
        type: 'tool_execution_start',
        toolCallId: `e${i}`,
        toolName: 'str_replace_based_edit_tool',
        args: { command: 'str_replace', path: 'index.html', old_str: 'a', new_str: 'b' },
      });
      events.push({ type: 'turn_end' });
    }
    // Turn 23 — verify_artifact
    events.push({ type: 'turn_start' });
    events.push({
      type: 'tool_execution_start',
      toolCallId: 'v1',
      toolName: 'verify_artifact',
      args: {},
    });
    events.push({ type: 'turn_end' });
    // Turns 24-26 — three more small edits. Buffer at turn 26 holds
    // [22, 23, 24, 25, 26] — turn 23's verify is still in window.
    for (let i = 0; i < 3; i += 1) {
      events.push({ type: 'turn_start' });
      events.push({
        type: 'tool_execution_start',
        toolCallId: `e2-${i}`,
        toolName: 'str_replace_based_edit_tool',
        args: { command: 'str_replace', path: 'index.html', old_str: 'a', new_str: 'b' },
      });
      events.push({ type: 'turn_end' });
    }
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      // biome-ignore lint/suspicious/noExplicitAny: AgentEvent literal shapes.
      events: events as any,
    };
    await generateViaAgent({
      prompt: 'with verify',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const steers = agentCalls[0]?.steers ?? [];
    const convergenceSteer = steers.find((s) =>
      /converged or the requirement is unclear/i.test(s.content),
    );
    expect(convergenceSteer).toBeUndefined();
  });

  it('does NOT fire when edits span MULTIPLE files', async () => {
    // 30 small edits, alternating between two files — purpose was
    // "still working", not "narrow tweaking".
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i += 1) {
      events.push({ type: 'turn_start' });
      events.push({
        type: 'tool_execution_start',
        toolCallId: `e${i}`,
        toolName: 'str_replace_based_edit_tool',
        args: {
          command: 'str_replace',
          path: i % 2 === 0 ? 'index.html' : 'styles.css',
          old_str: 'a',
          new_str: 'b',
        },
      });
      events.push({ type: 'turn_end' });
    }
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      // biome-ignore lint/suspicious/noExplicitAny: AgentEvent literal shapes.
      events: events as any,
    };
    await generateViaAgent({
      prompt: 'multi file',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const steers = agentCalls[0]?.steers ?? [];
    const convergenceSteer = steers.find((s) =>
      /converged or the requirement is unclear/i.test(s.content),
    );
    expect(convergenceSteer).toBeUndefined();
  });

  it('only fires once per run (one-shot)', async () => {
    const events = scriptSmallEditTurns('index.html', 40);
    scriptedAgent = {
      assistantText: RESPONSE_WITH_ARTIFACT,
      // biome-ignore lint/suspicious/noExplicitAny: AgentEvent literal shapes.
      events: events as any,
    };
    await generateViaAgent({
      prompt: 'long run',
      history: [],
      model: MODEL,
      apiKey: 'sk-test',
    });
    const convergenceSteers = (agentCalls[0]?.steers ?? []).filter((s) =>
      /converged or the requirement is unclear/i.test(s.content),
    );
    expect(convergenceSteers).toHaveLength(1);
  });
});
