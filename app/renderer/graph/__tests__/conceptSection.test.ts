import { describe, expect, test } from 'vitest';
import { conceptSectionText, setConceptSectionText } from '../conceptSection';

const CELL = [
  '[[Material Demand]]',
  '',
  'An opening line about materials.',
  '',
  '[[Direct Versus Embedded Material Demand]]',
  '',
  'Data-center demand reaches materials through two channels.',
  '',
  '* Concrete',
  '* Structural steel',
  '',
  '[[Next Concept]]',
  '',
  'Something else entirely.',
].join('\n');

describe('conceptSectionText', () => {
  /*
   * The case that reported "No description yet" while carrying pages of prose:
   * the link is alone on its line, so the core's line-scoped note is empty.
   */
  test('reads everything under a heading link, up to the next heading', () => {
    expect(conceptSectionText(CELL, 'Direct Versus Embedded Material Demand')).toBe(
      'Data-center demand reaches materials through two channels.\n\n* Concrete\n* Structural steel',
    );
  });

  test('the last heading owns the rest of the cell', () => {
    expect(conceptSectionText(CELL, 'Next Concept')).toBe('Something else entirely.');
  });

  test('a heading with nothing under it yet is empty, not absent', () => {
    expect(conceptSectionText('[[Alpha]]\n\n[[Beta]]\n\nBeta prose.', 'Alpha')).toBe('');
  });

  /*
   * Null, not '': an inline link has no section of its own, and the caller must
   * fall back to the note the core derived from its line rather than report the
   * concept as having an empty description.
   */
  test('an inline link has no section', () => {
    expect(
      conceptSectionText('Gas exposes you to [[Commodity Markets]] either way.', 'Commodity Markets'),
    ).toBeNull();
  });

  test('matches the label however it was cased', () => {
    expect(conceptSectionText('[[alpha]]\n\nIts prose.', 'Alpha')).toBe('Its prose.');
  });

  /*
   * `## [[Concept]]` is how a heading is actually written. Not recognising the
   * hash marks cost twice: the concept reported no description while carrying a
   * whole section, AND the hunt for that section's end ran past the next
   * heading and swallowed it.
   */
  const HASHED = [
    '## [[Autonomous Systems and Edge Inference]]',
    '',
    'Vehicles, drones and robots infer outside the data centre.',
    '',
    '## [[Who Ultimately Pays?]]',
    '',
    'AI compute is funded through several economic models.',
  ].join('\n');

  test('recognises a heading written with markdown hash marks', () => {
    expect(conceptSectionText(HASHED, 'Autonomous Systems and Edge Inference')).toBe(
      'Vehicles, drones and robots infer outside the data centre.',
    );
  });

  test('stops at the next hashed heading instead of swallowing it', () => {
    const text = conceptSectionText(HASHED, 'Autonomous Systems and Edge Inference') ?? '';

    expect(text).not.toContain('Who Ultimately Pays?');
    expect(text).not.toContain('funded through several economic models');
  });

  test.each(['#', '###', '######'])('accepts an %s heading level', (marks) => {
    expect(conceptSectionText(`${marks} [[Alpha]]\n\nIts prose.`, 'Alpha')).toBe('Its prose.');
  });

  test('a hashed heading keeps its marks when its prose is replaced', () => {
    const next = setConceptSectionText(HASHED, 'Autonomous Systems and Edge Inference', 'hello');

    expect(next).toContain('## [[Autonomous Systems and Edge Inference]]');
    expect(next).toContain('## [[Who Ultimately Pays?]]');
    expect(conceptSectionText(next, 'Autonomous Systems and Edge Inference')).toBe('hello');
    expect(conceptSectionText(next, 'Who Ultimately Pays?')).toBe(
      'AI compute is funded through several economic models.',
    );
  });
});

describe('setConceptSectionText', () => {
  test('replaces the prose and keeps the heading and its neighbours', () => {
    const next = setConceptSectionText(CELL, 'Direct Versus Embedded Material Demand', 'hello');

    expect(next).toBe(
      [
        '[[Material Demand]]',
        '',
        'An opening line about materials.',
        '',
        '[[Direct Versus Embedded Material Demand]]',
        '',
        'hello',
        '',
        '[[Next Concept]]',
        '',
        'Something else entirely.',
      ].join('\n'),
    );
  });

  test('writes into a heading that had nothing under it', () => {
    expect(setConceptSectionText('[[Alpha]]\n\n[[Beta]]\n\nBeta prose.', 'Alpha', 'hello')).toBe(
      '[[Alpha]]\n\nhello\n\n[[Beta]]\n\nBeta prose.',
    );
  });

  test('keeps multi-paragraph prose intact', () => {
    const body = 'First paragraph.\n\n* one\n* two';
    const next = setConceptSectionText(CELL, 'Next Concept', body);

    expect(conceptSectionText(next, 'Next Concept')).toBe(body);
  });

  test('clearing the description leaves the heading standing', () => {
    const next = setConceptSectionText(CELL, 'Next Concept', '');

    expect(next).toContain('[[Next Concept]]');
    expect(conceptSectionText(next, 'Next Concept')).toBe('');
  });

  test('leaves the markdown alone when the concept is not a heading in it', () => {
    const inline = 'Gas exposes you to [[Commodity Markets]] either way.';

    expect(setConceptSectionText(inline, 'Commodity Markets', 'hello')).toBe(inline);
  });

  test('round-trips: what is written is what is read back', () => {
    const written = setConceptSectionText(CELL, 'Direct Versus Embedded Material Demand', 'hello');

    expect(conceptSectionText(written, 'Direct Versus Embedded Material Demand')).toBe('hello');
  });
});
