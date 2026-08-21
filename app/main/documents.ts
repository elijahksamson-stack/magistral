/**
 * Reading an imported document into plain text.
 *
 * A boundary: the file is arbitrary and the user picked it, so nothing here
 * trusts it. The extension decides the reader, the size is capped before
 * anything is read into memory, and a parse failure surfaces as a message the
 * author can act on rather than a stack trace.
 */

import { promises as fs, type Dirent } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Folders
//
// A folder is imported as ONE document whose text is an outline: the folder,
// its subdirectories, and the files beneath each. The structure is the point —
// the directory becomes the concept and each subdirectory becomes one of its
// sub-concepts, so a hierarchy the author already built by hand does not have
// to be inferred back out of prose.
// ---------------------------------------------------------------------------

/** Depth below the chosen folder that still becomes structure. */
const MAX_FOLDER_DEPTH = 3;
/** Ceiling on files read from one folder, whatever their size. */
const MAX_FOLDER_FILES = 200;

/**
 * Directories that are never knowledge, only machinery. Reading them spends the
 * character budget on lockfiles and build output, burying whatever the author
 * actually wrote.
 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  '.next',
  '.cache',
  'vendor',
]);

function isReadableName(name: string): boolean {
  // A dotfile is configuration or metadata; neither belongs on a concept map.
  return !name.startsWith('.') && !IGNORED_DIRECTORIES.has(name);
}

function isSupported(filePath: string): boolean {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
}

interface FolderBranch {
  /** Directory name, or '' for files sitting directly in the chosen folder. */
  readonly name: string;
  readonly files: { name: string; text: string }[];
}

/** Read one file, returning null rather than failing the whole import. */
async function readFileForFolder(filePath: string, budget: number): Promise<string | null> {
  if (budget <= 0) return null;
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const normalized = normalizeWhitespace(await readByExtension(extension, filePath));
    return normalized.length > 0 ? normalized.slice(0, budget) : null;
  } catch (error: unknown) {
    // One unreadable file in a folder of fifty is not a failed import.
    log.info('skipped a file while importing a folder', `${filePath}: ${errorMessage(error)}`);
    return null;
  }
}

/** Every supported file under `dir`, depth-first, sharing one file cap. */
async function collectFiles(
  dir: string,
  depth: number,
  budget: { files: number },
): Promise<string[]> {
  if (depth > MAX_FOLDER_DEPTH || budget.files <= 0) return [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isReadableName(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(full, depth + 1, budget)));
    } else if (entry.isFile() && isSupported(full) && budget.files > 0) {
      budget.files -= 1;
      found.push(full);
    }
  }
  return found;
}

/**
 * Read a folder into one outlined document.
 *
 * The character budget is split evenly across the branches rather than spent
 * first-come. Otherwise one large subdirectory consumes the whole limit and
 * every later one arrives empty — putting a subnode on the map with nothing
 * said about it, which is the exact failure this feature exists to avoid.
 */
export async function readFolder(dirPath: string): Promise<SourceDocument> {
  const name = path.basename(dirPath);

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(dirPath);
  } catch (error: unknown) {
    throw new Error(`Could not open ${name}: ${errorMessage(error)}`);
  }
  if (!stats.isDirectory()) throw new Error(`${name} is not a folder.`);

  let children: Dirent[];
  try {
    children = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error: unknown) {
    throw new Error(`Could not read ${name}: ${errorMessage(error)}`);
  }

  const readable = [...children]
    .filter((entry) => isReadableName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const subdirectories = readable.filter((entry) => entry.isDirectory());
  const looseFiles = readable.filter(
    (entry) => entry.isFile() && isSupported(path.join(dirPath, entry.name)),
  );

  if (subdirectories.length === 0 && looseFiles.length === 0) {
    throw new Error(`${name} has no readable documents in it.`);
  }

  const fileBudget = { files: MAX_FOLDER_FILES };
  const branchCount = subdirectories.length + (looseFiles.length > 0 ? 1 : 0);
  const perBranch = Math.floor(DOCUMENT_CHAR_LIMIT / Math.max(branchCount, 1));

  const branches: FolderBranch[] = [];

  if (looseFiles.length > 0) {
    const files: FolderBranch['files'] = [];
    let remaining = perBranch;
    for (const entry of looseFiles) {
      const text = await readFileForFolder(path.join(dirPath, entry.name), remaining);
      if (text === null) continue;
      remaining -= text.length;
      files.push({ name: entry.name, text });
    }
    if (files.length > 0) branches.push({ name: '', files });
  }

  for (const directory of subdirectories) {
    const full = path.join(dirPath, directory.name);
    const files: FolderBranch['files'] = [];
    let remaining = perBranch;
    for (const filePath of await collectFiles(full, 1, fileBudget)) {
      const text = await readFileForFolder(filePath, remaining);
      if (text === null) continue;
      remaining -= text.length;
      files.push({ name: path.relative(full, filePath), text });
    }
    // A subdirectory with nothing readable still names something the author
    // made, so it stays in the outline — with no text rather than no entry.
    branches.push({ name: directory.name, files });
  }

  const sections = [`# Folder: ${name}`];
  for (const branch of branches) {
    sections.push(
      branch.name.length > 0
        ? `## Subfolder: ${branch.name}`
        : '## Files directly in this folder',
    );
    if (branch.files.length === 0) {
      sections.push('(no readable documents in it)');
      continue;
    }
    for (const file of branch.files) {
      sections.push(`### File: ${file.name}\n${file.text}`);
    }
  }

  const { text, isTruncated } = truncate(sections.join('\n\n'));
  const readCount = branches.reduce((total, branch) => total + branch.files.length, 0);
  log.info(
    'imported folder',
    `${name} (${subdirectories.length} subfolders, ${readCount} files, ${text.length} chars${isTruncated ? ', truncated' : ''})`,
  );
  return { name, text, isTruncated, isFolder: true };
}

/** Show the folder picker and read what the author chose. Null if dismissed. */
export async function pickAndReadFolder(
  window: BrowserWindow | null,
): Promise<SourceDocument | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import a folder to distill',
    properties: ['openDirectory'],
  };

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;

  return readFolder(chosen);
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
