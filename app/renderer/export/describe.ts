/**
 * How a concept is described in prose, shared by both exports.
 *
 * Lived inside `outline.ts` until that module became a flat map builder. It is
 * its own file now because two exporters need the same answer: the YAML map
 * stores the text once under `notes`, and the HTML page shows it when a reader
 * clicks a concept. A second copy of this logic would let the two surfaces
 * describe the same concept differently, which is the bug it exists to prevent.
 */

import type { GraphNode } from '../../../shared/types/graph';

const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
/**
 * Also eats stray brackets. Typing `[[hi]]]` (one bracket too many, easy to do
 * when the editor auto-closes) otherwise leaves a leading `]` glued to the
 * description in every export.
 */
const LEADING_PUNCTUATION = /^[\s\-–—:,.;\]\[]+/;

/** `[[Label|shown]] text` -> `shown text`; `[[Label]] text` -> `Label text`. */
function stripWikilinks(markdown: string): string {
  return markdown.replace(WIKILINK, (_match, label: string, display?: string) =>
    (display ?? label).trim(),
  );
}

/**
 * The prose a cell contributes about a concept.
 *
 * A cell almost always opens by naming its subject — "[[introduction]] my name
 * is X" — so the concept's own name is dropped from the front. What remains is
 * what the author actually said about it.
 */
function describeFromCell(markdown: string, label: string): string {
  const plain = stripWikilinks(markdown).replace(LEADING_PUNCTUATION, '').trim();
  const lowered = plain.toLowerCase();
  const name = label.trim().toLowerCase();

  if (!lowered.startsWith(name)) return plain;

  const remainder = plain.slice(label.trim().length).replace(LEADING_PUNCTUATION, '');
  // Guard the case where the cell is nothing but the link.
  return remainder.trim().length > 0 ? remainder.trim() : plain;
}

/**
 * The prose describing a concept: the author's explicit note if there is one,
 * otherwise what the cells mentioning it actually say.
 */
export function describeConcept(
  node: GraphNode,
  markdownByCellId: ReadonlyMap<string, string>,
): string {
  // An explicit note is the author speaking directly about the concept, so it
  // outranks anything inferred from surrounding prose.
  if (node.note && node.note.trim().length > 0) return node.note.trim();

  const passages = node.cellIds
    .map((cellId) => markdownByCellId.get(cellId))
    .filter((markdown): markdown is string => typeof markdown === 'string')
    .map((markdown) => describeFromCell(markdown, node.label))
    .filter((text) => text.length > 0);

  return passages.join('\n\n');
}
