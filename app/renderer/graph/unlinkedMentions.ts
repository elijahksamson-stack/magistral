/**
 * Where a concept is NAMED but not linked.
 *
 * The graph only knows what the author bracketed. Prose written before a
 * concept existed goes on saying its name in plain text forever, and the map
 * never learns about it — the single largest source of edges a knowledge graph
 * silently misses. Obsidian calls these unlinked mentions; this is the same
 * idea, reported per concept so one click can promote a mention into a link.
 *
 * Two rules keep the hunt honest:
 *
 *  - Never inside a `[[link]]`, which is already a link, nor inside fenced
 *    code, where a matching word is a variable name and not a claim.
 *  - Whole words only. Without that, "AI" matches "said", "chain" and
 *    "maintain", and the panel fills with noise the author must read past.
 *
 * Pure: no graph, no IPC, no DOM.
 */

import { protectedRanges, type ByteRange } from './linkSpan';

/** Characters either side of a mention, for the excerpt shown in the panel. */
const EXCERPT_PADDING = 48;

export interface UnlinkedMention {
  readonly cellId: string;
  /** Offset of the mention inside that cell's markdown. */
  readonly index: number;
  /** The text as written, which may differ in case from the node's label. */
  readonly text: string;
  /** Surrounding prose, so the author can tell a real mention from a stray hit. */
  readonly excerpt: string;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isProtected(ranges: readonly ByteRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

/**
 * A word boundary that works for labels ending in punctuation.
 *
 * `\b` is useless against "Who Ultimately Pays?" — the `?` is already a
 * non-word character, so `\b` never matches after it. Testing the neighbouring
 * characters directly handles a label however it ends.
 */
function isBoundary(character: string | undefined): boolean {
  return character === undefined || !/[\w-]/.test(character);
}

function excerptAround(markdown: string, index: number, length: number): string {
  const from = Math.max(0, index - EXCERPT_PADDING);
  const to = Math.min(markdown.length, index + length + EXCERPT_PADDING);
  const body = markdown.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < markdown.length ? '…' : ''}`;
}

/**
 * Every place `label` is written as plain text in these cells.
 *
 * Case-insensitive, because an author who wrote "heat rate" mid-sentence and
 * "Heat Rate" as a heading meant the same concept both times.
 */
export function findUnlinkedMentions(
  cells: readonly { readonly id: string; readonly markdown: string }[],
  label: string,
): UnlinkedMention[] {
  const needle = label.trim();
  if (needle.length === 0) return [];

  const pattern = new RegExp(escapeForRegExp(needle), 'gi');
  const mentions: UnlinkedMention[] = [];

  for (const cell of cells) {
    const ranges = protectedRanges(cell.markdown);
    pattern.lastIndex = 0;
    for (let match = pattern.exec(cell.markdown); match; match = pattern.exec(cell.markdown)) {
      const { index } = match;
      if (isProtected(ranges, index)) continue;
      if (!isBoundary(cell.markdown[index - 1])) continue;
      if (!isBoundary(cell.markdown[index + match[0].length])) continue;

      mentions.push({
        cellId: cell.id,
        index,
        text: match[0],
        excerpt: excerptAround(cell.markdown, index, match[0].length),
      });
    }
  }

  return mentions;
}

/**
 * Wrap one mention in brackets, turning it into a link.
 *
 * Addressed by offset rather than by "the first occurrence": the author is
 * looking at a list and clicked a specific line, and promoting a different
 * mention than the one they pointed at is the kind of small betrayal that stops
 * people trusting a button.
 *
 * The text as written is kept inside the brackets — `[[heat rate]]` resolves to
 * the same node as `[[Heat Rate]]` because the core matches on a normalized
 * label, and rewriting the author's casing is a change they did not ask for.
 */
export function linkMentionAt(markdown: string, index: number, length: number): string {
  if (index < 0 || length <= 0 || index + length > markdown.length) return markdown;
  const written = markdown.slice(index, index + length);
  if (written.trim().length === 0) return markdown;
  return `${markdown.slice(0, index)}[[${written}]]${markdown.slice(index + length)}`;
}
