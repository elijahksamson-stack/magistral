/**
 * @vitest-environment jsdom
 *
 * The storage boundary of the transcript.
 *
 * localStorage outlives the process, but a run does not: it belongs to the
 * bridge that answered, and dies with it. So a turn read back from storage can
 * never become live, and anything the previous session left unfinished has to
 * be settled on the way in.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearPersisted, writePersisted } from '../shared/persisted';
import type { ChatTurn } from './chatState';
import { useChatTurns } from './useChatTurns';

const SCOPE = 'chat.turns';
const VAULT_ID = 'vault-1';

const ASKED: ChatTurn = {
  id: 'req-1',
  prompt: 'what binds?',
  askedAt: '2026-08-06T12:00:00.000Z',
};

/** Written through the same wrapper the hook reads, whatever store is in play. */
function seed(turns: readonly ChatTurn[]): void {
  writePersisted(SCOPE, VAULT_ID, turns);
}

beforeEach(() => {
  clearPersisted(SCOPE, VAULT_ID);
});

describe('useChatTurns', () => {
  it('settles a turn the previous session left unfinished', () => {
    // The app was closed mid-answer, so nothing was ever folded onto the turn.
    seed([ASKED]);

    const { result } = renderHook(() => useChatTurns(VAULT_ID));

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]!.finishedStatus).toBe('interrupted');
  });

  it('restores a finished turn exactly as it was stored', () => {
    const finished: ChatTurn = {
      ...ASKED,
      answer: 'The binding constraint moves.',
      finishedStatus: 'complete',
    };
    seed([finished]);

    const { result } = renderHook(() => useChatTurns(VAULT_ID));

    expect(result.current.turns[0]).toEqual(finished);
  });

  it('starts empty when the vault has no stored transcript', () => {
    const { result } = renderHook(() => useChatTurns(VAULT_ID));

    expect(result.current.turns).toEqual([]);
  });
});
