/**
 * Session persistence, driven through a mocked `window.braindump`.
 *
 * Without the session id every turn would start a new conversation. This is the
 * only place that id is captured, so it is tested against the real event union.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ClaudeStreamEvent, ClaudeUsage } from '../../../shared/types/claude';
import type { BrainDumpApi } from '../../../shared/types/ipc';
import { readSessionId, subscribeSessionId } from './sessionTracking';

const USAGE: ClaudeUsage = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  notionalCostUsd: 0,
};

/** Minimal stand-in for the preload surface. */
function mockBraindump() {
  const listeners: ((event: ClaudeStreamEvent) => void)[] = [];
  const unsubscribe = vi.fn();

  const api: Pick<BrainDumpApi, 'on'> = {
    on: vi.fn((channel, listener) => {
      expect(channel).toBe('claude:stream');
      listeners.push(listener as (event: ClaudeStreamEvent) => void);
      return unsubscribe;
    }) as BrainDumpApi['on'],
  };

  return {
    api,
    unsubscribe,
    emit(event: ClaudeStreamEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('readSessionId', () => {
  it('reads the session from started and done', () => {
    expect(
      readSessionId({ type: 'started', requestId: 'r1', sessionId: 'sess-1' }),
    ).toBe('sess-1');
    expect(
      readSessionId({
        type: 'done',
        requestId: 'r1',
        sessionId: 'sess-2',
        fullText: '',
        usage: USAGE,
      }),
    ).toBe('sess-2');
  });

  it('ignores events that carry no session', () => {
    expect(readSessionId({ type: 'delta', requestId: 'r1', text: 'x' })).toBeNull();
    expect(readSessionId({ type: 'cancelled', requestId: 'r1' })).toBeNull();
  });
});

describe('subscribeSessionId', () => {
  it('reports session ids for the pane’s own requests only', () => {
    const bridge = mockBraindump();
    const seen: string[] = [];
    const owned = new Set(['req-1']);

    subscribeSessionId(bridge.api, (id) => owned.has(id), (sessionId) => seen.push(sessionId));

    bridge.emit({ type: 'started', requestId: 'req-1', sessionId: 'sess-1' });
    bridge.emit({ type: 'started', requestId: 'cell-9', sessionId: 'sess-other' });
    bridge.emit({ type: 'delta', requestId: 'req-1', text: 'hello' });
    bridge.emit({
      type: 'done',
      requestId: 'req-1',
      sessionId: 'sess-1',
      fullText: 'hello',
      usage: USAGE,
    });

    expect(seen).toEqual(['sess-1', 'sess-1']);
  });

  it('returns the unsubscribe handle from the preload API', () => {
    const bridge = mockBraindump();

    const dispose = subscribeSessionId(bridge.api, () => true, () => undefined);
    dispose();

    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not report a session for a cancelled turn', () => {
    const bridge = mockBraindump();
    const seen: string[] = [];

    subscribeSessionId(bridge.api, () => true, (sessionId) => seen.push(sessionId));
    bridge.emit({ type: 'cancelled', requestId: 'req-1' });

    expect(seen).toEqual([]);
  });
});
