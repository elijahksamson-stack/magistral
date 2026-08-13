/**
 * Reading an imported document into plain text.
 *
 * A boundary: the file is arbitrary and the user picked it, so nothing here
 * trusts it. The extension decides the reader, the size is capped before
 * anything is read into memory, and a parse failure surfaces as a message the
 * author can act on rather than a stack trace.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';

import { DOCUMENT_CHAR_LIMIT, type SourceDocument } from '../../shared/types/claude';
import { createLogger, errorMessage } from './logger';

const log = createLogger('documents');

/**
 * Hard ceiling on bytes read off disk, well above DOCUMENT_CHAR_LIMIT.
 *
 * The character limit governs what reaches the model; this one stops a
 * mis-picked 2GB file from being loaded into memory at all. DOCX is a zip, so
 * its on-disk size is much smaller than its text — the headroom is deliberate.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = [
  'pdf',
  'docx',
  'doc',
  'rtf',
  'md',
  'markdown',
  'txt',
  'text',
] as const;

/** Collapses the runs of blank lines that DOCX extraction tends to produce. */
const EXCESS_BLANK_LINES = /\n{3,}/g;

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(EXCESS_BLANK_LINES, '\n\n').trim();
}

function truncate(text: string): { text: string; isTruncated: boolean } {
  if (text.length <= DOCUMENT_CHAR_LIMIT) return { text, isTruncated: false };
  // Cut on a paragraph boundary when one is near, so the model is not handed a
  // sentence severed mid-clause.
  const hard = text.slice(0, DOCUMENT_CHAR_LIMIT);
  const lastBreak = hard.lastIndexOf('\n\n');
  const cut = lastBreak > DOCUMENT_CHAR_LIMIT * 0.8 ? hard.slice(0, lastBreak) : hard;
  return { text: cut, isTruncated: true };
}

async function readDocx(filePath: string): Promise<string> {
  // Imported lazily: mammoth pulls in a zip reader and an XML parser, and a
  // session that never imports a .docx should not pay for them at startup.
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages.length > 0) {
    log.info('docx conversion notes', result.messages.map((m) => m.message).join('; '));
  }
  return result.value;
}

/**
 * PDF and RTF via officeparser.
 *
 * A PDF carries no reading order guarantee — text is positioned glyphs, not a
 * document — so extraction is best-effort by nature. A scanned PDF holds
 * images and yields nothing at all, which the empty-text check below reports
 * as a readable failure rather than an empty distillation.
 */
async function readWithOfficeParser(filePath: string): Promise<string> {
  const { parseOffice } = await import('officeparser');
  // Returns a result object, not a string — `toText()` is the plain-text view.
  // Stringifying the object yielded "[object Object]", which would have been
  // handed to the model as the document.
  const result = await parseOffice(filePath);
  const text = typeof result.toText === 'function' ? result.toText() : result.content;
  return typeof text === 'string' ? text : '';
}

/** Legacy binary .doc (Word 97-2003), which is a different format from .docx. */
async function readLegacyDoc(filePath: string): Promise<string> {
  const { default: WordExtractor } = await import('word-extractor');
  const extracted = await new WordExtractor().extract(filePath);
  return extracted.getBody();
}

async function readPlainText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

/** Reader per extension. The dialog and this table must agree. */
async function readByExtension(extension: string, filePath: string): Promise<string> {
  switch (extension) {
    case 'docx':
      return readDocx(filePath);
    case 'doc':
      return readLegacyDoc(filePath);
    case 'pdf':
    case 'rtf':
      return readWithOfficeParser(filePath);
    default:
      return readPlainText(filePath);
  }
}

/** Read one file into plain text. Throws with an actionable message. */
export async function readDocument(filePath: string): Promise<SourceDocument> {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const name = path.basename(filePath);

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(filePath);
  } catch (error: unknown) {
    throw new Error(`Could not open ${name}: ${errorMessage(error)}`);
  }

  if (!stats.isFile()) {
    throw new Error(`${name} is not a file.`);
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(
      `${name} is ${Math.round(stats.size / 1024 / 1024)}MB — too large to import.`,
    );
  }

  let raw: string;
  try {
    raw = await readByExtension(extension, filePath);
  } catch (error: unknown) {
    throw new Error(`Could not read ${name}: ${errorMessage(error)}`);
  }

  const normalized = normalizeWhitespace(raw);
  if (normalized.length === 0) {
    // Most often a scanned PDF: real pages, but images rather than text.
    const hint =
      extension === 'pdf'
        ? ' It may be a scanned document — this reads text, not images.'
        : '';
    throw new Error(`${name} has no readable text in it.${hint}`);
  }

  const { text, isTruncated } = truncate(normalized);
  log.info('imported document', `${name} (${text.length} chars${isTruncated ? ', truncated' : ''})`);
  return { name, text, isTruncated };
}

/** Show the open dialog and read what the author picked. Null if dismissed. */
export async function pickAndReadDocument(
  window: BrowserWindow | null,
): Promise<SourceDocument | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import a document to distill',
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: [...SUPPORTED_EXTENSIONS] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Word document', extensions: ['docx', 'doc'] },
      { name: 'Rich text', extensions: ['rtf'] },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'Plain text', extensions: ['txt', 'text'] },
    ],
  };

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;

  return readDocument(chosen);
}
