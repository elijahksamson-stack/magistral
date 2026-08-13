/**
 * The send and cancel paths, as plain async functions.
 *
 * Kept out of the component so the request the pane builds — in particular the
 * `resumeSessionId` that makes the conversation persistent instead of amnesiac —
 * can be asserted directly.
 */

import type { ChatInvokeRequest, GraphContext } from '../../../shared/types/claude';
import type { ChatTurn } from './chatState';

export type ChatInvoker = (
  request: Omit<ChatInvokeRequest, 'requestId'>,
) => Promise<string>;

export type ChatCanceller = (requestId: string) => Promise<void>;

export interface SendChatTurnOptions {
  invoke: ChatInvoker;
  message: string;
  /** Compact graph summary, omitted when no vault is open. */
  graphContext?: GraphContext;
  /**
   * Session to resume. Null on the first turn only — after that the chat must
   * resume so the model keeps the conversation rather than restarting it.
   */
  sessionId: string | null;
  /** Injected so the recorded timestamp is deterministic under test. */
  now?: () => string;
}

/**
 * Build the request, hand it to the bridge, and return the turn to record.
 *
 * Returns null for an empty message — a blank turn would spend allowance and
 * teach the model nothing.
 */
export async function sendChatTurn(
  options: SendChatTurnOptions,
): Promise<ChatTurn | null> {
  const prompt = options.message.trim();
  if (prompt.length === 0) return null;

  const request: Omit<ChatInvokeRequest, 'requestId'> = {
    kind: 'chat',
    message: prompt,
    ...(options.graphContext ? { graphContext: options.graphContext } : {}),
    ...(options.sessionId ? { resumeSessionId: options.sessionId } : {}),
  };

  const requestId = await options.invoke(request);
  const askedAt = (options.now ?? defaultNow)();

  return { id: requestId, prompt, askedAt };
}

/**
 * Cancel an in-flight turn. Failure is surfaced, never swallowed: a cancel that
 * silently did nothing leaves the user watching a stream they asked to stop.
 */
export async function cancelChatTurn(
  cancel: ChatCanceller,
  requestId: string | null,
): Promise<void> {
  if (!requestId) return;
  await cancel(requestId);
}

function defaultNow(): string {
  return new Date().toISOString();
}
