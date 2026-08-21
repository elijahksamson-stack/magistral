import { describe, expect, test } from 'vitest';
import { embedMarkdown, embeddedImages } from '../embeds';

describe('embeddedImages', () => {
  test('finds an embedded image', () => {
    expect(embeddedImages('[[Turbine]] rises.\n\n![[curve.png]]\n')).toEqual(['curve.png']);
  });

  test('ignores a concept link, which is not a file', () => {
    expect(embeddedImages('[[Turbine]] rises with [[Inlet Temperature]].')).toEqual([]);
  });

  test('finds several, in the order written', () => {
    expect(embeddedImages('![[a.png]] then ![[b.jpg]] and ![[c.webp]]')).toEqual([
      'a.png',
      'b.jpg',
      'c.webp',
    ]);
  });

  test('shows a repeated figure once', () => {
    expect(embeddedImages('![[a.png]] and again ![[a.png]]')).toEqual(['a.png']);
  });

  test('ignores an embed that is not a picture', () => {
    expect(embeddedImages('![[report.pdf]] ![[notes.txt]]')).toEqual([]);
  });

  test('tolerates padding inside the brackets', () => {
    expect(embeddedImages('![[  curve.png  ]]')).toEqual(['curve.png']);
  });

  test('is case-insensitive about the extension', () => {
    expect(embeddedImages('![[Diagram.PNG]]')).toEqual(['Diagram.PNG']);
  });

  test('finds nothing in a cell with no embeds', () => {
    expect(embeddedImages('Plain prose about turbines.')).toEqual([]);
  });
});

describe('embedMarkdown', () => {
  test('writes the embed form, not the link form', () => {
    // The leading `!` is the whole difference: without it the parser reads the
    // filename as a concept and puts it on the canvas.
    expect(embedMarkdown('curve.png')).toBe('![[curve.png]]');
  });

  test('round-trips through the finder', () => {
    expect(embeddedImages(embedMarkdown('curve.png'))).toEqual(['curve.png']);
  });
});
