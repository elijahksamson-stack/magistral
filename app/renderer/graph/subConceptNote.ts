/**
 * Writing a concept's description back into the cell that authored it.
 *
 * Sub-concept notes are not stored. `Graph::Impl::reconcileCellLinks` rebuilds
 * `subConcepts` from the cell's markdown on every edit, and `flattenLine` takes
 * each note from the WHOLE line the link sat on — links unwrapped, emphasis
 * stripped, and the label removed from the front only when the line opens with
 * it. So the description shown in the panel IS that line, and editing it has to
 * rewrite that line. Anything else fragments the paragraph: appending a second
 * line leaves the original text stranded and the author reading two halves of
 * one thought.
 *
 * A consequence worth stating plainly: when a link sits mid-paragraph, that
 * paragraph is the description of BOTH the concept that opens the line and this
 * one. They are the same text because the author wrote them as the same text.
 *
 * Pure string in, string out: no graph, no IPC, no DOM.
 */

/**
 * Leading heading marks, list marker, quote or indentation, so they survive a
 * rewrite. Without `#` here, rewriting `## [[X]] text` silently demoted the
 * line to body prose by dropping the marks along with the old text.
 */
const LINE_PREFIX = /^(\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)?)/;
const ANY_LINK = /\[\[([^\]]+)\]\]/g;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[[Label]]`, case-insensitive, tolerating padding inside the brackets. */
function linkPattern(label: string): RegExp {
  return new RegExp(`\\[\\[\\s*${escapeForRegExp(label.trim())}\\s*\\]\\]`, 'i');
}

/** The label each `[[link]]` on the line points at, in the order written. */
function linkedLabelsOn(line: string): string[] {
  const labels: string[] = [];
  for (const match of line.matchAll(ANY_LINK)) {
    const body = match[1] ?? '';
    // `[[Target|shown]]` links to the target; the pipe is display text.
    const target = (body.split('|')[0] ?? '').trim();
    if (target.length > 0) labels.push(target);
  }
  return labels;
}

/**
 * Re-wrap `label` where it appears as plain text, so a link the author had
 * survives their rewording. First occurrence only: linking every mention would
 * turn a paragraph that returns to its subject into a wall of brackets.
 */
function relink(text: string, label: string): string {
  if (linkPattern(label).test(text)) return text;
  const plain = new RegExp(`(^|[^\\w[])(${escapeForRegExp(label)})(?![\\w\\]])`, 'i');
  const match = plain.exec(text);
  if (!match) return text;
  return `${text.slice(0, match.index)}${match[1]}[[${match[2]}]]${text.slice(match.index + match[0].length)}`;
}

/**
 * Set the description carried by `[[label]]` inside `markdown`.
 *
 * Only the FIRST occurrence is touched: the core deduplicates sub-concepts by
 * first appearance, so a later duplicate is not the one whose note is read and
 * rewriting it would appear to do nothing.
 *
 * Returns the markdown unchanged when the label is not linked at all.
 */
export function setSubConceptNote(markdown: string, label: string, note: string): string {
  const pattern = linkPattern(label);
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return markdown;

  const line = lines[index] ?? '';
  const link = pattern.exec(line)?.[0] ?? `[[${label.trim()}]]`;
  const prefix = LINE_PREFIX.exec(line)?.[1] ?? '';
  const description = note.trim();

  // Nothing left to say about it: the bare link keeps the concept on the map.
  if (description.length === 0) {
    return [...lines.slice(0, index), `${prefix}${link}`, ...lines.slice(index + 1)].join('\n');
  }

  /*
   * Every link the line already carried is restored wherever the new text still
   * mentions it — the author rewrote a paragraph, not the map's structure, and
   * silently dropping a link would remove a relationship they never touched.
   * A label the new text no longer mentions is not forced back in; that is the
   * author's edit, and inventing a mention would put words in the cell.
   */
  let rewritten = description;
  for (const existing of linkedLabelsOn(line)) rewritten = relink(rewritten, existing);
  // The subject has to stay linked, or the panel that is editing it vanishes.
  if (!linkPattern(label).test(rewritten)) rewritten = `${link} ${rewritten}`;

  return [...lines.slice(0, index), `${prefix}${rewritten}`, ...lines.slice(index + 1)].join('\n');
}
