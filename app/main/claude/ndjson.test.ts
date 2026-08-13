import { describe, expect, it } from 'vitest';
import { NdjsonParser } from './ndjson';

const values = (lines: { ok: boolean; value?: unknown }[]): unknown[] =>
  lines.filter((line) => line.ok).map((line) => line.value);

describe('NdjsonParser', () => {
  it('parses complete lines in one chunk', () => {
    const parser = new NdjsonParser();

    const lines = parser.push('{"a":1}\n{"a":2}\n');

    expect(values(lines)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('holds a partial line until its newline arrives', () => {
    const parser = new NdjsonParser();

    expect(parser.push('{"type":"stream_ev')).toEqual([]);
    expect(values(parser.push('ent","n":1}\n'))).toEqual([{ type: 'stream_event', n: 1 }]);
  });

  it('handles an object split across three chunks', () => {
    const parser = new NdjsonParser();
    const line = JSON.stringify({ text: 'the quick brown fox jumps over the lazy dog' });

    parser.push(line.slice(0, 10));
    parser.push(line.slice(10, 30));
    const lines = parser.push(`${line.slice(30)}\n`);

    expect(values(lines)).toEqual([{ text: 'the quick brown fox jumps over the lazy dog' }]);
  });

  it('emits the leading complete line and keeps the trailing partial', () => {
    const parser = new NdjsonParser();

    const first = parser.push('{"a":1}\n{"b":');
    expect(values(first)).toEqual([{ a: 1 }]);

    expect(values(parser.push('2}\n'))).toEqual([{ b: 2 }]);
  });

  it('reassembles a multi-byte character split across a chunk boundary', () => {
    const parser = new NdjsonParser();
    const payload = Buffer.from('{"t":"café ✦"}\n', 'utf8');
    const cut = payload.indexOf(0xc3) + 1; // mid "é"

    parser.push(payload.subarray(0, cut));
    const lines = parser.push(payload.subarray(cut));

    expect(values(lines)).toEqual([{ t: 'café ✦' }]);
  });

  it('skips blank lines', () => {
    const parser = new NdjsonParser();

    expect(values(parser.push('\n\n{"a":1}\n\n'))).toEqual([{ a: 1 }]);
  });

  it('reports an unparseable line without throwing', () => {
    const parser = new NdjsonParser();

    const lines = parser.push('not json at all\n{"a":1}\n');

    expect(lines[0]?.ok).toBe(false);
    expect(lines[0]?.raw).toBe('not json at all');
    expect(values(lines)).toEqual([{ a: 1 }]);
  });

  it('flush returns a final line that never got its newline', () => {
    const parser = new NdjsonParser();

    parser.push('{"a":1}');

    expect(values(parser.flush())).toEqual([{ a: 1 }]);
  });

  it('flush on an empty buffer returns nothing', () => {
    const parser = new NdjsonParser();

    parser.push('{"a":1}\n');

    expect(parser.flush()).toEqual([]);
  });
});
