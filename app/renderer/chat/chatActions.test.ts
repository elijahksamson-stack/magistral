import { describe, expect, it, vi } from 'vitest';

import type { ChatInvokeRequest, GraphContext } from '../../../shared/types/claude';
import { cancelChatTurn, sendChatTurn } from './chatActions';

const GRAPH_CONTEXT: GraphContext = {
  graphName: 'AI capex',
  nodeCount: 12,
  edgeCount: 18,
  topNodeLabels: ['Binding constraint', 'HBM supply'],
  linkedNodeLabels: ['HBM supply'],
};

function invoker(requestId = 'req-1') {
  const calls: Omit<ChatInvokeRequest, 'requestId'>[] = [];
  const invoke = vi.fn(async (request: Omit<ChatInvokeRequest, 'requestId'>) => {
    calls.push(request);
    return requestId;
  });
  return { invoke, calls };
}

describe('sendChatTurn', () => {
  it('sends a chat request and records the turn the bridge accepted', async () => {
    const { invoke, calls } = invoker('req-42');

    const turn = await sendChatTurn({
      invoke,
      message: '  Why does packaging bind?  ',
      sessionId: null,
      now: () => '2026-08-06T12:00:00.000Z',
    });

    expect(calls[0]).toEqual({ kind: 'chat', message: 'Why does packaging bind?' });
    expect(turn).toEqual({
      id: 'req-42',
      prompt: 'Why does packaging bind?',
      askedAt: '2026-08-06T12:00:00.000Z',
    });
  });

  it('resumes the session so the conversation persists across turns', async () => {
    const { invoke, calls } = invoker();

    await sendChatTurn({ invoke, message: 'and then?', sessionId: 'sess-abc' });

    expect(calls[0]!.resumeSessionId).toBe('sess-abc');
  });

  it('omits resumeSessionId on the very first turn', async () => {
    const { invoke, calls } = invoker();

    await sendChatTurn({ invoke, message: 'first question', sessionId: null });

    expect(calls[0]).not.toHaveProperty('resumeSessionId');
  });

  it('passes the graph context through untouched', async () => {
    const { invoke, calls } = invoker();

    await sendChatTurn({
      invoke,
      message: 'what binds?',
      sessionId: null,
      graphContext: GRAPH_CONTEXT,
    });

    expect(calls[0]!.graphContext).toEqual(GRAPH_CONTEXT);
  });

  it('omits graph context entirely when no vault is open', async () => {
    const { invoke, calls } = invoker();

    await sendChatTurn({ invoke, message: 'hello', sessionId: null });

    expect(calls[0]).not.toHaveProperty('graphContext');
  });

  it.each(['', '   ', '\n\t '])('refuses to spend allowance on %j', async (message) => {
    const { invoke } = invoker();

    await expect(sendChatTurn({ invoke, message, sessionId: null })).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propagates a bridge failure rather than swallowing it', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('CLI_NOT_FOUND');
    });

    await expect(
      sendChatTurn({ invoke, message: 'anything', sessionId: null }),
    ).rejects.toThrow('CLI_NOT_FOUND');
  });
});

describe('cancelChatTurn', () => {
  it('cancels the identified turn', async () => {
    const cancel = vi.fn(async () => undefined);

    await cancelChatTurn(cancel, 'req-7');

    expect(cancel).toHaveBeenCalledWith('req-7');
  });

  it('does nothing when there is no turn in flight', async () => {
    const cancel = vi.fn(async () => undefined);

    await cancelChatTurn(cancel, null);

    expect(cancel).not.toHaveBeenCalled();
  });

  it('propagates a cancel failure so the UI can report it', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('no such request');
    });

    await expect(cancelChatTurn(cancel, 'req-7')).rejects.toThrow('no such request');
  });
});
