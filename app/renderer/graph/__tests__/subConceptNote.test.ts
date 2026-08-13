import { describe, expect, test } from 'vitest';
import { setSubConceptNote } from '../subConceptNote';

describe('setSubConceptNote', () => {
  test('rewrites the trailing prose on the line that carries the link', () => {
    const markdown = '[[Energy Markets]]\n\n[[Battery Systems]] old text.';

    expect(setSubConceptNote(markdown, 'Battery Systems', 'Stores grid energy.')).toBe(
      '[[Energy Markets]]\n\n[[Battery Systems]] Stores grid energy.',
    );
  });

  test('adds prose to a link that had none', () => {
    const markdown = '[[Energy Markets]]\n\n[[Battery Systems]]';

    expect(setSubConceptNote(markdown, 'Battery Systems', 'Stores grid energy.')).toBe(
      '[[Energy Markets]]\n\n[[Battery Systems]] Stores grid energy.',
    );
  });

  test('clearing the description leaves the bare link', () => {
    const markdown = '[[Energy Markets]]\n\n[[Battery Systems]] old text.';

    expect(setSubConceptNote(markdown, 'Battery Systems', '')).toBe(
      '[[Energy Markets]]\n\n[[Battery Systems]]',
    );
  });

  test('keeps a list marker and its indentation', () => {
    const markdown = '[[Energy Markets]]\n\n- [[Battery Systems]] old text.';

    expect(setSubConceptNote(markdown, 'Battery Systems', 'New text.')).toBe(
      '[[Energy Markets]]\n\n- [[Battery Systems]] New text.',
    );
  });

  test('matches the label regardless of case', () => {
    const markdown = '[[Energy Markets]]\n\n[[battery systems]] old.';

    expect(setSubConceptNote(markdown, 'Battery Systems', 'New.')).toBe(
      '[[Energy Markets]]\n\n[[battery systems]] New.',
    );
  });

  /*
   * The parser attributes a line to whichever link opens it, so a subnode
   * sharing a line cannot carry its own description there — rewriting that line
   * would silently rewrite the PARENT's description too. It gets its own line,
   * and the shared line keeps reading as prose with the link flattened out.
   * The core's flattenLine makes the note the WHOLE line, so the description
   * shown for a mid-paragraph link IS that entire paragraph. Editing it has to
   * rewrite the paragraph, or the author edits a paragraph and gets back a
   * fragment plus a stray line.
   */
  test('rewrites the whole paragraph a mid-line link belongs to', () => {
    const markdown = 'Gas is quick to permit, unlike [[Commodity Markets]] exposure.';

    expect(
      setSubConceptNote(
        markdown,
        'Commodity Markets',
        'Onsite generation shifts which market you face.',
      ),
    ).toBe('[[Commodity Markets]] Onsite generation shifts which market you face.');
  });

  test('keeps the other links the paragraph carried where the new text still names them', () => {
    const markdown = '[[AI Capex]] drives [[Hardware Demand]] sharply.';
    const next = 'AI Capex funds the build, so Hardware Demand follows it upward.';

    expect(setSubConceptNote(markdown, 'Hardware Demand', next)).toBe(
      '[[AI Capex]] funds the build, so [[Hardware Demand]] follows it upward.',
    );
  });

  test('links the subject even when the new text never names it', () => {
    const markdown = '[[AI Capex]] drives [[Hardware Demand]] sharply.';

    expect(
      setSubConceptNote(markdown, 'Hardware Demand', 'GPU orders follow the capex cycle.'),
    ).toBe('[[Hardware Demand]] GPU orders follow the capex cycle.');
  });

  test('links a label once, however often the text returns to it', () => {
    const markdown = '[[Battery Systems]] old.';
    const next = 'Battery Systems store energy, and Battery Systems keep getting cheaper.';

    expect(setSubConceptNote(markdown, 'Battery Systems', next)).toBe(
      '[[Battery Systems]] store energy, and Battery Systems keep getting cheaper.',
    );
  });

  test('leaves the markdown alone when the label is not linked in it', () => {
    const markdown = '[[Energy Markets]] a note.';

    expect(setSubConceptNote(markdown, 'Absent Concept', 'anything')).toBe(markdown);
  });

  test('does not touch a later duplicate of the same link', () => {
    const markdown =
      '[[Energy Markets]]\n\n[[Battery Systems]] first.\n\n[[Battery Systems]] second.';

    expect(setSubConceptNote(markdown, 'Battery Systems', 'Updated.')).toBe(
      '[[Energy Markets]]\n\n[[Battery Systems]] Updated.\n\n[[Battery Systems]] second.',
    );
  });
});
