import { describe, expect, test } from 'vitest';
import { findLinkSpans, linkSpanText, setLinkSpanText } from '../linkSpan';

/** The author's own example: three links, one line, three descriptions. */
const CONVERSATION =
  '[[Greeting]] hi how are you [[Response]] good and you? [[Final Response]] Kinda tired, ready for bed.';

/** The `test` vault cell: a heading link, then a shared paragraph. */
const SPORTS = [
  '[[Sports]]',
  '',
  '[[Basketball]] scores by shot distance. [[Volleyball]] keeps its rotations constant. [[Baseball]] paces itself over 9 innings.',
].join('\n');

const SECTIONS = [
  '## [[Direct Versus Embedded Material Demand]]',
  '',
  'Data-center demand reaches materials through two channels.',
  '',
  '* Concrete',
  '* Structural steel',
  '',
  '## [[Next Concept]]',
  '',
  'Something else entirely.',
].join('\n');

describe('linkSpanText', () => {
  test('each link on one line owns the text up to the next link', () => {
    expect(linkSpanText(CONVERSATION, 'Greeting')).toBe('hi how are you');
    expect(linkSpanText(CONVERSATION, 'Response')).toBe('good and you?');
    expect(linkSpanText(CONVERSATION, 'Final Response')).toBe('Kinda tired, ready for bed.');
  });

  /*
   * The reported bug: all three shared one paragraph, so the detail panel showed
   * every concept the whole paragraph — Basketball's description talked about
   * volleyball and baseball.
   */
  test('links sharing a paragraph each get their own sentence', () => {
    expect(linkSpanText(SPORTS, 'Basketball')).toBe('scores by shot distance.');
    expect(linkSpanText(SPORTS, 'Volleyball')).toBe('keeps its rotations constant.');
    expect(linkSpanText(SPORTS, 'Baseball')).toBe('paces itself over 9 innings.');
  });

  test('a link with nothing before the next one has an empty description', () => {
    expect(linkSpanText(SPORTS, 'Sports')).toBe('');
  });

  test('a link alone on its line owns the prose beneath it', () => {
    expect(linkSpanText(SECTIONS, 'Direct Versus Embedded Material Demand')).toBe(
      'Data-center demand reaches materials through two channels.\n\n* Concrete\n* Structural steel',
    );
  });

  test('the last link owns the rest of the cell', () => {
    expect(linkSpanText(SECTIONS, 'Next Concept')).toBe('Something else entirely.');
  });

  test('the next heading marks are not swallowed by the link above them', () => {
    expect(linkSpanText(SECTIONS, 'Direct Versus Embedded Material Demand')).not.toContain('#');
  });

  test('matches the label however it was cased', () => {
    expect(linkSpanText('[[alpha]]\n\nIts prose.', 'Alpha')).toBe('Its prose.');
  });

  test('an alias is found by its target, not its display text', () => {
    const cell = '[[Root]] head\n\n[[Volleyball|the net game]] keeps its rotations constant.';
    expect(linkSpanText(cell, 'Volleyball')).toBe('keeps its rotations constant.');
  });

  test('null when the cell does not link the label at all', () => {
    expect(linkSpanText('[[Alpha]] prose', 'Beta')).toBeNull();
  });

  test('a link inside a fence is not a link', () => {
    const cell = '[[Alpha]] real.\n\n```\n[[NotALink]] fenced\n```\n';
    expect(findLinkSpans(cell).map((span) => span.label)).toEqual(['Alpha']);
  });

  /*
   * `![[file.png]]` embeds a file. Treating it as a link put every image an
   * author dropped into a cell on the map as a node named after its filename.
   */
  test('an embedded file is not a concept', () => {
    const cell = '[[Turbine]] rises with inlet temperature.\n\n![[curve.png]]\n';

    expect(findLinkSpans(cell).map((span) => span.label)).toEqual(['Turbine']);
  });

  test('an embed inside a description does not cut the description short', () => {
    const cell = '[[Turbine]] rises. ![[curve.png]] Especially in summer.';

    // The image sits inside what the concept says, so the prose either side of
    // it belongs to the same concept.
    expect(linkSpanText(cell, 'Turbine')).toBe('rises. ![[curve.png]] Especially in summer.');
  });

  test('a link after an embed is still found', () => {
    const cell = '[[Alpha]] see ![[chart.png]] then [[Beta]] follows.';

    expect(findLinkSpans(cell).map((span) => span.label)).toEqual(['Alpha', 'Beta']);
  });

  test('the first of a repeated label is the one that carries the description', () => {
    const cell = '[[Alpha]] first. [[Beta]] middle. [[Alpha]] second.';
    expect(findLinkSpans(cell).map((span) => span.label)).toEqual(['Alpha', 'Beta']);
    expect(linkSpanText(cell, 'Alpha')).toBe('first.');
  });
});

describe('setLinkSpanText', () => {
  /*
   * The invariant the detail panel depends on. Reading a description and writing
   * it straight back must not disturb the cell, or opening a concept and
   * clicking away would rewrite the author's markdown.
   */
  test.each([
    ['Greeting', CONVERSATION],
    ['Response', CONVERSATION],
    ['Final Response', CONVERSATION],
    ['Basketball', SPORTS],
    ['Volleyball', SPORTS],
    ['Direct Versus Embedded Material Demand', SECTIONS],
    ['Next Concept', SECTIONS],
  ])('writing %s back unchanged leaves the cell byte-identical', (label, cell) => {
    const current = linkSpanText(cell, label) ?? '';
    expect(setLinkSpanText(cell, label, current)).toBe(cell);
  });

  test('rewriting one concept leaves the ones sharing its paragraph alone', () => {
    const next = setLinkSpanText(SPORTS, 'Volleyball', 'is played over a net.');
    expect(linkSpanText(next, 'Volleyball')).toBe('is played over a net.');
    expect(linkSpanText(next, 'Basketball')).toBe('scores by shot distance.');
    expect(linkSpanText(next, 'Baseball')).toBe('paces itself over 9 innings.');
  });

  /*
   * The silent failure this module was written to end: the old inline writer
   * built /\[\[\s*Label\s*\]\]/, which cannot match a piped link, so it returned
   * the markdown unchanged and GraphPane discarded the edit without a word.
   */
  test('a description on an aliased link actually saves', () => {
    const cell = '[[Root]] head\n\n[[Volleyball|the net game]] keeps its rotations constant.';
    const next = setLinkSpanText(cell, 'Volleyball', 'is played over a net.');
    expect(next).not.toBe(cell);
    expect(next).toContain('[[Volleyball|the net game]]');
    expect(linkSpanText(next, 'Volleyball')).toBe('is played over a net.');
  });

  test('the separator the author wrote survives a rewrite', () => {
    const cell = '[[Root]] head\n\n- **[[Bold]]** matters here';
    const next = setLinkSpanText(cell, 'Bold', 'matters more');
    expect(next).toContain('- **[[Bold]]** matters more');
  });

  test('a link alone on its line keeps its prose in a block beneath it', () => {
    const next = setLinkSpanText(SECTIONS, 'Direct Versus Embedded Material Demand', 'Two channels.');
    expect(next).toContain('## [[Direct Versus Embedded Material Demand]]\n\nTwo channels.');
    expect(linkSpanText(next, 'Next Concept')).toBe('Something else entirely.');
  });

  test('an empty description leaves the link on the map with nothing said', () => {
    const next = setLinkSpanText(CONVERSATION, 'Response', '');
    expect(linkSpanText(next, 'Response')).toBe('');
    expect(linkSpanText(next, 'Greeting')).toBe('hi how are you');
    expect(linkSpanText(next, 'Final Response')).toBe('Kinda tired, ready for bed.');
  });

  test('a label the cell does not link comes back unchanged, for the caller to report', () => {
    expect(setLinkSpanText('[[Alpha]] prose', 'Beta', 'anything')).toBe('[[Alpha]] prose');
  });

  test('giving a bare link a description writes it inline', () => {
    const next = setLinkSpanText('[[Alpha]] head. [[Beta]] [[Gamma]] tail.', 'Beta', 'the middle');
    expect(linkSpanText(next, 'Beta')).toBe('the middle');
    expect(linkSpanText(next, 'Gamma')).toBe('tail.');
  });
});
