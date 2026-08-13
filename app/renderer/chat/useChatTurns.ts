/**
 * The pane's transcript store, remembered across restarts.
 *
 * A turn is recorded once the bridge has accepted the request and handed back a
 * requestId; while the answer is streaming it lives in `useClaude().runs` and
 * is merged in at render time. Once a run finishes, its text is folded back
 * onto the turn — runs are ephemeral, and without that fold a restart would
 * leave a transcript of questions with no answers.
 *
 * Persisted to localStorage rather than into the vault: a conversation is how
 * the author interrogated the graph, not part of what the graph asserts, and
 * widening the vault schema is what locked a real vault shut once already.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearPersisted,
  readPersisted,
  writePersisted,
} from '../shared/persisted';
import {
  appendTurn,
  sealRestoredTurns,
  type ChatTurn,
  type ChatTurnStatus,
} from './chatState';
import type { CliProvider } from '../../../shared/types/claude';

const SCOPE = 'chat.turns';

/**
 * Cap on remembered turns. A long transcript is worth keeping; an unbounded
 * one eventually blows the storage quota, and the failure would land on some
 * unrelated write later rather than here.
 */
const MAX_REMEMBERED_TURNS = 200;

export interface ChatTurnStore {
  turns: readonly ChatTurn[];
  addTurn: (turn: ChatTurn) => void;
  /** Fold a finished run's text onto its turn so it outlives the run. */
  recordAnswer: (
    turnId: string,
    answer: string,
    status: ChatTurnStatus,
    provider?: CliProvider | null,
  ) => void;
  /** Wipe the transcript — what `/clear` does. */
  clear: () => void;
}

function isChatTurn(value: unknown): value is ChatTurn {
  if (typeof value !== 'object' || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.id === 'string' &&
    typeof turn.prompt === 'string' &&
    typeof turn.askedAt === 'string'
  );
}

function isChatTurnArray(value: unknown): value is ChatTurn[] {
  return Array.isArray(value) && value.every(isChatTurn);
}

export function useChatTurns(vaultId: string | null): ChatTurnStore {
  const [turns, setTurns] = useState<readonly ChatTurn[]>([]);

  // Written on every change; read once per vault.
  const vaultRef = useRef(vaultId);
  vaultRef.current = vaultId;

  // Sealed on the way in: the runs that answered these turns died with the
  // process that made them, so anything still open was cut off, not waiting.
  useEffect(() => {
    setTurns(sealRestoredTurns(readPersisted(SCOPE, vaultId, isChatTurnArray, [])));
  }, [vaultId]);

  const persist = useCallback((next: readonly ChatTurn[]): readonly ChatTurn[] => {
    const trimmed = next.length > MAX_REMEMBERED_TURNS ? next.slice(-MAX_REMEMBERED_TURNS) : next;
    writePersisted(SCOPE, vaultRef.current, trimmed);
    return trimmed;
  }, []);

  const addTurn = useCallback(
    (turn: ChatTurn) => {
      setTurns((previous) => persist(appendTurn(previous, turn)));
    },
    [persist],
  );

  const recordAnswer = useCallback(
    (turnId: string, answer: string, status: ChatTurnStatus, provider?: CliProvider | null) => {
      setTurns((previous) => {
        const target = previous.find((turn) => turn.id === turnId);
        // Nothing to do if the turn is gone or already holds this answer —
        // this fires from a render effect and must not loop.
        if (
          !target ||
          (target.answer === answer &&
            target.finishedStatus === status &&
            target.provider === (provider ?? target.provider))
        ) {
          return previous;
        }
        return persist(
          previous.map((turn) =>
            turn.id === turnId
              ? { ...turn, answer, finishedStatus: status, ...(provider ? { provider } : {}) }
              : turn,
          ),
        );
      });
    },
    [persist],
  );

  const clear = useCallback(() => {
    setTurns([]);
    clearPersisted(SCOPE, vaultRef.current);
  }, []);

  return { turns, addTurn, recordAnswer, clear };
}
