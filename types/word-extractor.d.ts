/**
 * word-extractor ships no types. Only the slice this app uses is declared —
 * a fuller stub would claim knowledge of an API we never call.
 */
declare module 'word-extractor' {
  interface ExtractedDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getFooters(): string;
  }

  class WordExtractor {
    extract(source: string | Buffer): Promise<ExtractedDocument>;
  }

  export default WordExtractor;
}
