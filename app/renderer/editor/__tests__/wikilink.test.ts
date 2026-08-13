import { describe, expect, it } from 'vitest';
import {
  collectLinkedLabels,
  findWikilinkAt,
  normalizeLabel,
  parseWikilinks,
} from '../wikilink';

describe('normalizeLabel', () => {
  it('lowercases and keeps single spaces', () => {
    expect(normalizeLabel('The Binding Constraint')).toBe('the binding constraint');
  });

  it('collapses internal whitespace and trims', () => {
    expect(normalizeLabel('  binding   constraint ')).toBe('binding constraint');
  });

  it('strips surrounding punctuation', () => {
    expect(normalizeLabel('Binding Constraint!')).toBe('binding constraint');
    expect(normalizeLabel('"Reflexivity"')).toBe('reflexivity');
  });

  it('collapses a newline inside a label to a single space', () => {
    expect(normalizeLabel('binding\nconstraint')).toBe('binding constraint');
  });

  // The cases below are lifted from core/tests/test_types.cpp. This function is
  // a byte-for-byte mirror of braindump::normalizeLabel; if these drift, the
  // renderer computes a different dedup key from the one the core stored and
  // links silently stop resolving to their nodes.
  it('keeps an all-punctuation label addressable rather than collapsing it to ""', () => {
    expect(normalizeLabel('  --- ')).toBe('---');
    expect(normalizeLabel('!!!')).toBe('!!!');
    expect(normalizeLabel('  ???  ')).toBe('???');
  });

  it('returns an empty string only for empty or whitespace-only input', () => {
    expect(normalizeLabel('')).toBe('');
    expect(normalizeLabel('\t\n  ')).toBe('');
  });

  it('folds case for ASCII only, passing other bytes through untouched', () => {
    expect(normalizeLabel('  ÜBER  ')).toBe('Über');
    expect(normalizeLabel('Café Noir')).toBe('café noir');
    expect(normalizeLabel('日本語')).toBe('日本語');
  });

  it('strips ASCII punctuation only, leaving non-ASCII punctuation in place', () => {
    expect(normalizeLabel('«Free Cash Flow»')).toBe('«free cash flow»');
    expect(normalizeLabel('  "Free Cash Flow", ')).toBe('free cash flow');
    expect(normalizeLabel('cost/income ratio')).toBe('cost/income ratio');
    expect(normalizeLabel('e-commerce')).toBe('e-commerce');
  });

  it('is idempotent', () => {
    const once = normalizeLabel('  The *Binding*  Constraint!  ');
    expect(normalizeLabel(once)).toBe(once);
  });
});

describe('parseWikilinks', () => {
  it('finds a plain link and reports its exact range', () => {
    const markdown = 'A [[Binding Constraint]] rules.';
    const refs = parseWikilinks(markdown);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.label).toBe('Binding Constraint');
    expect(refs[0]?.display).toBe('Binding Constraint');
    expect(refs[0]?.normalizedLabel).toBe('binding constraint');
    expect(markdown.slice(refs[0]?.from, refs[0]?.to)).toBe('[[Binding Constraint]]');
  });

  it('handles the pipe display form', () => {
    const refs = parseWikilinks('see [[Binding Constraint|the bottleneck]] here');

    expect(refs).toHaveLength(1);
    expect(refs[0]?.label).toBe('Binding Constraint');
    expect(refs[0]?.display).toBe('the bottleneck');
    expect(refs[0]?.normalizedLabel).toBe('binding constraint');
  });

  it('falls back to the label when the display half is empty', () => {
    const refs = parseWikilinks('[[Capital Cycle|]]');
    expect(refs[0]?.display).toBe('Capital Cycle');
  });

  it('finds several links on one line in document order', () => {
    const refs = parseWikilinks('[[One]] then [[Two]] then [[Three]]');
    expect(refs.map((ref) => ref.label)).toEqual(['One', 'Two', 'Three']);
    expect(refs[0]!.from).toBeLessThan(refs[1]!.from);
    expect(refs[1]!.from).toBeLessThan(refs[2]!.from);
  });

  it('ignores links inside a fenced code block', () => {
    const markdown = ['Real [[Alpha]]', '', '```', 'const x = "[[Fake]]";', '```', '', 'Real [[Beta]]'].join(
      '\n',
    );

    expect(parseWikilinks(markdown).map((ref) => ref.label)).toEqual(['Alpha', 'Beta']);
  });

  it('ignores links inside a tilde fence', () => {
    const markdown = ['~~~', '[[Fake]]', '~~~', '[[Real]]'].join('\n');
    expect(parseWikilinks(markdown).map((ref) => ref.label)).toEqual(['Real']);
  });

  it('does not let a backtick fence close a tilde fence', () => {
    const markdown = ['~~~', '```', '[[StillFake]]', '```', '~~~', '[[Real]]'].join('\n');
    expect(parseWikilinks(markdown).map((ref) => ref.label)).toEqual(['Real']);
  });

  it('treats an unterminated fence as running to the end of the cell', () => {
    const markdown = ['intro [[Alpha]]', '```js', '[[Fake]]', 'more code'].join('\n');
    expect(parseWikilinks(markdown).map((ref) => ref.label)).toEqual(['Alpha']);
  });

  it('respects fences indented up to three spaces', () => {
    const markdown = ['   ```', '[[Fake]]', '   ```', '[[Real]]'].join('\n');
    expect(parseWikilinks(markdown).map((ref) => ref.label)).toEqual(['Real']);
  });

  it('reports absolute offsets across lines', () => {
    const markdown = 'line one\nline [[Two]] here';
    const ref = parseWikilinks(markdown)[0];

    expect(ref).toBeDefined();
    expect(markdown.slice(ref!.from, ref!.to)).toBe('[[Two]]');
  });

  it('rejects empty and whitespace-only labels', () => {
    expect(parseWikilinks('[[]] [[   ]]')).toHaveLength(0);
  });

  it('keeps a punctuation-only label, because the core creates a node for it', () => {
    const refs = parseWikilinks('[[---]]');
    expect(refs.map((ref) => ref.label)).toEqual(['---']);
    expect(refs[0]?.normalizedLabel).toBe('---');
  });

  it('does not match across a newline', () => {
    expect(parseWikilinks('[[open\nclosed]]')).toHaveLength(0);
  });

  it('does not match nested brackets', () => {
    expect(parseWikilinks('[[a [[b]] c]]').map((ref) => ref.label)).toEqual(['b']);
  });
});

describe('collectLinkedLabels', () => {
  it('dedups by normalized form and keeps first-seen casing', () => {
    const labels = collectLinkedLabels('[[Capital Cycle]] and [[capital cycle!]] and [[Moat]]');
    expect(labels).toEqual(['Capital Cycle', 'Moat']);
  });
});

describe('findWikilinkAt', () => {
  it('returns the link containing the offset', () => {
    const markdown = 'A [[Moat]] here';
    expect(findWikilinkAt(markdown, 5)?.label).toBe('Moat');
  });

  it('returns null outside every link', () => {
    expect(findWikilinkAt('A [[Moat]] here', 0)).toBeNull();
  });
});
