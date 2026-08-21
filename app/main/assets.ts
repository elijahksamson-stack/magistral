/**
 * Images attached to a vault.
 *
 * A concept map is not only text. An author with a chart, a photograph of a
 * whiteboard, or a screenshot of a table has something the prose around it
 * cannot say, and until now the only place to put it was outside the app.
 *
 * Images live INSIDE the vault directory, next to graph.json:
 *
 *     <vaultId>/assets/<fileName>
 *
 * Copied in rather than referenced where they sit, for the same reason the
 * bundled corpus holds real files rather than symlinks: a vault that breaks
 * when the author tidies their Downloads folder is not local-first, it is a
 * collection of promises about other people's directories.
 *
 * A cell refers to one as `![[fileName]]`, which the wikilink parser skips —
 * an embed is a file, not a concept, and without that exclusion every image
 * would appear on the canvas as a node named after its filename.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';

import type { AttachedImage } from '../../shared/types/ipc';
import { createLogger, errorMessage } from './logger';

const log = createLogger('assets');

/** Directory inside a vault where attachments live. */
export const ASSETS_DIRECTORY = 'assets';

/**
 * Ceiling on one attached image.
 *
 * Images reach the renderer as data URLs, which base64-encodes them — about a
 * third larger again — and that string crosses the IPC boundary as a structured
 * clone. A 20MB photograph would make the pane stutter every time the concept
 * was opened.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const;

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/**
 * A stored file name, with no path syntax in it.
 *
 * The renderer supplies this name when asking for an image back, so it is
 * untrusted input used to build a path. Anything outside this pattern — a
 * slash, a backslash, a `..` — is refused rather than sanitised, because a
 * "cleaned" traversal attempt is still an attempt.
 */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeFileName(name: string): boolean {
  return SAFE_FILE_NAME.test(name) && !name.includes('..');
}

/** Strip a chosen file's name down to something safe to store and address. */
function sanitizeFileName(original: string): string {
  const extension = path.extname(original).slice(1).toLowerCase();
  const stem = path
    .basename(original, path.extname(original))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 96);
  return `${stem.length > 0 ? stem : 'image'}.${extension}`;
}

function assetsDirectory(vaultDirectory: string): string {
  return path.join(vaultDirectory, ASSETS_DIRECTORY);
}

/** `name.png`, `name-2.png`, `name-3.png` — never silently overwrite. */
async function uniqueName(directory: string, candidate: string): Promise<string> {
  const extension = path.extname(candidate);
  const stem = path.basename(candidate, extension);

  let attempt = candidate;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    try {
      await fs.access(path.join(directory, attempt));
    } catch {
      return attempt; // access threw, so nothing is there
    }
    attempt = `${stem}-${suffix}${extension}`;
  }
  throw new Error('Too many files with that name are already attached.');
}

function dataUrlFor(fileName: string, bytes: Buffer): string {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  const mediaType = MEDIA_TYPES[extension] ?? 'application/octet-stream';
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

/** Copy one image into the vault and hand back how to refer to it. */
export async function attachImage(
  vaultDirectory: string,
  sourcePath: string,
): Promise<AttachedImage> {
  const displayName = path.basename(sourcePath);
  const extension = path.extname(sourcePath).slice(1).toLowerCase();
  if (!(SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(`${displayName} is not an image Magistral can show.`);
  }

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(sourcePath);
  } catch (error: unknown) {
    throw new Error(`Could not open ${displayName}: ${errorMessage(error)}`);
  }
  if (!stats.isFile()) throw new Error(`${displayName} is not a file.`);
  if (stats.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `${displayName} is ${Math.round(stats.size / 1024 / 1024)}MB — too large to attach.`,
    );
  }

  const directory = assetsDirectory(vaultDirectory);
  await fs.mkdir(directory, { recursive: true });
  const fileName = await uniqueName(directory, sanitizeFileName(displayName));

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(sourcePath);
    await fs.writeFile(path.join(directory, fileName), bytes);
  } catch (error: unknown) {
    throw new Error(`Could not attach ${displayName}: ${errorMessage(error)}`);
  }

  log.info('attached image', `${fileName} (${bytes.length} bytes)`);
  return { fileName, dataUrl: dataUrlFor(fileName, bytes) };
}

/**
 * Read an attached image back as a data URL, or null when it is not there.
 *
 * Null rather than a throw: a cell can outlive its attachment — the author may
 * have deleted the file by hand — and a missing image should leave a gap in the
 * panel, not take the panel down.
 */
export async function readImage(vaultDirectory: string, fileName: string): Promise<string | null> {
  if (!isSafeFileName(fileName)) {
    log.warn('refused an unsafe attachment name', fileName);
    return null;
  }

  try {
    const full = path.join(assetsDirectory(vaultDirectory), fileName);
    const stats = await fs.stat(full);
    if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) return null;
    return dataUrlFor(fileName, await fs.readFile(full));
  } catch {
    return null;
  }
}

/** Show the image picker and attach what the author chose. Null if dismissed. */
export async function pickAndAttachImage(
  window: BrowserWindow | null,
  vaultDirectory: string,
): Promise<AttachedImage | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Attach an image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: [...SUPPORTED_IMAGE_EXTENSIONS] }],
  };

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;

  return attachImage(vaultDirectory, chosen);
}
