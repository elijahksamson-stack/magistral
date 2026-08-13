/**
 * Incremental NDJSON reader for the CLI's `--output-format stream-json` output.
 *
 * The bug this file exists to prevent: a stdout 'data' chunk is a slice of a
 * byte stream, not a line. One JSON object routinely arrives split across two
 * chunks, and a naive `chunk.split('\n').map(JSON.parse)` throws on the tail of
 * every long message. So the tail is held in a buffer until its newline shows
 * up, and only complete lines are parsed.
 *
 * A multi-byte UTF-8 character can also straddle a chunk boundary, so decoding
 * uses a stateful StringDecoder rather than `buffer.toString()`.
 */

import { StringDecoder } from 'node:string_decoder';

export interface NdjsonLine {
  readonly ok: boolean;
  /** Parsed object when ok. */
  readonly value?: unknown;
  /** The raw line and the parse error when not ok. */
  readonly raw?: string;
  readonly error?: string;
}

/** Guard against an unterminated line growing without bound. */
export const MAX_BUFFERED_LINE_BYTES = 8 * 1024 * 1024;

export class NdjsonParser {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  /** Feed a stdout chunk. Returns every line that completed in this chunk. */
  push(chunk: Buffer | string): NdjsonLine[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (text.length === 0) return [];

    this.buffer += text;
    if (this.buffer.length > MAX_BUFFERED_LINE_BYTES) {
      const dropped = this.buffer;
      this.buffer = '';
      return [
        {
          ok: false,
          raw: `${dropped.slice(0, 200)}…`,
          error: `A single stream-json line exceeded ${MAX_BUFFERED_LINE_BYTES} bytes and was dropped`,
        },
      ];
    }

    const segments = this.buffer.split('\n');
    // The final segment has no newline yet — it is the partial line. Hold it.
    this.buffer = segments.pop() ?? '';

    return segments.map(parseLine).filter(isPresent);
  }

  /** Flush whatever is left when the stream ends (a last line without \n). */
  flush(): NdjsonLine[] {
    const remaining = this.buffer + this.decoder.end();
    this.buffer = '';
    const parsed = parseLine(remaining);
    return parsed ? [parsed] : [];
  }
}

function parseLine(line: string): NdjsonLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error: unknown) {
    return {
      ok: false,
      raw: trimmed.slice(0, 500),
      error: error instanceof Error ? error.message : 'JSON parse failed',
    };
  }
}

function isPresent(line: NdjsonLine | null): line is NdjsonLine {
  return line !== null;
}
