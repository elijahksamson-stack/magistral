/**
 * Safe rendering of model output.
 *
 * Rendered with react-dom/server rather than a DOM testing library — no DOM
 * environment is installed in this project — which is sufficient here because
 * the markup itself is the thing under test.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import Markdown, { buildLabelPattern, parseBlocks } from './markdown';

const CHAT_DIR = dirname(fileURLToPath(import.meta.url));

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe('escaping', () => {
  it('never emits raw HTML from model output', () => {
    const hostile = '<script>alert(1)</script> and <img src=x onerror="steal()">';
    const html = render(<Markdown text={hostile} />);

    // Every angle bracket the model wrote comes back escaped, so the browser
    // sees characters rather than a tag with an event handler on it.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;steal()&quot;&gt;');
  });

  it('escapes HTML inside code fences too', () => {
    const html = render(<Markdown text={'```\n<b>not bold</b>\n```'} />);
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
    expect(html).not.toContain('<b>not bold</b>');
  });

  it('escapes quotes and ampersands in a node label', () => {
    const html = render(<Markdown text='See [[Oil & "Gas"]] here.' />);
    expect(html).toContain('Oil &amp;');
    expect(html).not.toContain('Oil & "Gas"');
  });

  it('has no dangerouslySetInnerHTML anywhere in the chat pane', () => {
    for (const file of ['markdown.tsx', 'MessageList.tsx', 'Composer.tsx', 'ChatPane.tsx']) {
      const source = readFileSync(join(CHAT_DIR, file), 'utf8');
      expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
    }
  });
});

describe('block parsing', () => {
  it('splits paragraphs, lists, quotes, headings, rules and code', () => {
    const kinds = parseBlocks(
      [
        '## Heading',
        '',
        'A paragraph.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '> quoted',
        '',
        '---',
        '',
        '```',
        'code()',
        '```',
      ].join('\n'),
    ).map((block) => block.kind);

    expect(kinds).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'quote',
      'rule',
      'code',
    ]);
  });

  it('keeps an unterminated code fence as code instead of losing it', () => {
    const blocks = parseBlocks('```\nstill open');
    expect(blocks).toEqual([{ kind: 'code', lines: ['still open'] }]);
  });

  it('renders an ordered list as ol and an unordered list as ul', () => {
    expect(render(<Markdown text={'1. a\n2. b'} />)).toContain('<ol');
    expect(render(<Markdown text={'- a\n- b'} />)).toContain('<ul');
  });

  it('caps heading depth so a response cannot outrank the pane chrome', () => {
    const html = render(<Markdown text="###### deep" />);
    expect(html).toContain('<h4');
    expect(html).not.toContain('<h6');
  });
});

describe('inline formatting', () => {
  it('renders bold, italic and inline code', () => {
    const html = render(<Markdown text="**bold** and *italic* and `code`" />);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('>code</code>');
  });

  it('does not re-interpret the inside of a code span', () => {
    const html = render(<Markdown text="`**not bold**`" />);
    expect(html).not.toContain('<strong>');
    expect(html).toContain('**not bold**');
  });

  it('does not italicise arithmetic — emphasis needs a non-space inside it', () => {
    const html = render(<Markdown text="2 * 3 * 4 = 24" />);
    expect(html).not.toContain('<em>');
    expect(html).toContain('2 * 3 * 4 = 24');
  });

  it('leaves an underscored identifier intact', () => {
    const html = render(<Markdown text="the snake_case_name field" />);
    expect(html).not.toContain('<em>');
    expect(html).toContain('snake_case_name');
  });

  it('still renders underscore emphasis at a word boundary', () => {
    expect(render(<Markdown text="this is _emphasis_ here" />)).toContain('<em>emphasis</em>');
  });
});

describe('node labels', () => {
  it('turns a wikilink into a clickable node link', () => {
    const onSelectLabel = vi.fn();
    const html = render(
      <Markdown text="This depends on [[Binding constraint]]." onSelectLabel={onSelectLabel} />,
    );

    expect(html).toContain('data-node-label="Binding constraint"');
    expect(html).toContain('<button');
  });

  it('linkifies known graph labels found in plain prose', () => {
    const html = render(
      <Markdown
        text="HBM supply is the constraint here."
        labels={['HBM supply']}
        onSelectLabel={vi.fn()}
      />,
    );
    expect(html).toContain('data-node-label="HBM supply"');
  });

  it('prefers the longest matching label', () => {
    const labels = ['Binding constraint migration', 'Binding constraint'];
    const html = render(
      <Markdown
        text="Watch binding constraint migration closely."
        labels={labels}
        onSelectLabel={vi.fn()}
      />,
    );
    expect(html).toContain('data-node-label="binding constraint migration"');
  });

  it('does not match a label inside a longer word', () => {
    const html = render(
      <Markdown text="Reconstraint is not a word." labels={['constraint']} onSelectLabel={vi.fn()} />,
    );
    expect(html).not.toContain('data-node-label');
  });

  it('does not linkify inside code spans', () => {
    const html = render(
      <Markdown text="`HBM supply`" labels={['HBM supply']} onSelectLabel={vi.fn()} />,
    );
    expect(html).not.toContain('<button');
  });

  it('renders a plain span when there is nothing to select', () => {
    const html = render(<Markdown text="See [[Binding constraint]]." />);
    expect(html).not.toContain('<button');
    expect(html).toContain('Binding constraint');
  });

  it('treats a label containing regex metacharacters literally', () => {
    const pattern = buildLabelPattern(['C++ (the language)']);
    expect(pattern!.test('We use C++ (the language) here')).toBe(true);
  });

  it('builds no pattern when there are no usable labels', () => {
    expect(buildLabelPattern([])).toBeNull();
    expect(buildLabelPattern(['  '])).toBeNull();
  });
});
