// @vitest-environment jsdom
/**
 * The bridge must never leave a turn stranded.
 *
 * Reported: hitting Stop left "Waiting for the bridge" on screen forever, with
 * the Stop button still up and nothing able to clear it. That state is
 * `runs[id] === undefined`, which the transcript reads as pending and the pane
 * treats as busy — so the UI waits on a process that is not running.
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearClaudeRuns, useClaude } from '../useClaude';
import type { ClaudeStreamEvent } from '../../../../shared/types/claude';

let emit: (event: ClaudeStreamEvent) => void;
let activeIds: string[];
let cancelResult: boolean;
let invoked: string[];

function installBridge(): void {
  activeIds = [];
  cancelResult = true;
  invoked = [];

  Object.defineProperty(window, 'braindump', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        invoked.push(channel);
        if (channel === 'claude:active') return { requestIds: activeIds };
        if (channel === 'claude:cancel') return { cancelled: cancelResult };
        return { accepted: true };
      }),
      on: (_channel: string, listener: (event: ClaudeStreamEvent) => void) => {
        emit = listener;
        return () => {};
      },
      platform: 'darwin' as NodeJS.Platform,
      appVersion: '0.1.0',
    },
  });
}

let latest: ReturnType<typeof useClaude>;

let watchedId = '';

function Probe() {
  latest = useClaude();
  const run = watchedId ? latest.runs[watchedId] : Object.values(latest.runs)[0];
  return (
    <span data-testid="state">
      {run ? `${run.streaming ? 'streaming' : 'settled'}:${run.cancelled ? 'cancelled' : 'live'}` : 'none'}
    </span>
  );
}

beforeEach(() => {
  installBridge();
  watchedId = '';
  // The store is module-level BY DESIGN — that is what makes a run survive a
  // pane unmounting — so it has to be cleared between tests.
  clearClaudeRuns();
});

describe('run state', () => {
  it('survives a component unmounting and remounting', async () => {
    const first = render(<Probe />);
    let requestId = '';
    await act(async () => {
      requestId = await latest.invoke({ kind: 'chat', message: 'hi' });
      watchedId = requestId;
    });
    await act(async () => {
      emit({ type: 'delta', requestId, text: 'partial answer' });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('streaming:live');

    // Switching tabs unmounts the pane. The run is still going.
    first.unmount();
    activeIds = [requestId];

    render(<Probe />);
    await act(async () => {});

    // Before the fix this came back as 'none' — the turn read as pending
    // forever and the Stop button never cleared.
    expect(screen.getByTestId('state')).toHaveTextContent('streaming:live');
    expect(latest.runs[requestId]?.text).toBe('partial answer');
  });

  it('records events that arrive while nothing is mounted', async () => {
    const first = render(<Probe />);
    let requestId = '';
    await act(async () => {
      requestId = await latest.invoke({ kind: 'chat', message: 'hi' });
      watchedId = requestId;
    });
    first.unmount();

    // The child keeps streaming with no pane on screen.
    emit({ type: 'delta', requestId, text: 'arrived while away' });

    render(<Probe />);
    await act(async () => {});
    expect(latest.runs[requestId]?.text).toBe('arrived while away');
  });
});

describe('several runs at once', () => {
  /**
   * Three cells can each have Claude working on them simultaneously. The store
   * is keyed by requestId precisely so their streams do not interleave — a
   * single "current run" would splice one cell's answer into another's.
   */
  it('keeps each run’s text to itself', async () => {
    render(<Probe />);
    const ids: string[] = [];
    await act(async () => {
      for (const message of ['a', 'b', 'c']) {
        ids.push(await latest.invoke({ kind: 'chat', message }));
      }
    });

    // Interleaved, the way three concurrent children actually arrive.
    await act(async () => {
      emit({ type: 'delta', requestId: ids[0]!, text: 'first ' });
      emit({ type: 'delta', requestId: ids[1]!, text: 'second ' });
      emit({ type: 'delta', requestId: ids[2]!, text: 'third ' });
      emit({ type: 'delta', requestId: ids[1]!, text: 'again' });
      emit({ type: 'delta', requestId: ids[0]!, text: 'more' });
    });

    expect(latest.runs[ids[0]!]?.text).toBe('first more');
    expect(latest.runs[ids[1]!]?.text).toBe('second again');
    expect(latest.runs[ids[2]!]?.text).toBe('third ');
  });

  it('settles one without settling the others', async () => {
    render(<Probe />);
    const ids: string[] = [];
    await act(async () => {
      for (const message of ['a', 'b']) {
        ids.push(await latest.invoke({ kind: 'chat', message }));
      }
    });

    await act(async () => {
      emit({
        type: 'done',
        requestId: ids[0]!,
        sessionId: 's1',
        fullText: 'finished',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          notionalCostUsd: 0,
        },
      });
    });

    // The first stops spinning; the second is still going, so its ✦ keeps
    // animating and its Stop button stays up.
    expect(latest.runs[ids[0]!]?.streaming).toBe(false);
    expect(latest.runs[ids[1]!]?.streaming).toBe(true);
  });

  it('cancelling one leaves the other running', async () => {
    render(<Probe />);
    const ids: string[] = [];
    await act(async () => {
      for (const message of ['a', 'b']) {
        ids.push(await latest.invoke({ kind: 'chat', message }));
      }
    });

    // The bridge confirms the cancel and then emits the event, which is what
    // actually settles the run. Both steps, in that order.
    await act(async () => {
      await latest.cancel(ids[0]!);
      emit({ type: 'cancelled', requestId: ids[0]! });
    });

    expect(latest.runs[ids[0]!]?.cancelled).toBe(true);
    expect(latest.runs[ids[0]!]?.streaming).toBe(false);
    expect(latest.runs[ids[1]!]?.streaming).toBe(true);
    expect(latest.runs[ids[1]!]?.cancelled).toBe(false);
  });
});

describe('stopping a turn', () => {
  it('settles the run when the bridge confirms the cancel', async () => {
    render(<Probe />);
    let requestId = '';
    await act(async () => {
      requestId = await latest.invoke({ kind: 'chat', message: 'hi' });
      watchedId = requestId;
      await latest.cancel(requestId);
      emit({ type: 'cancelled', requestId });
    });

    expect(screen.getByTestId('state')).toHaveTextContent('settled:cancelled');
  });

  it('settles the run even when the bridge has never heard of it', async () => {
    // The exact stranding case: the process already ended, so cancel is a
    // no-op and no event follows. Leaving it streaming would hang the turn.
    cancelResult = false;
    render(<Probe />);
    let requestId = '';
    await act(async () => {
      requestId = await latest.invoke({ kind: 'chat', message: 'hi' });
      watchedId = requestId;
      await latest.cancel(requestId);
    });

    expect(screen.getByTestId('state')).toHaveTextContent('settled:cancelled');
  });

  it('settles immediately and ignores a late execution error from the killed CLI', async () => {
    render(<Probe />);
    let requestId = '';
    await act(async () => {
      requestId = await latest.invoke({ kind: 'chat', message: 'hi' });
      watchedId = requestId;
      await latest.cancel(requestId);
    });

    expect(screen.getByTestId('state')).toHaveTextContent('settled:cancelled');

    await act(async () => {
      emit({
        type: 'error',
        requestId,
        code: 'SPAWN_FAILED',
        message: 'error_during_execution',
      });
    });

    expect(latest.runs[requestId]?.error).toBeNull();
    expect(screen.getByTestId('state')).toHaveTextContent('settled:cancelled');
  });
});

describe('reconciling with the bridge', () => {
  it('stops a run the bridge is no longer running', async () => {
    const first = render(<Probe />);
    let requestId = '';
    await act(async () => {
      requestId = await latest.invoke({ kind: 'chat', message: 'hi' });
      watchedId = requestId;
    });
    first.unmount();

    // The process died while nothing was mounted — no event was ever emitted.
    activeIds = [];
    render(<Probe />);
    await act(async () => {});

    expect(screen.getByTestId('state')).toHaveTextContent('settled:cancelled');
  });

  it('leaves a genuinely running turn alone', async () => {
    const first = render(<Probe />);
    let requestId = '';
    await act(async () => {
      requestId = await latest.invoke({ kind: 'chat', message: 'hi' });
      watchedId = requestId;
    });
    first.unmount();

    activeIds = [requestId];
    render(<Probe />);
    await act(async () => {});

    expect(screen.getByTestId('state')).toHaveTextContent('streaming:live');
  });

  it('leaves state alone when the bridge cannot be reached', async () => {
    render(<Probe />);
    await act(async () => {
      await latest.invoke({ kind: 'chat', message: 'hi' });
    });

    // Falsely stopping a live run is worse than briefly showing a stale one.
    (window.braindump.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('bridge down'),
    );
    render(<Probe />);
    await act(async () => {});

    expect(screen.getAllByTestId('state')[0]).toHaveTextContent('streaming:live');
  });
});
