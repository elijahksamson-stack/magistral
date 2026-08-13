/**
 * Byte-exact line scanning for the bundled markdown corpus.
 *
 * Every offset produced here is a BYTE offset into the source Buffer, never a
 * JavaScript string index. The corpus is full of em dashes, curly quotes and
 * symbols, so a character offset would slice mid-codepoint and silently corrupt
 * whatever the bridge injects. The only safe way to get this right is to find
 * the line boundaries in the Buffer itself and decode afterwards.
 */

const NEWLINE_BYTE = 0x0a;
const FENCE_PATTERN = /^(?:```|~~~)/;
const FRONTMATTER_DELIMITER = '---';
const HEADING_PATTERN = /^(#{1,6})\s+(.*\S)\s*$/;
const NUMBERED_TITLE_PATTERN = /^(\d+)\.\s+(.*\S)\s*$/;
const SECTION_HEADING_LEVEL = 2;
const DOCUMENT_TITLE_LEVEL = 1;

/**
 * @typedef {object} SourceLine
 * @property {number} byteStart Offset of the first byte of the line.
 * @property {number} byteEnd   Offset one past the line's trailing newline.
 * @property {string} text      Decoded line, without its line terminator.
 * @property {boolean} isFenced True when the line sits inside a code fence.
 */

/**
 * @typedef {object} SectionHeading
 * @property {number} number Ordinal from the `## N.` prefix.
 * @property {string} title  Heading text with the ordinal stripped.
 */

/**
 * Split a Buffer into lines, recording exact byte offsets for each one.
 *
 * @param {Buffer} buffer
 * @returns {SourceLine[]}
 */
export function scanLines(buffer) {
  const lines = [];
  let lineStart = 0;
  let isInsideFence = false;

  for (let index = 0; index <= buffer.length; index += 1) {
    const isEndOfBuffer = index === buffer.length;
    if (!isEndOfBuffer && buffer[index] !== NEWLINE_BYTE) continue;
    if (isEndOfBuffer && lineStart >= buffer.length) break;

    const byteEnd = isEndOfBuffer ? buffer.length : index + 1;
    const text = decodeLine(buffer, lineStart, isEndOfBuffer ? buffer.length : index);
    const isFencePost = FENCE_PATTERN.test(text.trimStart());

    lines.push({
      byteStart: lineStart,
      byteEnd,
      text,
      isFenced: isInsideFence || isFencePost,
    });

    if (isFencePost) isInsideFence = !isInsideFence;
    lineStart = byteEnd;
  }

  return lines;
}

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function decodeLine(buffer, start, end) {
  const raw = buffer.toString('utf8', start, end);
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

/**
 * Index of the first line after a leading `---` YAML frontmatter block.
 * Returns 0 when the document has no frontmatter.
 *
 * @param {readonly SourceLine[]} lines
 * @returns {number}
 */
export function findContentStartIndex(lines) {
  const first = lines[0];
  if (!first || first.text.trim() !== FRONTMATTER_DELIMITER) return 0;

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].text.trim() === FRONTMATTER_DELIMITER) return index + 1;
  }

  // Unterminated frontmatter: treat the whole file as content rather than
  // silently dropping it.
  return 0;
}

/**
 * @param {string} text
 * @returns {{ level: number, title: string } | null}
 */
export function parseHeading(text) {
  const match = HEADING_PATTERN.exec(text);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

/**
 * Parse a `## N. Section Title` heading. Every sector module in the corpus uses
 * exactly this shape, and it is the unit the bridge injects.
 *
 * @param {string} text
 * @returns {SectionHeading | null}
 */
export function parseSectionHeading(text) {
  const heading = parseHeading(text);
  if (!heading || heading.level !== SECTION_HEADING_LEVEL) return null;

  const numbered = NUMBERED_TITLE_PATTERN.exec(heading.title);
  if (!numbered) return null;

  return { number: Number(numbered[1]), title: numbered[2].trim() };
}

/**
 * First level-1 heading outside frontmatter and code fences.
 *
 * @param {readonly SourceLine[]} lines
 * @returns {string | null}
 */
export function findDocumentTitle(lines) {
  for (let index = findContentStartIndex(lines); index < lines.length; index += 1) {
    const line = lines[index];
    if (line.isFenced) continue;
    const heading = parseHeading(line.text);
    if (heading && heading.level === DOCUMENT_TITLE_LEVEL) return heading.title;
  }
  return null;
}

/**
 * Every `## N.` section heading in the document, in source order.
 *
 * @param {readonly SourceLine[]} lines
 * @returns {Array<{ line: SourceLine, heading: SectionHeading }>}
 */
export function findSectionHeadings(lines) {
  const found = [];
  for (let index = findContentStartIndex(lines); index < lines.length; index += 1) {
    const line = lines[index];
    if (line.isFenced) continue;
    const heading = parseSectionHeading(line.text);
    if (heading) found.push({ line, heading });
  }
  return found;
}

/**
 * Lowercase, ASCII-only slug suitable for a stable PackSection id.
 *
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
