/**
 * Backspace destroys a cell boundary only from an empty cell. Anywhere else it
 * must stay an ordinary Backspace.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { isEmptyCellCaret, shouldMergeIntoPrevious } from '../editor-keys';

function stateWith(doc: string, anchor = 0, head = anchor): EditorState {
  return EditorState.create({ doc, selection: { anchor, head } });
}

describe('shouldMergeIntoPrevious', () => {
  it('is true for a caret in an empty cell', () => {
    expect(shouldMergeIntoPrevious(stateWith(''))).toBe(true);
  });

  it('is false when the cell still holds text, even at offset 0', () => {
    expect(shouldMergeIntoPrevious(stateWith('a thesis', 0))).toBe(false);
  });

  it('is false in the middle of a cell', () => {
    expect(shouldMergeIntoPrevious(stateWith('a thesis', 4))).toBe(false);
  });

  it('is false when whitespace remains — that is a character to delete', () => {
    expect(shouldMergeIntoPrevious(stateWith(' ', 0))).toBe(false);
  });

  it('is false when a range is selected', () => {
    expect(shouldMergeIntoPrevious(stateWith('abc', 0, 3))).toBe(false);
  });
});

describe('isEmptyCellCaret', () => {
  it('agrees with the merge predicate', () => {
    expect(isEmptyCellCaret(stateWith(''))).toBe(true);
    expect(isEmptyCellCaret(stateWith('x'))).toBe(false);
  });
});
