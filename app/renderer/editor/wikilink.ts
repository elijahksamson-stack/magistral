/**
 * [[wikilink]] parsing — the editor-side mirror of the C++ core's parser.
 *
 * The core (`Graph::syncCell`) is the authority: it parses `[[Label]]` and
 * `[[Label|display text]]` out of a cell's markdown and reconciles the graph.
 * This module reproduces that rule so the decoration the author sees is exactly
 * the set of links the graph will contain — no phantom underlines, no silent
 * links.
 *
 * Deliberately dependency-free: no CodeMirror, no React. The CodeMirror
 * ViewPlugin in `wikilink-extension.ts` consumes it.
 */

/** One `[[...]]` occurrence located in a markdown string. */
export interface WikilinkRef {
  /** Offset of the opening `[`. */
  from: number;
  /** Offset just past the closing `]]`. */
  to: number;
  /** The link target as authored — the part before any `|`. */
  label: string;
  /** What the reader sees: the piped display text, or the label. */
  display: string;
  /** Dedup key. Mirrors `braindump::normalizeLabel`. */
  normalizedLabel: string;
}

/** Matches `[[anything but brackets or newline]]`, non-greedy. */
const WIKILINK_PATTERN = /\[\[([^[\]\n]+?)\]\]/g;

/** A fence is three or more backticks or tildes, indented at most three spaces. */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Re-exported so this module stays the one place the editor asks about links.
 * The rule itself lives in shared/, because the main process needs the very
 * same answer when it decides whether a proposed concept already exists.
 */
import { normalizeLabel } from '../../../shared/labels';

export { normalizeLabel };

/** True when `line` opens or closes a fenced code block. */
function readFenceMarker(line: string): string | null {
  const match = FENCE_PATTERN.exec(line);
  return match?.[1] ?? null;
}

/**
 * A fence closes only on a marker of the same character and at least the same
 * length — so ```` ``` ```` inside a ```` ~~~~ ```` block does not end it.
 */
function isClosingFence(marker: string, openMarker: string): boolean {
  return marker[0] === openMarker[0] && marker.length >= openMarker.length;
}

/** Split a `[[...]]` body into its label and display text. */
function splitLinkBody(body: string): { label: string; display: string } | null {
  const pipeIndex = body.indexOf('|');
  const label = (pipeIndex === -1 ? body : body.slice(0, pipeIndex)).trim();
  if (label.length === 0) return null;

  const piped = pipeIndex === -1 ? '' : body.slice(pipeIndex + 1).trim();
  return { label, display: piped.length > 0 ? piped : label };
}

/** Collect the links on one line, offsetting each range by `lineStart`. */
function parseLine(line: string, lineStart: number): WikilinkRef[] {
  const refs: WikilinkRef[] = [];
  WIKILINK_PATTERN.lastIndex = 0;

  for (let match = WIKILINK_PATTERN.exec(line); match; match = WIKILINK_PATTERN.exec(line)) {
    const body = match[1];
    if (body === undefined) continue;

    const parts = splitLinkBody(body);
    if (parts === null) continue;

    const normalizedLabel = normalizeLabel(parts.label);
    if (normalizedLabel.length === 0) continue;

    refs.push({
      from: lineStart + match.index,
      to: lineStart + match.index + match[0].length,
      label: parts.label,
      display: parts.display,
      normalizedLabel,
    });
  }

  return refs;
}

/**
 * Every `[[wikilink]]` in `markdown`, in ascending document order.
 *
 * Links inside fenced code blocks are excluded — a code sample that happens to
 * contain `[[x]]` is not an assertion about the graph.
 */
export function parseWikilinks(markdown: string): readonly WikilinkRef[] {
  const lines = markdown.split('\n');
  const refs: WikilinkRef[] = [];

  let lineStart = 0;
  let openFence: string | null = null;

  for (const line of lines) {
    const marker = readFenceMarker(line);

    if (openFence !== null) {
      if (marker !== null && isClosingFence(marker, openFence)) openFence = null;
    } else if (marker !== null) {
      openFence = marker;
    } else {
      refs.push(...parseLine(line, lineStart));
    }

    lineStart += line.length + 1; // +1 for the consumed '\n'
  }

  return refs;
}

/** Distinct normalized labels referenced by a cell, in first-seen order. */
export function collectLinkedLabels(markdown: string): readonly string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const ref of parseWikilinks(markdown)) {
    if (seen.has(ref.normalizedLabel)) continue;
    seen.add(ref.normalizedLabel);
    labels.push(ref.label);
  }

  return labels;
}

/** The link containing `offset`, or null when the offset is outside every link. */
export function findWikilinkAt(
  markdown: string,
  offset: number,
): WikilinkRef | null {
  for (const ref of parseWikilinks(markdown)) {
    if (offset >= ref.from && offset <= ref.to) return ref;
  }
  return null;
}
