/**
 * Canonical markdown written when a graph node needs an Editor cell.
 *
 * This lives in shared/ because both renderer actions and the main-process
 * integrity repair create cells. If those paths spell a concept cell
 * differently, an imported node can appear on the canvas without ever becoming
 * a normal editable thought in the Editor.
 */

import type { GraphNode, SubConcept } from './types/graph';

/** Remove link delimiters from prose without flattening its useful structure. */
function safeProse(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\[\[|\]\]/g, '')
    .trim();
}

/**
 * `[[Label]] note`, or bare `[[Label]]` when there is no note.
 *
 * Used for short, newly proposed concepts. The note is flattened because any
 * later wikilink in the same cell is interpreted as a facet of the first one.
 */
export function cellMarkdownFor(label: string, note?: string): string {
  const prose = safeProse(note ?? '').replace(/\s+/g, ' ');
  return prose.length > 0 ? `[[${label}]] ${prose}` : `[[${label}]]`;
}

function toSubConcept(value: SubConcept | string): SubConcept | null {
  if (typeof value === 'string') {
    const label = value.trim();
    return label.length > 0 ? { label } : null;
  }
  const label = value.label.trim();
  return label.length > 0 ? { label, note: value.note } : null;
}

/**
 * Preserve the full content of an externally-created node while giving it the
 * same first-wikilink shape as every authored Editor cell.
 */
export function nodeCellMarkdownFor(
  node: Pick<GraphNode, 'label' | 'note' | 'subConcepts'>,
): string {
  const sections = [`[[${node.label}]]`];
  const note = safeProse(node.note ?? '');
  if (note.length > 0) sections.push(note);

  const rawSubConcepts = (node.subConcepts ?? []) as readonly (SubConcept | string)[];
  const subConcepts = rawSubConcepts
    .map(toSubConcept)
    .filter((value): value is SubConcept => value !== null);
  if (subConcepts.length > 0) {
    const lines = subConcepts.map((subConcept) => {
      const detail = safeProse(subConcept.note ?? '').replace(/\s+/g, ' ');
      return detail.length > 0
        ? `- [[${subConcept.label}]] — ${detail}`
        : `- [[${subConcept.label}]]`;
    });
    sections.push(`## Related concepts\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
