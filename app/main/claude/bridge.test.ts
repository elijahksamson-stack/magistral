/**
 * Bridge tests.
 *
 * The first describe block is the most important test in this application. If
 * ANTHROPIC_API_KEY reaches the spawned CLI, it stops billing the user's
 * subscription and silently starts consuming API credits — with identical
 * output, so nothing downstream would ever notice. Everything else here can be
 * renegotiated; that cannot.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_TOOLS,
  STRIPPED_ENV_KEYS,
  type CellInvokeRequest,
  type ChatInvokeRequest,
  type ClaudeBridgeConfig,
  type ClaudeStreamEvent,
} from '../../../shared/types/claude';
import { FORBIDDEN_FLAGS } from './args';
import { ClaudeBridge, type SpawnFn } from './bridge';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
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

const CONFIG: ClaudeBridgeConfig = {
  binaryPath: '/usr/local/bin/claude',
  model: 'sonnet',
  timeoutMs: 5_000,
  knowledgeDir: '/tmp/braindump-knowledge-does-not-exist',
  vaultDir: '/tmp/braindump-vault-does-not-exist',
};

function cellRequest(overrides: Partial<CellInvokeRequest> = {}): CellInvokeRequest {
  return {
    requestId: 'req-1',
    kind: 'cell',
    action: 'enhance',
    cellId: 'cell-1',
    cellMarkdown: 'Semiconductor capex is the binding constraint.',
    ...overrides,
  };
}

function chatRequest(): ChatInvokeRequest {
  return { requestId: 'req-chat', kind: 'chat', message: 'What is the weakest link here?' };
}

function collector(): { events: ClaudeStreamEvent[]; emit: (e: ClaudeStreamEvent) => void } {
  const events: ClaudeStreamEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
}

// ---------------------------------------------------------------------------
// THE test
// ---------------------------------------------------------------------------

describe('subscription billing hygiene', () => {
  const POISONED_ENV: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/test',
    ANTHROPIC_API_KEY: 'sk-ant-should-never-reach-the-child',
    ANTHROPIC_AUTH_TOKEN: 'token-should-never-reach-the-child',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    AWS_BEARER_TOKEN_BEDROCK: 'bearer-should-never-reach-the-child',
  };

  it('never lets ANTHROPIC_API_KEY reach the spawned CLI', async () => {
    const { spawn, calls } = makeSpawn();
    const { emit } = collector();
    const bridge = new ClaudeBridge(CONFIG, emit, { spawn, sourceEnv: POISONED_ENV });

    await bridge.invoke(cellRequest());

    expect(calls).toHaveLength(1);
    const env = calls[0]!.options.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('strips every key in STRIPPED_ENV_KEYS', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, {
      spawn,
      sourceEnv: POISONED_ENV,
    });

    await bridge.invoke(cellRequest());

    const envKeys = Object.keys(calls[0]!.options.env ?? {});
    for (const banned of STRIPPED_ENV_KEYS) {
      expect(envKeys).not.toContain(banned);
    }
  });

  it('strips billing keys even when the real process.env carries one', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-the-actual-process-env');

    const { spawn, calls } = makeSpawn();
    // No sourceEnv: the bridge falls back to process.env, exactly as in prod.
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

    await bridge.invoke(cellRequest());

    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-the-actual-process-env');
    expect(calls[0]!.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps the environment the CLI legitimately needs', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, {
      spawn,
      sourceEnv: POISONED_ENV,
    });

    await bridge.invoke(cellRequest());

    const env = calls[0]!.options.env ?? {};
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/Users/test');
  });

  it('does not mutate the source environment', async () => {
    const source: NodeJS.ProcessEnv = { ...POISONED_ENV };
    const { spawn } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn, sourceEnv: source });

    await bridge.invoke(cellRequest());

    expect(source.ANTHROPIC_API_KEY).toBe('sk-ant-should-never-reach-the-child');
  });
});

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

describe('spawn arguments', () => {
  it('never passes a permission-bypassing flag', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

    await bridge.invoke(cellRequest());

    const args = calls[0]!.args;
    for (const flag of FORBIDDEN_FLAGS) {
      expect(args).not.toContain(flag);
    }
  });

  it('requests stream-json with partial messages and read-only tools', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

    await bridge.invoke(cellRequest());

    const args = calls[0]!.args;
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--allowedTools');
    for (const tool of ALLOWED_TOOLS) expect(args).toContain(tool);
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
  });

  it('scopes --add-dir to the knowledge and vault directories only', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

    await bridge.invoke(cellRequest());

    const args = calls[0]!.args;
    const dirs = args.filter((_arg, index) => args[index - 1] === '--add-dir');
    expect(dirs).toEqual([CONFIG.knowledgeDir, CONFIG.vaultDir]);
  });

  it('passes --resume only when a session is being continued', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

    await bridge.invoke(cellRequest());
    await bridge.invoke(cellRequest({ requestId: 'req-2', resumeSessionId: 'sess-42' }));

    expect(calls[0]!.args).not.toContain('--resume');
    expect(calls[1]!.args).toContain('--resume');
    expect(calls[1]!.args).toContain('sess-42');
  });

  it('runs the child with cwd set to the vault', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

    await bridge.invoke(chatRequest());

    expect(calls[0]!.options.cwd).toBe(CONFIG.vaultDir);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('streaming', () => {
  let bridge: ClaudeBridge;
  let calls: SpawnCapture[];
  let events: ClaudeStreamEvent[];

  beforeEach(() => {
    const spawned = makeSpawn();
    const sink = collector();
    calls = spawned.calls;
    events = sink.events;
    bridge = new ClaudeBridge(CONFIG, sink.emit, { spawn: spawned.spawn });
  });

  afterEach(() => bridge.disposeAll());

  const typesOf = (): string[] => events.map((event) => event.type);

  it('emits started and packs as soon as the child exists', async () => {
    await bridge.invoke(cellRequest());
    expect(typesOf().slice(0, 2)).toEqual(['started', 'packs']);
  });

  it('captures the session id from the init event', async () => {
    await bridge.invoke(cellRequest());
    const child = calls[0]!.child;

    child.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' })}\n`,
    );
    await tick();

    const started = events.filter((event) => event.type === 'started');
    expect(started.at(-1)).toMatchObject({ sessionId: 'sess-abc' });
  });

  it('reassembles a JSON object split across two stdout chunks', async () => {
    await bridge.invoke(cellRequest());
    const child = calls[0]!.child;

    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello world' } },
    });
    const cut = Math.floor(line.length / 2);

    child.stdout.write(line.slice(0, cut));
    await tick();
    expect(typesOf()).not.toContain('delta');

    child.stdout.write(`${line.slice(cut)}\n`);
    await tick();

    const delta = events.find((event) => event.type === 'delta');
    expect(delta).toMatchObject({ type: 'delta', text: 'hello world' });
  });

  it('emits thinking and tool events', async () => {
    await bridge.invoke(cellRequest());
    const child = calls[0]!.child;

    child.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
      })}\n`,
    );
    await tick();

    expect(events).toContainEqual({ type: 'thinking', requestId: 'req-1', text: 'hmm' });
    expect(events).toContainEqual({ type: 'tool', requestId: 'req-1', name: 'Read' });
  });

  it('emits done with usage from the result record', async () => {
    await bridge.invoke(cellRequest());
    const child = calls[0]!.child;

    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'sess-done',
        result: 'Final prose.',
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 100,
          output_tokens: 42,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 3,
        },
      })}\n`,
    );
    await tick();

    const done = events.find((event) => event.type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      sessionId: 'sess-done',
      fullText: 'Final prose.',
      usage: {
        inputTokens: 100,
        outputTokens: 42,
        cacheReadTokens: 7,
        cacheCreationTokens: 3,
        notionalCostUsd: 0.0123,
      },
    });
  });

  it('reports a non-zero exit as SPAWN_FAILED with the stderr text', async () => {
    await bridge.invoke(cellRequest());
    const child = calls[0]!.child;

    child.stderr.write('claude: not logged in\n');
    await tick();
    child.finish(1);
    await tick();

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'SPAWN_FAILED' });
    expect((events.at(-1) as { message: string }).message).toContain('not logged in');
  });

  it('reports a clean exit with no output as PARSE_FAILED', async () => {
    await bridge.invoke(cellRequest());
    calls[0]!.child.finish(0);
    await tick();

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'PARSE_FAILED' });
  });
});

// ---------------------------------------------------------------------------
// Cancellation and lifetime
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('SIGTERMs the child and emits cancelled once it closes', async () => {
    const { spawn, calls } = makeSpawn();
    const sink = collector();
    const bridge = new ClaudeBridge(CONFIG, sink.emit, { spawn });

    await bridge.invoke(cellRequest());
    expect(await bridge.cancel('req-1')).toBe(true);
    expect(calls[0]!.child.signals).toContain('SIGTERM');

    calls[0]!.child.finish(143);
    await tick();

    expect(sink.events.at(-1)).toMatchObject({ type: 'cancelled', requestId: 'req-1' });
  });

  it('ignores the CLI error record produced while handling Stop', async () => {
    const { spawn, calls } = makeSpawn();
    const sink = collector();
    const bridge = new ClaudeBridge(CONFIG, sink.emit, { spawn });

    await bridge.invoke(cellRequest());
    await bridge.cancel('req-1');
    calls[0]!.child.stdout.write(`${JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'error_during_execution',
    })}\n`);
    await tick();
    calls[0]!.child.finish(143);
    await tick();

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(sink.events.at(-1)).toMatchObject({ type: 'cancelled', requestId: 'req-1' });
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, calls } = makeSpawn();
      const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

      await bridge.invoke(cellRequest());
      await bridge.cancel('req-1');
      vi.advanceTimersByTime(10_000);

      expect(calls[0]!.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when cancelling a request that is not running', async () => {
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn: makeSpawn().spawn });
    expect(await bridge.cancel('nope')).toBe(false);
  });

  it('kills every live child on dispose', async () => {
    const { spawn, calls } = makeSpawn();
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn });

    await bridge.invoke(cellRequest());
    await bridge.invoke(cellRequest({ requestId: 'req-2' }));
    bridge.disposeAll();

    expect(calls.map((call) => call.child.signals[0])).toEqual(['SIGTERM', 'SIGTERM']);
  });

  it('refuses to start two runs under the same requestId', async () => {
    const bridge = new ClaudeBridge(CONFIG, collector().emit, { spawn: makeSpawn().spawn });
    await bridge.invoke(cellRequest());
    await expect(bridge.invoke(cellRequest())).rejects.toThrow(/already running/);
  });
});

describe('timeout', () => {
  it('emits a TIMEOUT error and kills the child', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, calls } = makeSpawn();
      const sink = collector();
      const bridge = new ClaudeBridge({ ...CONFIG, timeoutMs: 1_000 }, sink.emit, { spawn });

      await bridge.invoke(cellRequest());
      vi.advanceTimersByTime(1_500);

      expect(sink.events.at(-1)).toMatchObject({ type: 'error', code: 'TIMEOUT' });
      expect(calls[0]!.child.signals).toContain('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Let the stream's 'data' listeners run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
