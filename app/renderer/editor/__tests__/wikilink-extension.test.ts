/**
 * The decoration layer must agree with the parser exactly — an underline the
 * core will not turn into a node is a lie to the author.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { WIKILINK_CLASS, buildWikilinkDecorations } from '../wikilink-extension';

interface Range {
  from: number;
  to: number;
}

function decoratedRanges(doc: string): Range[] {
  const state = EditorState.create({ doc });
  const set = buildWikilinkDecorations(state.doc.toString());
  const ranges: Range[] = [];

  const cursor = set.iter();
  while (cursor.value !== null) {
    ranges.push({ from: cursor.from, to: cursor.to });
    cursor.next();
  }
  return ranges;
}

describe('buildWikilinkDecorations', () => {
  it('marks each link over its full bracketed span', () => {
    const doc = 'a [[Moat]] b [[Capital Cycle|cycles]] c';
    const ranges = decoratedRanges(doc);

    expect(ranges).toHaveLength(2);
    expect(doc.slice(ranges[0]!.from, ranges[0]!.to)).toBe('[[Moat]]');
    expect(doc.slice(ranges[1]!.from, ranges[1]!.to)).toBe('[[Capital Cycle|cycles]]');
  });

  it('does not decorate inside a fenced code block', () => {
    const doc = ['[[Real]]', '```', '[[Fake]]', '```'].join('\n');
    const ranges = decoratedRanges(doc);

    expect(ranges).toHaveLength(1);
    expect(doc.slice(ranges[0]!.from, ranges[0]!.to)).toBe('[[Real]]');
  });

  it('produces nothing for a document without links', () => {
    expect(decoratedRanges('just prose, no brackets')).toHaveLength(0);
  });

  it('exposes a stable class name for the theme and the click handler', () => {
    expect(WIKILINK_CLASS).toBe('cm-bd-wikilink');
  });
});
