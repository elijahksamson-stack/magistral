/**
 * Byte-offset correctness.
 *
 * The corpus is dense with em dashes, curly quotes, arrows and the occasional
 * emoji. A character offset and a byte offset diverge the moment one of those
 * appears, and the failure is silent — you get a slice that begins mid-word or
 * mid-codepoint and a model that quietly reasons over garbage. These tests pin
 * the distinction down on fixtures where the two numbers are provably different.
 */

import { describe, expect, it } from 'vitest';

import {
  findContentStartIndex,
  findDocumentTitle,
  findSectionHeadings,
  parseSectionHeading,
  scanLines,
  slugify,
} from './lib/markdown-lines.mjs';

/** @param {string} source */
const buf = (source) => Buffer.from(source, 'utf8');

describe('scanLines', () => {
  it('records byte offsets, not character offsets, after multi-byte text', () => {
    const preamble = '# Café — naïve “quotes” ⛔\n';
    const source = `${preamble}## 1. First\nbody\n`;
    const lines = scanLines(buf(source));

    const heading = lines[1];
    expect(heading.text).toBe('## 1. First');

    // The whole point: these two numbers are different, and only one is right.
    expect(heading.byteStart).toBe(Buffer.byteLength(preamble, 'utf8'));
    expect(heading.byteStart).not.toBe(preamble.length);
  });

  it('produces ranges that slice back to the original line', () => {
    const source = '## 1. Ünïcøde — §\ntail ⛔ line\n';
    const buffer = buf(source);

    for (const line of scanLines(buffer)) {
      const slice = buffer.subarray(line.byteStart, line.byteEnd);
      expect(slice.toString('utf8').replace(/\n$/, '')).toBe(line.text);
      // A clean slice re-encodes to exactly its own length.
      expect(Buffer.byteLength(slice.toString('utf8'), 'utf8')).toBe(slice.length);
    }
  });

  it('tiles the buffer with no gaps and no overlap', () => {
    const buffer = buf('one\ntwo\nthree');
    const lines = scanLines(buffer);

    expect(lines[0].byteStart).toBe(0);
    expect(lines.at(-1).byteEnd).toBe(buffer.length);
    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i].byteStart).toBe(lines[i - 1].byteEnd);
    }
  });

  it('handles a file with no trailing newline', () => {
    const buffer = buf('## 1. Last');
    const lines = scanLines(buffer);
    expect(lines).toHaveLength(1);
    expect(lines[0].byteEnd).toBe(buffer.length);
  });

  it('strips a CRLF carriage return from the decoded text but not the range', () => {
    const buffer = buf('## 1. Windows\r\nbody\r\n');
    const lines = scanLines(buffer);
    expect(lines[0].text).toBe('## 1. Windows');
    expect(lines[1].byteStart).toBe(buffer.indexOf('body'));
  });

  it('marks fenced lines so a "## " inside a code block is not a heading', () => {
    const buffer = buf('```md\n## 1. Not A Section\n```\n## 2. Real Section\n');
    const headings = findSectionHeadings(scanLines(buffer));
    expect(headings.map((entry) => entry.heading.title)).toEqual(['Real Section']);
  });
});

describe('parseSectionHeading', () => {
  it('accepts the corpus section shape', () => {
    expect(parseSectionHeading('## 12. Industry Balance and Marginal Economics')).toEqual({
      number: 12,
      title: 'Industry Balance and Marginal Economics',
    });
  });

  it.each([
    ['## Table of contents', 'unnumbered level-2'],
    ['### 1. Subsection', 'level-3'],
    ['# 1. Document title', 'level-1'],
    ['1. A list item', 'not a heading'],
    ['##No space', 'no space after hashes'],
  ])('rejects %s (%s)', (line) => {
    expect(parseSectionHeading(line)).toBeNull();
  });
});

describe('frontmatter and titles', () => {
  it('skips YAML frontmatter when looking for the document title', () => {
    const buffer = buf(
      '---\nname: macroman\n# category-note: not the title\n---\n\n# /macroman — the real title\n',
    );
    const lines = scanLines(buffer);
    expect(findContentStartIndex(lines)).toBe(4);
    expect(findDocumentTitle(lines)).toBe('/macroman — the real title');
  });

  it('treats unterminated frontmatter as content rather than dropping the file', () => {
    const lines = scanLines(buf('---\nname: broken\n# Title\n'));
    expect(findContentStartIndex(lines)).toBe(0);
  });

  it('returns null when there is no level-1 heading', () => {
    expect(findDocumentTitle(scanLines(buf('## 1. Only a section\n')))).toBeNull();
  });
});

describe('slugify', () => {
  it.each([
    ['Food & Beverages', 'food-beverages'],
    ['Real Estate Management & Development', 'real-estate-management-development'],
    ['Communications Services', 'communications-services'],
    ['Value, Risk, and Portfolios', 'value-risk-and-portfolios'],
    ['Café Naïve', 'cafe-naive'],
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});
