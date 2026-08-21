/**
 * Reading and writing the description a `[[link]]` owns inside its cell.
 *
 * The rule, mirroring `core/src/wikilink.cpp` exactly: a link owns the text from
 * the end of its own `]]` until the start of the next link, or the end of the
 * cell. The first link names the node; every later link is a sub-concept.
 *
 * This module replaced `conceptSection.ts` and `subConceptNote.ts`, which
 * implemented two competing rules — one for a link alone on its line, one for a
 * link mid-paragraph — and disagreed about aliases. `[[Volleyball|the net game]]`
 * matched the section reader and not the inline writer, so editing such a
 * description silently did nothing. Locating spans by scanning rather than by
 * building a regex per label removes that whole class of bug: there is no
 * pattern left to get wrong.
 *
 * `markdown.slice(bodyStart, bodyEnd)` IS the description, so reading one and
 * writing it back unchanged returns the cell byte-for-byte. That is what lets
 * the detail panel edit one concept without disturbing the concepts sharing its
 * paragraph.
 *
 * Pure string in, string out: no graph, no IPC, no DOM.
 */

import { normalizeLabel } from '../../../shared/labels';

/**
 * What may sit between a link and the description it introduces: an em dash, a
 * colon, or the emphasis closing a bolded link in `- **[[X]]** foo`. Trimmed
 * from the front only — the same characters inside a description are the
 * author's own markdown, and `bodyStart` sits after this run so a rewrite
 * preserves them.
 */
const LEADING_SEPARATOR = /[\s\-:,|>*_`]/;

/** Up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface LinkSpan {
  /** The link target, as authored. `[[A|b]]` yields `A`. */
  readonly label: string;
  /** Offset of the opening `[`. */
  readonly linkStart: number;
  /** Offset one past the closing `]]`. */
  readonly linkEnd: number;
  /** First character of the description. Equals `bodyEnd` when there is none. */
  readonly bodyStart: number;
  /** One past the last character of the description. */
  readonly bodyEnd: number;
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Byte ranges covered by fenced code blocks, including their fence lines.
 *
 * Spans cross line boundaries, so a fence can no longer be skipped by declining
 * to scan a line. Located once, then excluded from the link scan — but NOT from
 * a span's text: excising code here would make the read lossy, and the panel
 * writes back what it reads, so the author's first description edit would
 * delete their code block.
 */
function fencedRegions(markdown: string): ByteRange[] {
  const regions: ByteRange[] = [];
  let openMarker: string | null = null;
  let regionStart = 0;
  let offset = 0;

  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1] ?? null;
    if (marker !== null) {
      if (openMarker === null) {
        openMarker = marker;
        regionStart = offset;
      } else if (marker[0] === openMarker[0] && marker.length >= openMarker.length) {
        openMarker = null;
        regions.push({
          start: regionStart,
          end: Math.min(offset + line.length + 1, markdown.length),
        });
      }
    }
    offset += line.length + 1;
  }

  // An unclosed fence runs to the end of the cell, as a renderer would read it.
  if (openMarker !== null) regions.push({ start: regionStart, end: markdown.length });
  return regions;
}

function regionAt(regions: readonly ByteRange[], position: number): ByteRange | undefined {
  return regions.find((region) => position >= region.start && position < region.end);
}

/** The link target: text before the first `|`, trimmed. */
function linkTarget(body: string): string {
  return (body.split('|')[0] ?? '').trim();
}

interface LinkMatch {
  readonly label: string;
  readonly linkStart: number;
  readonly linkEnd: number;
  /** `![[file.png]]` embeds a file; it does not assert a concept. */
  readonly isEmbed: boolean;
}

/**
 * Every link in the cell, in order, skipping fenced code.
 *
 * A second `[[` before any `]]` means the inner link is the real one, so
 * `[[Outer [[Inner]]]]` resolves to Inner. A candidate body spanning a newline
 * is rejected: a label is a single line, and without that rule one unclosed
 * `[[` would swallow the rest of the cell.
 */
function scanLinks(markdown: string, regions: readonly ByteRange[]): LinkMatch[] {
  const matches: LinkMatch[] = [];
  let openAt = -1;
  let openedFrom = -1;
  let openIsEmbed = false;
  let i = 0;

  while (i + 1 < markdown.length) {
    const region = regionAt(regions, i);
    if (region) {
      i = region.end;
      openAt = -1;
      openedFrom = -1;
      openIsEmbed = false;
      continue;
    }

    if (markdown[i] === '[' && markdown[i + 1] === '[') {
      openedFrom = i;
      openAt = i + 2;
      // Mirrors the core: an embed is a file, not a concept. Recording one
      // would put its filename on the map as a node.
      openIsEmbed = i > 0 && markdown[i - 1] === '!';
      i += 2;
      continue;
    }
    if (markdown[i] === ']' && markdown[i + 1] === ']') {
      if (openAt !== -1) {
        const body = markdown.slice(openAt, i);
        const label = linkTarget(body);
        if (!body.includes('\n') && label.length > 0 && normalizeLabel(label).length > 0) {
          matches.push({
            label,
            // The `!` belongs to the embed, so the range covers it — otherwise
            // a plain-text scan would see a stray `!` outside any protected span.
            linkStart: openIsEmbed ? openedFrom - 1 : openedFrom,
            linkEnd: i + 2,
            isEmbed: openIsEmbed,
          });
        }
        openAt = -1;
        openedFrom = -1;
        openIsEmbed = false;
      }
      i += 2;
      continue;
    }
    i += 1;
  }

  return matches;
}

/**
 * Every link and the description it owns, deduplicated by normalized label.
 *
 * First occurrence wins, matching the core: a label written twice in one cell is
 * one sub-concept, and only the first is the one whose description is read — so
 * only the first is the one a rewrite may touch.
 */
export function findLinkSpans(markdown: string): LinkSpan[] {
  const regions = fencedRegions(markdown);
  /*
   * Embeds are dropped before spans are measured, not merely skipped over. An
   * `![[chart.png]]` sitting inside a concept's description is part of that
   * description; ending the span at it would cut the prose in half and leave
   * everything after the image belonging to no concept at all.
   */
  const matches = scanLinks(markdown, regions).filter((match) => !match.isEmbed);
  const spans: LinkSpan[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const key = normalizeLabel(match.label);
    if (seen.has(key)) continue;
    seen.add(key);

    const next = matches[index + 1];
    const rawEnd = next ? next.linkStart : markdown.length;

    /*
     * When the next link begins on a LATER line, the text on that link's own
     * line ahead of it introduces that line rather than continuing this
     * description — a list marker, a `## ` heading mark, or the opening clause
     * of a sentence the next link completes. Keeping it would end this
     * description with a stranded fragment. Within one line nothing is dropped,
     * so `[[A]] one [[B]] two` reads exactly as written.
     */
    let end = rawEnd;
    if (next) {
      const lastNewline = markdown.lastIndexOf('\n', rawEnd - 1);
      if (lastNewline >= match.linkEnd) end = lastNewline;
    }

    let bodyStart = match.linkEnd;
    while (bodyStart < end && LEADING_SEPARATOR.test(markdown[bodyStart] ?? '')) bodyStart += 1;
    let bodyEnd = end;
    while (bodyEnd > bodyStart && /\s/.test(markdown[bodyEnd - 1] ?? '')) bodyEnd -= 1;

    spans.push({
      label: match.label,
      linkStart: match.linkStart,
      linkEnd: match.linkEnd,
      bodyStart,
      bodyEnd,
    });
  }

  return spans;
}

/**
 * Ranges a plain-text scan must not look inside: fenced code, and links.
 *
 * Exported for the unlinked-mention hunt, which asks "where is this concept
 * named without being linked?" — a question that is only meaningful outside the
 * links themselves and outside code samples. Every link is returned, not just
 * the first per label, because a repeated label is still a link at each spot.
 */
export function protectedRanges(markdown: string): ByteRange[] {
  const regions = fencedRegions(markdown);
  const links = scanLinks(markdown, regions).map((match) => ({
    start: match.linkStart,
    end: match.linkEnd,
  }));
  return [...regions, ...links];
}

function spanFor(markdown: string, label: string): LinkSpan | undefined {
  const key = normalizeLabel(label);
  return findLinkSpans(markdown).find((span) => normalizeLabel(span.label) === key);
}

/**
 * The description `label` owns, or null when the cell does not link it at all.
 *
 * Null rather than empty string: "this cell never mentions the concept" and
 * "the concept is mentioned with nothing said about it" are different answers,
 * and only the first means the caller is looking at the wrong cell.
 */
export function linkSpanText(markdown: string, label: string): string | null {
  const span = spanFor(markdown, label);
  return span ? markdown.slice(span.bodyStart, span.bodyEnd) : null;
}

/** True when nothing but whitespace follows the link on its own line. */
function isBlockShaped(markdown: string, span: LinkSpan): boolean {
  const lineEnd = markdown.indexOf('\n', span.linkEnd);
  const rest = markdown.slice(span.linkEnd, lineEnd === -1 ? markdown.length : lineEnd);
  return rest.trim().length === 0;
}

/** Collapse the blank-line run a splice leaves where its two ends meet. */
function tidy(markdown: string): string {
  return markdown.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Replace the description `label` owns, leaving every other concept untouched.
 *
 * Returns the markdown unchanged when the cell does not link the label, which
 * the caller should report as a failure rather than swallow — after this
 * module, an unchanged result can no longer mean "the pattern did not match".
 *
 * The written shape follows the shape the author used: a link alone on its line
 * keeps its prose in a block beneath it; an inline link keeps its description on
 * the same line.
 */
export function setLinkSpanText(markdown: string, label: string, text: string): string {
  const span = spanFor(markdown, label);
  if (!span) return markdown;

  const body = text.trim();
  const tail = markdown.slice(span.bodyEnd);

  if (isBlockShaped(markdown, span)) {
    const head = markdown.slice(0, span.linkEnd);
    // The newline before the tail separates the body from whatever follows.
    // With nothing following, adding it appends a trailing blank line to the
    // cell on every save — the last concept in a cell would grow one per edit.
    const separator = tail.length > 0 ? '\n' : '';
    if (body.length === 0) return tidy(`${head}${separator}${tail}`);
    return tidy(`${head}\n\n${body}${separator}${tail}`);
  }

  // Inline: `bodyStart` already sits past the separator the author wrote, so
  // splicing there keeps their `— ` or `**` exactly where it was.
  if (body.length === 0) return tidy(`${markdown.slice(0, span.linkEnd)}${tail}`);
  return tidy(`${markdown.slice(0, span.bodyStart)}${body}${tail}`);
}
