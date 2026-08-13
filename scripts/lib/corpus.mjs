/**
 * Walks resources/knowledge/ and turns it into PackSection records.
 *
 * Mirrors `PackSection` / `KnowledgeIndex` in shared/types/claude.ts. That file
 * is a contract owned elsewhere; this module must follow it, never lead it.
 *
 * Sector modules run 30-69 KB, so they are split at `## N. Section Title` and
 * indexed one section at a time. Mindset and macroman files are a few KB and are
 * indexed whole.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

import { mineKeywords } from './keywords.mjs';
import {
  findDocumentTitle,
  findSectionHeadings,
  scanLines,
  slugify,
} from './markdown-lines.mjs';

/** Rough tokens-per-byte for budgeting. Deliberately crude; see PACK_TOKEN_BUDGET. */
export const BYTES_PER_TOKEN = 4;

export const MINDSET_DIR = 'mindset';
export const MACROMAN_DIR = 'macroman';
export const SECTORS_DIR = 'sectors';
/** System prompts live beside the corpus but are not corpus. */
export const SYSTEM_DIR = '_system';

const MARKDOWN_EXTENSION = '.md';
const FILENAME_ORDER_PREFIX = /^\d+[_-]/;

/**
 * @typedef {object} CorpusFile
 * @property {string}  relPath Forward-slashed, relative to resources/knowledge.
 * @property {'mindset' | 'sector' | 'macroman'} kind
 * @property {string} [sector]
 * @property {string}  module
 * @property {Buffer}  buffer
 */

/**
 * Recursively collect every corpus markdown file, skipping `_system`.
 *
 * @param {string} knowledgeDir Absolute path to resources/knowledge.
 * @returns {Promise<CorpusFile[]>}
 */
export async function readCorpus(knowledgeDir) {
  const relPaths = await collectMarkdownPaths(knowledgeDir, '');
  relPaths.sort((left, right) => left.localeCompare(right));

  const files = [];
  for (const relPath of relPaths) {
    const descriptor = describePath(relPath);
    if (!descriptor) continue;
    const buffer = await readFile(join(knowledgeDir, ...relPath.split(posix.sep)));
    files.push({ ...descriptor, relPath, buffer });
  }
  return files;
}

/**
 * @param {string} rootDir
 * @param {string} relDir
 * @returns {Promise<string[]>}
 */
async function collectMarkdownPaths(rootDir, relDir) {
  const absoluteDir = relDir ? join(rootDir, ...relDir.split(posix.sep)) : rootDir;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const found = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === SYSTEM_DIR) continue;
    const relPath = relDir ? `${relDir}${posix.sep}${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      found.push(...(await collectMarkdownPaths(rootDir, relPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)) {
      found.push(relPath);
    }
  }

  return found;
}

/**
 * Classify a corpus path by the directory it lives in.
 *
 * @param {string} relPath
 * @returns {{ kind: 'mindset' | 'sector' | 'macroman', sector?: string, module: string } | null}
 */
export function describePath(relPath) {
  const segments = relPath.split(posix.sep);
  const fileName = segments[segments.length - 1];
  const module = humanizeFileName(fileName);

  if (segments.length === 2 && segments[0] === MINDSET_DIR) {
    return { kind: 'mindset', module };
  }
  if (segments.length === 2 && segments[0] === MACROMAN_DIR) {
    return { kind: 'macroman', module };
  }
  if (segments.length === 3 && segments[0] === SECTORS_DIR) {
    return { kind: 'sector', sector: segments[1], module };
  }
  return null;
}

/**
 * `01_Seeing_Clearly.md` -> `Seeing Clearly`; `Oil & Gas.md` -> `Oil & Gas`.
 *
 * @param {string} fileName
 * @returns {string}
 */
export function humanizeFileName(fileName) {
  return fileName
    .slice(0, -MARKDOWN_EXTENSION.length)
    .replace(FILENAME_ORDER_PREFIX, '')
    .replace(/_/g, ' ')
    .trim();
}

/**
 * @param {number} byteLength
 * @returns {number}
 */
export function estimateTokens(byteLength) {
  return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

/**
 * @param {CorpusFile} file
 * @returns {import('./types.mjs').PackSectionLike[]}
 */
export function buildFileSections(file) {
  const lines = scanLines(file.buffer);
  if (file.kind === 'sector') return buildSectorSections(file, lines);
  return [buildWholeFileSection(file, lines)];
}

/**
 * @param {CorpusFile} file
 * @param {ReturnType<typeof scanLines>} lines
 */
function buildWholeFileSection(file, lines) {
  const title = findDocumentTitle(lines) ?? file.module;
  const bodyLines = lines.map((line) => line.text);

  return {
    id: `${file.kind}/${slugify(file.module)}`,
    kind: file.kind,
    module: file.module,
    section: title,
    relPath: file.relPath,
    byteStart: 0,
    byteEnd: file.buffer.length,
    approxTokens: estimateTokens(file.buffer.length),
    keywords: mineKeywords({ title, module: file.module, bodyLines }),
  };
}

/**
 * @param {CorpusFile} file
 * @param {ReturnType<typeof scanLines>} lines
 */
function buildSectorSections(file, lines) {
  const headings = findSectionHeadings(lines);
  if (headings.length === 0) {
    throw new Error(
      `No "## N. Title" sections found in ${file.relPath}. ` +
        'Sector modules must be indexed at section level, never whole-file.',
    );
  }

  const sectorSlug = slugify(file.sector ?? '');
  const moduleSlug = slugify(file.module);

  return headings.map((entry, position) => {
    const byteStart = entry.line.byteStart;
    const byteEnd = headings[position + 1]?.line.byteStart ?? file.buffer.length;
    const title = entry.heading.title;
    const bodyLines = lines
      .filter((line) => line.byteStart > byteStart && line.byteStart < byteEnd)
      .map((line) => line.text);

    return {
      id: `sector/${sectorSlug}/${moduleSlug}#${entry.heading.number}`,
      kind: 'sector',
      sector: file.sector,
      module: file.module,
      section: `${entry.heading.number}. ${title}`,
      relPath: file.relPath,
      byteStart,
      byteEnd,
      approxTokens: estimateTokens(byteEnd - byteStart),
      keywords: mineKeywords({
        title,
        module: file.module,
        sector: file.sector,
        bodyLines,
      }),
    };
  });
}

/**
 * Build the full index payload. `generatedAt` is added by the caller so the
 * payload itself stays comparable between runs.
 *
 * @param {string} knowledgeDir
 * @returns {Promise<{ fileCount: number, sections: import('./types.mjs').PackSectionLike[] }>}
 */
export async function buildIndexPayload(knowledgeDir) {
  await assertDirectory(knowledgeDir);
  const files = await readCorpus(knowledgeDir);
  if (files.length === 0) {
    throw new Error(`No corpus markdown found under ${knowledgeDir}`);
  }

  const sections = files.flatMap(buildFileSections);
  assertUniqueIds(sections);

  return { fileCount: files.length, sections };
}

/**
 * @param {readonly { id: string, relPath: string }[]} sections
 */
function assertUniqueIds(sections) {
  const seen = new Map();
  for (const section of sections) {
    const previous = seen.get(section.id);
    if (previous) {
      throw new Error(
        `Duplicate section id "${section.id}" from ${previous} and ${section.relPath}`,
      );
    }
    seen.set(section.id, section.relPath);
  }
}

/**
 * @param {string} dir
 */
async function assertDirectory(dir) {
  const stats = await stat(dir).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Knowledge directory not found: ${dir}`);
  }
}

/**
 * Convert a forward-slashed relPath into a platform path segment list.
 *
 * @param {string} relPath
 * @returns {string}
 */
export function toPlatformPath(relPath) {
  return relPath.split(posix.sep).join(sep);
}
