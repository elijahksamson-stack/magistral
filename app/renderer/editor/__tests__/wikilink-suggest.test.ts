import { describe, expect, it } from 'vitest';
import {
  buildWikilinkInsertion,
  findWikilinkQuery,
  buildSuggestions,
  rankLabelSuggestions,
} from '../wikilink-suggest';

describe('findWikilinkQuery', () => {
  it('detects an open link and reports where the label starts', () => {
    expect(findWikilinkQuery('the [[bind')).toEqual({ from: 6, query: 'bind' });
  });

  it('detects an open link with no typed label yet', () => {
    expect(findWikilinkQuery('the [[')).toEqual({ from: 6, query: '' });
  });

  it('returns null when the link is already closed', () => {
    expect(findWikilinkQuery('the [[Moat]] and more')).toBeNull();
  });

  it('returns null when a newline separates the brackets from the caret', () => {
    expect(findWikilinkQuery('[[Moat\nnext line')).toBeNull();
  });

  it('returns null when there is no open bracket pair', () => {
    expect(findWikilinkQuery('plain prose')).toBeNull();
  });

  it('uses the nearest open bracket pair', () => {
    expect(findWikilinkQuery('[[One]] then [[Tw')).toEqual({ from: 15, query: 'Tw' });
  });
});

describe('rankLabelSuggestions', () => {
  const candidates = [
    { label: 'Binding Constraint', linkCount: 5 },
    { label: 'Capital Cycle', linkCount: 3 },
    { label: 'Reflexivity', linkCount: 1 },
    { label: 'Constraint Theory', linkCount: 0 },
  ];
  const labelsOf = (query: string, limit?: number) =>
    rankLabelSuggestions(query, candidates, limit).map((c) => c.label);

  it('ranks prefix matches above substring matches', () => {
    expect(labelsOf('constraint')).toEqual(['Constraint Theory', 'Binding Constraint']);
  });

  it('is case and punctuation insensitive, matching the dedup key', () => {
    expect(labelsOf('CAPITAL!')).toEqual(['Capital Cycle']);
  });

  it('returns the caller ordering for an empty query', () => {
    expect(labelsOf('', 2)).toEqual(['Binding Constraint', 'Capital Cycle']);
  });

  it('drops labels that do not match at all', () => {
    expect(labelsOf('zzz')).toEqual([]);
  });

  it('dedups labels that share a normalized form', () => {
    const dupes = [
      { label: 'Moat', linkCount: 2 },
      { label: 'moat!', linkCount: 1 },
      { label: 'MOAT', linkCount: 0 },
    ];
    expect(rankLabelSuggestions('moat', dupes).map((c) => c.label)).toEqual(['Moat']);
  });

  it('honours the limit', () => {
    expect(labelsOf('c', 1)).toHaveLength(1);
  });

  it('matches an abbreviation as a subsequence', () => {
    // "bc" -> "Binding Constraint". An author who remembers the shape of a
    // concept but not its exact wording still finds the existing node.
    expect(labelsOf('bc')).toContain('Binding Constraint');
  });

  it('recovers from a typo, which is how near-duplicates get created', () => {
    // The reported bug: typing "Accsdounting" minted a second node rather than
    // surfacing "Accounting".
    const accounting = [{ label: 'Accounting', linkCount: 7 }];
    expect(rankLabelSuggestions('Accsdounting', accounting).map((c) => c.label)).toEqual([
      'Accounting',
    ]);
  });

  it('stays strict on short queries, where typo tolerance would be noise', () => {
    const animals = [{ label: 'Car', linkCount: 1 }];
    expect(rankLabelSuggestions('cat', animals)).toEqual([]);
  });

  it('prefers the more-linked concept within a tier', () => {
    const tied = [
      { label: 'Alpha One', linkCount: 1 },
      { label: 'Alpha Two', linkCount: 9 },
    ];
    expect(rankLabelSuggestions('alpha', tied).map((c) => c.label)).toEqual([
      'Alpha Two',
      'Alpha One',
    ]);
  });
});

describe('buildSuggestions', () => {
  const candidates = [
    { label: 'Accounting', linkCount: 7 },
    { label: 'Accrual Basis', linkCount: 2 },
  ];

  it('offers to create a concept the graph does not have', () => {
    const out = buildSuggestions('Amortization', candidates);
    const created = out.find((s) => s.isNew);
    expect(created).toEqual({ label: 'Amortization', linkCount: 0, isNew: true });
  });

  it('does not offer to create one that already exists', () => {
    expect(buildSuggestions('accounting!', candidates).some((s) => s.isNew)).toBe(false);
  });

  it('offers nothing extra for an empty query', () => {
    expect(buildSuggestions('  ', candidates).every((s) => !s.isNew)).toBe(true);
  });

  it('lists existing matches before the create entry', () => {
    const out = buildSuggestions('Acc', candidates);
    expect(out[0]?.isNew).toBe(false);
    expect(out[out.length - 1]?.isNew).toBe(true);
  });
});

describe('buildWikilinkInsertion', () => {
  it('closes the brackets when they are missing', () => {
    expect(buildWikilinkInsertion('Moat', ' rest')).toEqual({
      insert: 'Moat]]',
      cursorOffset: 6,
    });
  });

  it('does not double the brackets when they already follow the caret', () => {
    expect(buildWikilinkInsertion('Moat', ']]')).toEqual({
      insert: 'Moat',
      cursorOffset: 6,
    });
  });
});
