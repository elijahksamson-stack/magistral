/**
 * Persistent chat session tracking.
 *
 * `useClaude()` exposes the streamed text but not the session id, and without
 * the session id every turn would start a fresh conversation — the model would
 * lose everything the author established a message ago. So the pane listens to
 * the raw `claude:stream` channel alongside the hook and keeps the latest
 * session id for the turns it owns.
 */

import type { ClaudeStreamEvent } from '../../../shared/types/claude';
import type { BrainDumpApi } from '../../../shared/types/ipc';

/** The subset of the preload surface this module needs. */
export type StreamSource = Pick<BrainDumpApi, 'on'>;

/** Events that carry a session id worth keeping. */
export function readSessionId(event: ClaudeStreamEvent): string | null {
  if (event.type === 'started' || event.type === 'done') return event.sessionId;
  return null;
}

/**
 * Subscribe to the bridge and report every session id belonging to this pane.
 *
 * Events for requests this pane did not issue are ignored — the editor's ✦
 * actions share the channel and carry their own per-cell sessions, and adopting
 * one of those would splice the wrong conversation into the chat.
 *
 * Returns the unsubscribe handle from the preload API.
 */
export function subscribeSessionId(
  api: StreamSource,
  isOwned: (requestId: string) => boolean,
  onSessionId: (sessionId: string) => void,
): () => void {
  return api.on('claude:stream', (event) => {
    if (!isOwned(event.requestId)) return;
    const sessionId = readSessionId(event);
    if (sessionId) onSessionId(sessionId);
  });
}
