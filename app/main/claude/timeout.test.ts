/**
 * The timeout must measure SILENCE, not elapsed time.
 *
 * Reported: a long, thorough answer failed with "No response within 120000ms"
 * while most of it was already on screen. The cap was on the whole request, so
 * a healthy stream that simply took a while was killed mid-sentence. What
 * actually indicates a problem is the CLI producing nothing at all.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeBridge, type SpawnFn } from './bridge';
import type { ClaudeBridgeConfig, ClaudeStreamEvent } from '../../../shared/types/claude';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  // terminate() skips a child it believes has already exited, and `undefined`
  // is not `null` — without these it reads as exited and never signals.
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }
}

const IDLE_MS = 5_000;

const CONFIG: ClaudeBridgeConfig = {
  binaryPath: '/usr/local/bin/claude',
  model: 'sonnet',
  timeoutMs: IDLE_MS,
  knowledgeDir: '/tmp/braindump-knowledge-does-not-exist',
  vaultDir: '/tmp/braindump-vault-does-not-exist',
};

let child: FakeChild;
let events: ClaudeStreamEvent[];
let bridge: ClaudeBridge;

const spawn: SpawnFn = (_command, _args, _options: SpawnOptions) =>
  child as unknown as ChildProcess;

/** One well-formed assistant delta, as the CLI would emit it. */
function deltaLine(text: string): string {
  return `${JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  })}\n`;
}

async function startRun(): Promise<void> {
  await bridge.invoke({
    requestId: 'req-1',
    kind: 'cell',
    action: 'enhance',
    cellId: 'cell-1',
    cellMarkdown: 'The binding constraint is EUV.',
  });
  // Let the stream wiring attach before anything is written.
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  child = new FakeChild();
  events = [];
  bridge = new ClaudeBridge(CONFIG, (event) => events.push(event), { spawn, sourceEnv: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

const timeouts = () => events.filter((e) => e.type === 'error' && e.code === 'TIMEOUT');

describe('the idle timeout', () => {
  it('fires when the CLI produces nothing at all', async () => {
    await startRun();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);

    expect(timeouts()).toHaveLength(1);
    expect(child.signals).toContain('SIGTERM');
  });

  it('does NOT fire while output keeps arriving, however long it takes', async () => {
    await startRun();

    // Ten quiet-ish gaps, each just under the idle limit. Total elapsed time
    // is far past the old wall-clock cap — this is the reported case.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_MS - 500);
      child.stdout.write(deltaLine(`chunk ${i} `));
      await Promise.resolve();
    }

    expect(timeouts()).toHaveLength(0);
  });

  it('fires once output stops, even after a long healthy stream', async () => {
    await startRun();

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_MS - 500);
      child.stdout.write(deltaLine('still going '));
      await Promise.resolve();
    }
    expect(timeouts()).toHaveLength(0);

    // Now it genuinely goes quiet.
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(timeouts()).toHaveLength(1);
  });

  it('is reset by stderr too, which is still a sign of life', async () => {
    await startRun();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 500);
    child.stderr.write('warming up\n');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 500);

    expect(timeouts()).toHaveLength(0);
  });

  it('says the CLI went quiet, not that the request took too long', async () => {
    await startRun();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);

    const message = timeouts()[0];
    expect(message?.type === 'error' ? message.message : '').toMatch(/went quiet/i);
  });

  it('stops timing once the run has settled', async () => {
    await startRun();
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', usage: {} })}\n`,
    );
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(IDLE_MS * 4);
    expect(timeouts()).toHaveLength(0);
  });
});
