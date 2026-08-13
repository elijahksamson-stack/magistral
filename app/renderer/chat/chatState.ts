/**
 * Chat transcript state.
 *
 * Pure and immutable. Nothing here touches React, IPC, or the DOM — a turn is
 * derived by merging the record of what the author asked with the current
 * snapshot of the Claude run answering it. That keeps the rendering path
 * testable without a browser, and keeps the pane a projection of the bridge's
 * state rather than a second copy of it.
 */

import type { ClaudeUsage, CliProvider } from '../../../shared/types/claude';

/**
 * Structural mirror of `ClaudeRun` from app/renderer/shared/useClaude.ts.
 *
 * Declared locally, deliberately: this module must compile and be testable on
 * its own, and TypeScript's structural typing means the real `ClaudeRun` is
 * assignable here without an import that couples the two files.
 */
export interface ClaudeRunSnapshot {
  requestId: string;
  streaming: boolean;
  text: string;
  error: string | null;
  usage: ClaudeUsage | null;
  packs: string[];
  provider?: CliProvider | null;
}

export type ChatTurnStatus =
  /** Accepted by the bridge, nothing streamed back yet. */
  | 'pending'
  | 'streaming'
  /** Finished normally — the bridge reported usage. */
  | 'complete'
  /** Stopped before it finished. No usage was reported. */
  | 'interrupted'
  | 'failed';

/** What the author asked, recorded when the request was accepted. */
export interface ChatTurn {
  readonly id: string;
  readonly prompt: string;
  readonly askedAt: string;
  /**
   * The finished answer, kept on the turn so a transcript survives a restart.
   *
   * While a run is live the run is authoritative — it is the thing streaming.
   * This is what remains once the run is gone, which is every turn from a
   * previous session.
   */
  readonly answer?: string;
  /** Status as it was when the turn finished, for the same reason. */
  readonly finishedStatus?: ChatTurnStatus;
  /** CLI that actually answered, not merely the selector value. */
  readonly provider?: CliProvider;
}

/** A turn merged with the run answering it — the shape the UI renders. */
export interface RenderedTurn {
  readonly id: string;
  readonly prompt: string;
  readonly askedAt: string;
  readonly status: ChatTurnStatus;
  readonly text: string;
  readonly error: string | null;
  readonly packs: readonly string[];
  readonly usage: ClaudeUsage | null;
  readonly provider?: CliProvider;
}

const EMPTY_PACKS: readonly string[] = [];

/**
 * A run carries no explicit cancellation flag, so the state is derived:
 * a finished run that reported neither usage nor an error was stopped.
 */
export function deriveTurnStatus(run: ClaudeRunSnapshot | undefined): ChatTurnStatus {
  if (!run) return 'pending';
  if (run.streaming) return 'streaming';
  if (run.error) return 'failed';
  if (run.usage) return 'complete';
  return 'interrupted';
}

export function isTurnBusy(status: ChatTurnStatus): boolean {
  return status === 'pending' || status === 'streaming';
}

/** True once a turn carries its own outcome and no longer needs a run to read. */
function isSettled(turn: ChatTurn): boolean {
  return turn.answer !== undefined || turn.finishedStatus !== undefined;
}

export function renderTurn(
  turn: ChatTurn,
  run: ClaudeRunSnapshot | undefined,
): RenderedTurn {
  // A live run wins: it is the one streaming. Falling back to what the turn
  // recorded is what makes a restored transcript render at all — those turns
  // have no run, and without this they would all show as empty and pending.
  //
  // A recorded status counts even with no answer under it: a turn that failed
  // or was stopped before the first delta is finished, not waiting.
  if (!run && isSettled(turn)) {
    return {
      id: turn.id,
      prompt: turn.prompt,
      askedAt: turn.askedAt,
      status: turn.finishedStatus ?? 'complete',
      text: turn.answer ?? '',
      error: null,
      packs: EMPTY_PACKS,
      usage: null,
      ...(turn.provider ? { provider: turn.provider } : {}),
    };
  }

  return {
    id: turn.id,
    prompt: turn.prompt,
    askedAt: turn.askedAt,
    status: deriveTurnStatus(run),
    text: run?.text ?? '',
    error: run?.error ?? null,
    packs: run?.packs ?? EMPTY_PACKS,
    usage: run?.usage ?? null,
    ...(run?.provider ?? turn.provider
      ? { provider: (run?.provider ?? turn.provider) as CliProvider }
      : {}),
  };
}

/**
 * Project the whole transcript. Order is the order the author asked in, which
 * is the only order that makes a conversation readable — never the order runs
 * happened to complete.
 */
export function renderTranscript(
  turns: readonly ChatTurn[],
  runs: Readonly<Record<string, ClaudeRunSnapshot>>,
): RenderedTurn[] {
  return turns.map((turn) => renderTurn(turn, runs[turn.id]));
}

/** Immutable append. */
export function appendTurn(turns: readonly ChatTurn[], turn: ChatTurn): ChatTurn[] {
  return [...turns, turn];
}

/**
 * Settle turns read back from storage.
 *
 * A transcript outlives the process; the runs answering it do not. So a
 * restored turn with no recorded outcome is not waiting on anything — it was
 * cut off when the app closed, and there is no run left to finish it. Left
 * alone it derives as 'pending' forever, which reads as "Waiting for the
 * bridge" and pins the composer to Stop before the author has asked anything.
 */
export function sealRestoredTurns(turns: readonly ChatTurn[]): ChatTurn[] {
  return turns.map((turn) =>
    isSettled(turn) ? turn : { ...turn, finishedStatus: 'interrupted' as const },
  );
}

/** The turn a cancel control should act on, if any. */
export function findBusyTurnId(rendered: readonly RenderedTurn[]): string | null {
  const busy = rendered.find((turn) => isTurnBusy(turn.status));
  return busy ? busy.id : null;
}
