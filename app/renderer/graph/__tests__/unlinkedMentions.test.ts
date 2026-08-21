import { describe, expect, test } from 'vitest';
import { findUnlinkedMentions, linkMentionAt } from '../unlinkedMentions';

const cell = (id: string, markdown: string) => ({ id, markdown });

describe('findUnlinkedMentions', () => {
  test('finds a concept named in prose but never bracketed', () => {
    const cells = [cell('c1', '[[Grid]] pricing turns on the heat rate of the marginal plant.')];

    const mentions = findUnlinkedMentions(cells, 'heat rate');

    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.cellId).toBe('c1');
    expect(mentions[0]?.text).toBe('heat rate');
  });

  test('ignores a mention that is already a link', () => {
    const cells = [cell('c1', '[[Grid]] turns on the [[Heat Rate]] of the plant.')];

    expect(findUnlinkedMentions(cells, 'Heat Rate')).toHaveLength(0);
  });

  test('finds the plain one even when a linked one is in the same cell', () => {
    const cells = [cell('c1', '[[Heat Rate]] matters. A poor heat rate raises cost.')];

    const mentions = findUnlinkedMentions(cells, 'Heat Rate');

    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.text).toBe('heat rate');
  });

  test('matches however the author cased it', () => {
    const cells = [cell('c1', 'The Heat Rate and the heat rate are one concept.')];

    expect(findUnlinkedMentions(cells, 'heat rate')).toHaveLength(2);
  });

  /*
   * Without a boundary check, "AI" matches "said", "chain" and "maintain", and
   * the panel becomes a list the author scrolls past instead of reading.
   */
  test('matches whole words only', () => {
    const cells = [cell('c1', 'He said the chain would maintain itself.')];

    expect(findUnlinkedMentions(cells, 'AI')).toHaveLength(0);
  });

  test('matches a label that ends in punctuation', () => {
    const cells = [cell('c1', 'The question Who Ultimately Pays? is unresolved.')];

    expect(findUnlinkedMentions(cells, 'Who Ultimately Pays?')).toHaveLength(1);
  });

  test('ignores a match inside fenced code', () => {
    const cells = [cell('c1', 'Prose.\n\n```\nconst heat rate = 1;\n```\n')];

    expect(findUnlinkedMentions(cells, 'heat rate')).toHaveLength(0);
  });

  test('searches every cell, reporting which one each mention is in', () => {
    const cells = [cell('c1', 'A heat rate note.'), cell('c2', 'Another heat rate note.')];

    expect(findUnlinkedMentions(cells, 'heat rate').map((mention) => mention.cellId)).toEqual([
      'c1',
      'c2',
    ]);
  });

  test('carries an excerpt so a stray hit is recognisable', () => {
    const cells = [cell('c1', 'Gas plants are ranked by heat rate before dispatch.')];

    expect(findUnlinkedMentions(cells, 'heat rate')[0]?.excerpt).toContain('ranked by heat rate');
  });

  test('an empty label finds nothing rather than everything', () => {
    expect(findUnlinkedMentions([cell('c1', 'anything')], '   ')).toHaveLength(0);
  });
});

describe('linkMentionAt', () => {
  test('brackets the mention the author pointed at, not the first one', () => {
    const markdown = 'A heat rate note. Another heat rate note.';
    const second = markdown.lastIndexOf('heat rate');

    expect(linkMentionAt(markdown, second, 'heat rate'.length)).toBe(
      'A heat rate note. Another [[heat rate]] note.',
    );
  });

  test('keeps the casing the author wrote', () => {
    const markdown = 'The heat rate matters.';

    expect(linkMentionAt(markdown, markdown.indexOf('heat rate'), 9)).toContain('[[heat rate]]');
  });

  test('leaves the cell alone for an offset outside it', () => {
    expect(linkMentionAt('short', 99, 4)).toBe('short');
    expect(linkMentionAt('short', 0, 0)).toBe('short');
  });

  test('the linked result is no longer an unlinked mention', () => {
    const markdown = 'Gas plants are ranked by heat rate.';
    const [mention] = findUnlinkedMentions([cell('c1', markdown)], 'heat rate');
    const next = linkMentionAt(markdown, mention?.index ?? 0, mention?.text.length ?? 0);

    expect(findUnlinkedMentions([cell('c1', next)], 'heat rate')).toHaveLength(0);
  });
});
