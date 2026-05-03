// Live E2E test against Anthropic. Skipped by default (network + cost);
// run explicitly:
//   AGENT_LIVE=1 pnpm -F @open-codesign/core test -- agent.live
//
// Reads the OAuth access token from the macOS keychain (Claude Code's blob).
// Verifies that with our `tool_choice='any'` streamFn wrap, the agent
// actually emits tool calls (set_todos / text_editor / done) instead of
// burning the output budget on adaptive thinking and emitting a closing
// "Done." text block — which is the exact failure mode of the 2026-04-28
// production traces.

import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { generateViaAgent } from './agent.js';
import type { TextEditorFsCallbacks } from './tools/text-editor.js';

function readOAuth(): string | null {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const blob = JSON.parse(raw);
    const inner = blob.claudeAiOauth ?? blob;
    return inner.accessToken ?? null;
  } catch {
    return null;
  }
}

describe.skipIf(!process.env['AGENT_LIVE'])('generateViaAgent — live tool_choice fix', () => {
  it(
    'emits tool calls (set_todos / text_editor / done) on a fresh create prompt',
    { timeout: 600_000 },
    async () => {
      const accessToken = readOAuth();
      expect(accessToken, 'keychain OAuth token is required').toBeTruthy();
      // Narrow for TypeScript — `expect.toBeTruthy()` is a runtime check the
      // type system doesn't see, so without this the rest of the test would
      // need a non-null assertion.
      if (accessToken === null) throw new Error('unreachable: token verified above');

      const fsState = new Map<string, string>();
      const fsCallbacks: TextEditorFsCallbacks = {
        view(path: string) {
          const content = fsState.get(path);
          if (content === undefined) return null;
          return { content, numLines: content.split('\n').length };
        },
        create(path: string, content: string) {
          fsState.set(path, content);
          return { path };
        },
        strReplace(path: string, oldStr: string, newStr: string) {
          const content = fsState.get(path) ?? '';
          fsState.set(path, content.replace(oldStr, newStr));
          return { path };
        },
        insert(path: string, line: number, text: string) {
          const content = fsState.get(path) ?? '';
          const lines = content.split('\n');
          lines.splice(line, 0, text);
          fsState.set(path, lines.join('\n'));
          return { path };
        },
        listDir() {
          return Array.from(fsState.keys()).sort();
        },
      };

      const events: Array<{ type: string; toolName?: string }> = [];
      const logLines: string[] = [];
      const noopChild = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => noopChild,
      } as never;
      const logger = {
        info: (msg: string, ctx: unknown) => {
          const line = `${msg} ${JSON.stringify(ctx ?? {})}`;
          logLines.push(line);
          if (
            msg.includes('streamFn') ||
            msg.includes('http.payload') ||
            msg.includes('http.response') ||
            msg.includes('agent.turn') ||
            msg.includes('tool')
          ) {
            // eslint-disable-next-line no-console
            console.log(`[log] ${line}`);
          }
        },
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => noopChild,
      } as never;

      const out = await generateViaAgent(
        {
          model: {
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-6',
          },
          apiKey: accessToken,
          baseUrl: 'https://api.anthropic.com',
          wire: 'anthropic',
          prompt:
            'Design a minimal landing page for a coffee subscription. Hero, two product tiles, footer.',
          history: [],
          reasoningLevel: 'medium',
          logger,
        } as never,
        {
          fs: fsCallbacks,
          onEvent: (event) => {
            // pi-agent-core nests the tool name under different fields per
            // event type; cast through a permissive shape and check both.
            const e = event as {
              type: string;
              toolName?: string;
              toolCall?: { name?: string };
              tool?: { name?: string };
            };
            const toolName = e.toolName ?? e.toolCall?.name ?? e.tool?.name;
            const entry: { type: string; toolName?: string } = { type: event.type };
            if (toolName) entry.toolName = toolName;
            events.push(entry);
            if (event.type === 'tool_execution_start') {
              // eslint-disable-next-line no-console
              console.log(
                `[tool] start: ${toolName ?? '<unknown>'} (raw=${JSON.stringify(Object.keys(e))})`,
              );
            }
          },
        },
      );

      // eslint-disable-next-line no-console
      console.log(`[result] artifacts=${out.artifacts?.length ?? 0} fsFiles=${fsState.size}`);

      const toolCalls = events.filter((e) => e.type === 'tool_execution_start');
      // eslint-disable-next-line no-console
      console.log(
        `[result] tool calls observed: ${toolCalls.map((e) => e.toolName ?? '?').join(' → ')}`,
      );

      expect(toolCalls.length, 'agent must call at least one tool').toBeGreaterThan(0);
      expect(fsState.size, 'agent must write at least one file').toBeGreaterThan(0);
    },
  );
});
