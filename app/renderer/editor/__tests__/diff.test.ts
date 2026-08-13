import { describe, expect, it } from 'vitest';
import { MAX_DIFF_LINES, diffLines, summarizeDiff } from '../diff';

describe('diffLines', () => {
  it('reports an untouched document as all context', () => {
    const lines = diffLines('a\nb', 'a\nb');
    expect(lines.every((line) => line.kind === 'context')).toBe(true);
  });

  it('marks an inserted line as added and keeps the rest as context', () => {
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'added', text: 'b' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('marks a deleted line as removed', () => {
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('shows a rewrite as a removal followed by an addition', () => {
    expect(diffLines('old', 'new')).toEqual([
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
    ]);
  });

  it('shows an append as pure additions', () => {
    const lines = diffLines('a', 'a\n\nb');
    expect(lines.filter((line) => line.kind === 'removed')).toEqual([]);
    expect(summarizeDiff(lines)).toEqual({ added: 2, removed: 0 });
  });

  it('handles an empty starting document', () => {
    expect(diffLines('', 'first')).toEqual([{ kind: 'added', text: 'first' }]);
  });

  it('falls back to a whole-block diff past the size cap', () => {
    const before = Array.from({ length: MAX_DIFF_LINES }, (_v, i) => `b${i}`).join('\n');
    const after = Array.from({ length: MAX_DIFF_LINES }, (_v, i) => `a${i}`).join('\n');
    const stats = summarizeDiff(diffLines(before, after));

    expect(stats).toEqual({ added: MAX_DIFF_LINES, removed: MAX_DIFF_LINES });
  });
});

describe('summarizeDiff', () => {
  it('counts additions and removals, ignoring context', () => {
    expect(summarizeDiff(diffLines('a\nb\nc', 'a\nx\nc'))).toEqual({ added: 1, removed: 1 });
  });
});
