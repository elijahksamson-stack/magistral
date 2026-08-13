import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatInvokeRequest, ClaudeStreamEvent } from '../../../shared/types/claude';
import type { DetectedCliProvider } from './health';
import {
  ClaudeBridge,
  type ClaudeBridgeRuntimeConfig,
  type SpawnFn,
} from './bridge';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }

  finish(code: number): void {
    this.exitCode = code;
    this.emit('close', code);
  }
}

interface SpawnCapture {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: FakeChild;
}

function makeSpawn(): { spawn: SpawnFn; calls: SpawnCapture[] } {
  const calls: SpawnCapture[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

const CONFIG: ClaudeBridgeRuntimeConfig = {
  binaryPath: '/usr/local/bin/claude',
  codexBinaryPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
  model: 'sonnet',
  timeoutMs: 5_000,
  knowledgeDir: '/tmp/braindump-knowledge-does-not-exist',
  vaultDir: '/tmp/braindump-vault-does-not-exist',
};

const DETECTED_PROVIDERS: DetectedCliProvider[] = [
  {
    binaryPath: CONFIG.binaryPath,
    status: { id: 'claude', label: 'Claude', available: true, authenticated: true },
  },
  {
    binaryPath: CONFIG.codexBinaryPath,
    status: { id: 'codex', label: 'ChatGPT', available: true, authenticated: true },
  },
];

function request(overrides: Partial<ChatInvokeRequest> = {}): ChatInvokeRequest {
  return {
    requestId: 'req-chat',
    kind: 'chat',
    message: 'What is the weakest link?',
    ...overrides,
  };
}

function writeJson(child: FakeChild, value: unknown): void {
  child.stdout.write(`${JSON.stringify(value)}\n`);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const bridges: ClaudeBridge[] = [];

function setup(
  config: ClaudeBridgeRuntimeConfig = CONFIG,
  subscriptionReady = true,
  sourceEnv: NodeJS.ProcessEnv = {},
): { bridge: ClaudeBridge; calls: SpawnCapture[]; events: ClaudeStreamEvent[] } {
  const spawned = makeSpawn();
  const events: ClaudeStreamEvent[] = [];
  const bridge = new ClaudeBridge(config, (event) => events.push(event), {
    spawn: spawned.spawn,
    sourceEnv,
    codexSubscriptionReady: async () => subscriptionReady,
    detectProviders: async () => DETECTED_PROVIDERS,
  });
  bridges.push(bridge);
  return { bridge, calls: spawned.calls, events };
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.disposeAll();
});

describe('Codex provider selection', () => {
  it('uses Codex when startup did not find Claude', async () => {
    const { bridge, calls, events } = setup(
      { ...CONFIG, claudeAvailable: false },
      true,
      { OPENAI_API_KEY: 'sk-must-not-leak', ANTHROPIC_API_KEY: 'sk-ant-nope', PATH: '/bin' },
    );

    await bridge.invoke(request());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(CONFIG.codexBinaryPath);
    expect(calls[0]!.args).toContain('read-only');
    expect(calls[0]!.args).toContain('--ignore-user-config');
    expect(calls[0]!.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(calls[0]!.options.env?.OPENAI_API_KEY).toBeUndefined();
    expect(calls[0]!.options.env?.ANTHROPIC_API_KEY).toBeUndefined();

    writeJson(calls[0]!.child, { type: 'thread.started', thread_id: 'thread-1' });
    writeJson(calls[0]!.child, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'The financing assumption.' },
    });
    writeJson(calls[0]!.child, {
      type: 'turn.completed',
      usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 4 },
    });
    await tick();
    calls[0]!.child.finish(0);

    expect(events).toContainEqual({
      type: 'started',
      requestId: 'req-chat',
      sessionId: 'codex:thread-1',
      provider: 'codex',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      sessionId: 'codex:thread-1',
      fullText: 'The financing assumption.',
    });
  });

  it('resumes a tagged Codex session with the raw thread id', async () => {
    const { bridge, calls } = setup();

    await bridge.invoke(request({ resumeSessionId: 'codex:thread-42' }));

    expect(calls[0]!.command).toBe(CONFIG.codexBinaryPath);
    expect(calls[0]!.args).toContain('resume');
    expect(calls[0]!.args).toContain('thread-42');
    expect(calls[0]!.args).not.toContain('codex:thread-42');
  });

  it('refuses an API-key or signed-out Codex login', async () => {
    const { bridge, calls, events } = setup({ ...CONFIG, claudeAvailable: false }, false);

    await bridge.invoke(request());

    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'NOT_AUTHENTICATED' });
  });

  it('pins ChatGPT and starts fresh instead of passing it a Claude session id', async () => {
    const { bridge, calls } = setup();
    await bridge.selectProvider('codex');

    await bridge.invoke(request({ resumeSessionId: 'claude-session-42' }));

    expect(calls[0]!.command).toBe(CONFIG.codexBinaryPath);
    expect(calls[0]!.args).not.toContain('resume');
    expect(calls[0]!.args).not.toContain('claude-session-42');
  });

  it('treats a turn.failed emitted after Stop as cancellation, not SPAWN_FAILED', async () => {
    const { bridge, calls, events } = setup();
    await bridge.selectProvider('codex');
    await bridge.invoke(request());

    await bridge.cancel('req-chat');
    writeJson(calls[0]!.child, {
      type: 'turn.failed',
      error: { message: 'error_during_execution' },
    });
    await tick();
    calls[0]!.child.finish(143);

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'cancelled', requestId: 'req-chat' });
  });
});

describe('Claude-to-Codex fallback', () => {
  it('falls back on Claude allowance exhaustion without surfacing the failed attempt', async () => {
    const { bridge, calls, events } = setup();
    await bridge.invoke(request());

    // Claude mirrors this terminal notice as an assistant block before the
    // result. It was never emitted as a delta, so it is not a partial answer.
    writeJson(calls[0]!.child, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: "You've hit your session limit · resets 6:20pm (America/New_York)",
          },
        ],
      },
    });
    writeJson(calls[0]!.child, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: "You've hit your session limit · resets 6:20pm (America/New_York)",
    });
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.command).toBe(CONFIG.codexBinaryPath);
    expect(calls[0]!.child.signals).toContain('SIGTERM');
    expect(events.filter((event) => event.type === 'packs')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    calls[0]!.child.finish(1);

    writeJson(calls[1]!.child, { type: 'thread.started', thread_id: 'fallback-thread' });
    writeJson(calls[1]!.child, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Answered by Codex.' },
    });
    writeJson(calls[1]!.child, { type: 'turn.completed', usage: {} });
    await tick();
    calls[1]!.child.finish(0);

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      sessionId: 'codex:fallback-thread',
      fullText: 'Answered by Codex.',
    });
  });

  it('does not retry a generic Claude failure', async () => {
    const { bridge, calls, events } = setup();
    await bridge.invoke(request());

    calls[0]!.child.stderr.write('claude: not logged in\n');
    await tick();
    calls[0]!.child.finish(1);

    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'SPAWN_FAILED' });
  });

  it('does not duplicate a response if Claude emitted text before a limit error', async () => {
    const { bridge, calls, events } = setup();
    await bridge.invoke(request());

    writeJson(calls[0]!.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial.' } },
    });
    writeJson(calls[0]!.child, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: "You've hit your session limit",
    });
    await tick();
    calls[0]!.child.finish(1);

    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'SPAWN_FAILED' });
  });

  it('does not fall back when Claude was explicitly selected', async () => {
    const { bridge, calls, events } = setup();
    await bridge.selectProvider('claude');
    await bridge.invoke(request());

    writeJson(calls[0]!.child, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: "You've hit your session limit",
    });
    await tick();

    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'SPAWN_FAILED' });
  });
});
