/**
 * What a collapsed cell shows.
 *
 * The title is the cell's FIRST [[wikilink]], because that is exactly what the
 * core promotes to a node — so a collapsed cell reads with the same name as its
 * concept on the canvas. Anything else would make the two views disagree about
 * what a cell is called.
 *
 * Pure, so both are testable without a DOM.
 */

import { parseWikilinks } from './wikilink';

/** Shown when a cell has no link yet — it has no concept, so no name. */
export const UNTITLED_CELL = 'Untitled cell';

const SUMMARY_MAX_CHARS = 90;
const HEADING_OR_EMPHASIS = /^[#>\s*_-]+|[*_`]+/g;

/** The cell's concept name: its first wikilink, or a placeholder. */
export function cellTitleOf(markdown: string): string {
  const first = parseWikilinks(markdown)[0];
  if (first && first.label.trim().length > 0) return first.label.trim();

  return UNTITLED_CELL;
}

/**
 * A one-line gist for the collapsed row, taken from the first prose line that
 * is not the title itself. Markdown decoration is stripped so a distilled cell
 * does not collapse to "## **Takeaways**".
 */
export function cellSummaryOf(markdown: string): string {
  const title = cellTitleOf(markdown).toLowerCase();

  for (const rawLine of markdown.split('\n')) {
    const plain = rawLine
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, label: string, display?: string) =>
        (display ?? label).trim(),
      )
      .replace(HEADING_OR_EMPHASIS, '')
      .trim();

    if (plain.length === 0) continue;
    if (plain.toLowerCase() === title) continue;

    return plain.length > SUMMARY_MAX_CHARS
      ? `${plain.slice(0, SUMMARY_MAX_CHARS).trimEnd()}…`
      : plain;
  }
  return '';
}
