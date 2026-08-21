/**
 * Which answer auto-map reads next.
 *
 * Auto-map turns a conversation into proposed concepts as the author talks. The
 * scheduling rules are small, but each exists because its absence is a bug the
 * author would feel, so they live here as a pure function rather than inside a
 * `useEffect` where they cannot be tested:
 *
 *  - Only FINISHED answers. Half a paragraph names half the concepts, and the
 *    proposal built from it would be wrong in a way that looks right.
 *  - Only answers with something in them. A stopped or failed turn has no
 *    concepts to find, and reading it spends a CLI run to learn that.
 *  - One at a time. A proposal already on screen is one the author is still
 *    deciding about; replacing it would discard the boxes they had ticked.
 *  - Never an answer already read, however often the pane re-renders.
 *
 * Pure: no React, no IPC, no DOM.
 */

import type { RenderedTurn } from './chatState';

/**
 * The oldest unread, finished, non-empty answer — or null when there is nothing
 * to read.
 *
 * Oldest first, so a burst of questions is mapped in the order they were asked.
 * Read out of order, the review panel would show concepts with no relation to
 * what the author last said.
 */
export function nextTurnToMap(
  turns: readonly RenderedTurn[],
  alreadyMapped: ReadonlySet<string>,
): RenderedTurn | null {
  for (const turn of turns) {
    if (alreadyMapped.has(turn.id)) continue;
    if (turn.status !== 'complete') continue;
    if (turn.error) continue;
    if (turn.text.trim().length === 0) continue;
    return turn;
  }
  return null;
}

/**
 * The turns to treat as already read when auto-map is switched ON.
 *
 * Everything currently in the transcript. Turning the toggle on is a request
 * about what the author says NEXT — firing twenty proposals at a conversation
 * they already had, and already chose not to map, is not that.
 */
export function seenTurnIds(turns: readonly RenderedTurn[]): Set<string> {
  return new Set(turns.map((turn) => turn.id));
}
