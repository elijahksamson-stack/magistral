/**
 * YAML and interactive-HTML export, plus vault import.
 *
 * The renderer builds both documents (it owns the projection and the styling);
 * main owns the save dialog and the write. Import is a boundary — an arbitrary
 * file the user picked — so it is schema-validated before it is allowed
 * anywhere near the core.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type { KnowledgeGraph } from '../../shared/types/graph';
import type { ExportResult } from '../../shared/types/ipc';
import { ensureNodeCellCoverage } from './graph-cell-coverage';
import { createLogger, errorMessage } from './logger';
import { parseKnowledgeGraph } from './schema/graph-schema';
import { writeFileAtomic } from './vault';

const log = createLogger('export');

const NOT_SAVED: ExportResult = { saved: false };

function safeBaseName(name: string, fallback: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Write the renderer-produced YAML outline, under a save dialog.
 *
 * A projection of the graph rather than the graph itself, so unlike a vault
 * file there is nothing here to keep byte-identical with the core.
 */
export async function exportGraphYaml(
  window: BrowserWindow | null,
  text: string,
  suggestedName?: string,
): Promise<ExportResult> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Refusing to write an empty export.');
  }

  const defaultPath = `${safeBaseName(suggestedName ?? 'magistral', 'magistral')}`;
  const choice = await showSave(window, defaultPath, [
    { name: 'Magistral knowledge map', extensions: ['yaml', 'yml'] },
  ]);
  if (!choice) return NOT_SAVED;

  await writeFileAtomic(choice, text);
  log.info('exported yaml', choice);
  return { saved: true, path: choice, bytes: Buffer.byteLength(text, 'utf8') };
}

function openOptions(): Electron.OpenDialogOptions {
  return {
    title: 'Import knowledge map',
    properties: ['openFile'],
    filters: [{ name: 'Knowledge map', extensions: ['yaml', 'yml'] }],
  };
}

/**
 * Read an exported knowledge map off disk.
 *
 * Returns the text and the file's own name — the name becomes the vault's, so
 * an imported map is findable by what it was called rather than by a UUID. The
 * parsing belongs to the renderer, which owns the map format; this end only
 * knows how to open a file and hand back what was inside it.
 */
export async function importMapYaml(
  window: BrowserWindow | null,
): Promise<{ fileName: string; text: string } | null> {
  const result = window
    ? await dialog.showOpenDialog(window, openOptions())
    : await dialog.showOpenDialog(openOptions());

  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;

  try {
    return { fileName: path.basename(chosen), text: await fs.readFile(chosen, 'utf8') };
  } catch (error: unknown) {
    throw new Error(`Could not read ${chosen}: ${errorMessage(error)}`);
  }
}

async function showSave(
  window: BrowserWindow | null,
  defaultPath: string,
  filters: Electron.FileFilter[],
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = { defaultPath, filters };
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}
