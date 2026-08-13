/**
 * Keyboard predicates for a cell, kept pure so they can be reasoned about
 * (and tested) without an editor instance.
 */

import type { EditorState } from '@codemirror/state';

/** True when the document is empty and the caret is the only selection. */
export function isEmptyCellCaret(state: EditorState): boolean {
  if (state.doc.length > 0) return false;
  const ranges = state.selection.ranges;
  return ranges.length === 1 && (ranges[0]?.empty ?? false);
}

/**
 * Backspace merges into the previous cell only from the very start of an EMPTY
 * cell. Anywhere else Backspace stays Backspace — deleting a character must
 * never destroy a cell boundary the author did not ask to remove.
 */
export function shouldMergeIntoPrevious(state: EditorState): boolean {
  return isEmptyCellCaret(state);
}
