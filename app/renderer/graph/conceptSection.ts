/**
 * A concept's prose inside the cell that authored it.
 *
 * Authors write a cell as sections: a link alone on a line is a heading, and
 * everything under it until the next such heading belongs to that concept.
 *
 *     [[Direct Versus Embedded Material Demand]]
 *
 *     Data-center demand reaches materials through two channels.
 *     * Concrete
 *     ...
 *
 *     [[Next Concept]]
 *
 * The core does not see it that way. `flattenLine` takes a note from the single
 * LINE a link sits on, so a heading link — alone on its line — has an empty
 * note, which is why a concept with pages of prose beneath it reported "No
 * description yet". This module reads the section instead, and writes it back
 * the same way, so the panel and the cell hold the same text.
 *
 * An inline link keeps the core's own rule: its line is its description.
 *
 * Pure string in, string out: no graph, no IPC, no DOM.
 */

/*
 * What may sit in front of a link without changing what the line IS.
 *
 * `#` marks are included deliberately: `## [[Concept]]` is how an author writes
 * a section heading, and omitting them meant such a line was not recognised as
 * a heading at all — the concept reported no description while carrying a whole
 * section, and the search for that section's END ran straight past the next
 * `##` heading and swallowed it too.
 */
const LINE_PREFIX = /^(\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)?)/;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[[Label]]`, case-insensitive, tolerating padding and a `|display` alias. */
function linkPattern(label: string): RegExp {
  return new RegExp(`\\[\\[\\s*${escapeForRegExp(label.trim())}\\s*(\\|[^\\]]*)?\\]\\]`, 'i');
}

/** A line whose entire content is one link: the author's section heading. */
function isHeadingLine(line: string): boolean {
  const bare = line.replace(LINE_PREFIX, '').trim();
  return /^\[\[[^\]]+\]\]$/.test(bare);
}

export interface ConceptSection {
  /** Index of the heading line itself. */
  readonly headingIndex: number;
  /** First line of the body, and one past its last line. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * Locate the section a heading link owns, or null when the link is inline.
 *
 * The body stops at the next heading link, so a cell reads as the author laid
 * it out rather than as one undifferentiated block.
 */
export function findConceptSection(markdown: string, label: string): ConceptSection | null {
  const pattern = linkPattern(label);
  const lines = markdown.split('\n');
  const headingIndex = lines.findIndex((line) => pattern.test(line) && isHeadingLine(line));
  if (headingIndex === -1) return null;

  let bodyEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (isHeadingLine(lines[index] ?? '')) {
      bodyEnd = index;
      break;
    }
  }
  return { headingIndex, bodyStart: headingIndex + 1, bodyEnd };
}

/**
 * The prose a concept owns, or null when it has no section of its own.
 *
 * Null rather than empty string: "this concept is not a heading here" and "this
 * heading has nothing under it yet" are different questions, and only the first
 * should fall back to the note the core derived from an inline line.
 */
export function conceptSectionText(markdown: string, label: string): string | null {
  const section = findConceptSection(markdown, label);
  if (!section) return null;
  return markdown.split('\n').slice(section.bodyStart, section.bodyEnd).join('\n').trim();
}

/**
 * Replace the prose under a concept's heading, keeping the heading itself.
 *
 * A blank line above and below, which is what the author's own sections look
 * like and what stops a markdown list gluing itself onto the heading.
 */
export function setConceptSectionText(markdown: string, label: string, text: string): string {
  const section = findConceptSection(markdown, label);
  if (!section) return markdown;

  const lines = markdown.split('\n');
  const body = text.trim();
  const replacement = body.length > 0 ? ['', ...body.split('\n'), ''] : [''];
  const rebuilt = [
    ...lines.slice(0, section.bodyStart),
    ...replacement,
    ...lines.slice(section.bodyEnd),
  ];

  // Collapse the run of blank lines the splice leaves where the two ends meet.
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}
