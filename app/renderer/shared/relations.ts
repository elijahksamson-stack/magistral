/**
 * How a relation kind reads in a sentence.
 *
 * Shared because two panes now render the same relationship in prose — the
 * edge editor on the canvas and the completion review in chat — and a
 * relationship that reads "affects" in one place and "impacts" in the other
 * would look like two different things.
 */

import type { RelationKind } from '../../../shared/types/graph';

/** Reads as a sentence between the two labels: "A <phrase> B". */
export const RELATION_PHRASING: Record<RelationKind, string> = {
  relates_to: 'relates to',
  causes: 'causes',
  part_of: 'is part of',
  contradicts: 'contradicts',
  supports: 'supports',
  depends_on: 'depends on',
  instance_of: 'is an instance of',
  mentions: 'mentions',
  affects: 'affects',
  affected_by: 'is affected by',
};

/** "EUV affects Semis" — the whole relationship as one readable line. */
export function relationSentence(
  source: string,
  relation: RelationKind,
  target: string,
): string {
  return `${source} ${RELATION_PHRASING[relation]} ${target}`;
}
