/**
 * Vault storage.
 *
 * Phase-2 seam: everything above this file talks to `VaultStorage`, never to
 * `fs`. Swapping files for a database is one new implementation of the
 * interface and nothing else changes.
 *
 * On-disk layout, rooted at app.getPath('userData')/vaults/:
 *   <vaultId>/graph.json   the KnowledgeGraph document
 *   <vaultId>/meta.json    the VaultSummary sidecar (cheap `list()` without
 *                          parsing every graph)
 *
 * Every write is atomic: temp file in the SAME directory -> fsync -> rename.
 * A crash mid-save leaves either the old file or the new one, never a torn one.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_VIEW, SCHEMA_VERSION, type KnowledgeGraph } from '../../shared/types/graph';
import type { VaultSummary } from '../../shared/types/ipc';
import { createLogger, errorMessage } from './logger';
import { parseKnowledgeGraph } from './schema/graph-schema';

const log = createLogger('vault');

const GRAPH_FILE = 'graph.json';
const META_FILE = 'meta.json';
const MAX_NAME_LENGTH = 120;
const JSON_INDENT = 2;

// ---------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------

export interface VaultStorage {
  list(): Promise<VaultSummary[]>;
  create(name: string): Promise<VaultSummary>;
  open(id: string): Promise<KnowledgeGraph>;
  save(id: string, graph: KnowledgeGraph): Promise<{ savedAt: string }>;
  delete(id: string): Promise<boolean>;
  rename(id: string, name: string): Promise<VaultSummary>;
  /** Absolute directory for a vault — the bridge scopes `--add-dir` to it. */
  directoryFor(id: string): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Vault ids address a directory, so they must never contain path syntax. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidVaultId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function normalizeVaultName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

export function createEmptyGraph(id: string, name: string, now: string): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    cells: [],
    nodes: [],
    edges: [],
    view: DEFAULT_VIEW,
  };
}

function summaryOf(graph: KnowledgeGraph, dir: string): VaultSummary {
  return {
    id: graph.id,
    name: graph.name,
    path: dir,
    nodeCount: graph.nodes.length,
    cellCount: graph.cells.length,
    updatedAt: graph.updatedAt,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `text` to `target` atomically.
 *
 * The temp file must live in the same directory so the rename stays within one
 * filesystem — rename is only atomic there. fsync before rename so the data is
 * on the platter, not just in the page cache, when the directory entry flips.
 */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  const dir = path.dirname(target);
  const tempPath = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tempPath, 'w');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    await fs.rename(tempPath, target);
  } catch (error: unknown) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(`Atomic write failed for ${target}: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// File-backed implementation
// ---------------------------------------------------------------------------

export class FileVaultStorage implements VaultStorage {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  directoryFor(id: string): string {
    if (!isValidVaultId(id)) throw new Error(`Invalid vault id: ${String(id)}`);
    return path.join(this.rootDir, id);
  }

  async list(): Promise<VaultSummary[]> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });

    const summaries: VaultSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidVaultId(entry.name)) continue;
      const summary = await this.readMeta(entry.name);
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Refuse a name another vault already answers to.
   *
   * Compared case- and whitespace-insensitively, because "Economy" and
   * "economy " are the same vault to whoever is picking one out of a list. A
   * duplicate makes every later reference ambiguous — the title bar, the export
   * filename, an import landing beside the file it came from — and refusing is
   * kinder than silently appending a "(2)" nobody asked for.
   */
  private async assertNameIsFree(name: string, exceptId?: string): Promise<void> {
    const wanted = normalizeVaultName(name).toLocaleLowerCase();
    const existing = await this.list();
    const clash = existing.find(
      (vault) => vault.id !== exceptId && vault.name.trim().toLocaleLowerCase() === wanted,
    );
    if (clash) {
      throw new Error(`A vault named "${clash.name}" already exists. Choose a different name.`);
    }
  }

  async create(name: string): Promise<VaultSummary> {
    const cleanName = normalizeVaultName(name) || 'Untitled';
    await this.assertNameIsFree(cleanName);
    const id = randomUUID();
    const dir = path.join(this.rootDir, id);
    await fs.mkdir(dir, { recursive: true });

    const graph = createEmptyGraph(id, cleanName, new Date().toISOString());
    await this.writeGraph(id, graph);
    log.info('created vault', { id, name: cleanName });
    return summaryOf(graph, dir);
  }

  async open(id: string): Promise<KnowledgeGraph> {
    const dir = this.directoryFor(id);
    const graphPath = path.join(dir, GRAPH_FILE);

    let text: string;
    try {
      text = await fs.readFile(graphPath, 'utf8');
    } catch (error: unknown) {
      log.error('vault read failed', error);
      throw new Error(`Vault "${id}" could not be read: ${errorMessage(error)}`);
    }

    const parsed = parseKnowledgeGraph(text);
    if (!parsed.ok) {
      log.error('vault failed schema validation', { id, reason: parsed.reason });
      throw new Error(
        `Vault "${id}" is not a valid Magistral graph and was not loaded — ${parsed.reason}. ` +
          `The file is untouched at ${graphPath}.`,
      );
    }
    return parsed.value;
  }

  async save(id: string, graph: KnowledgeGraph): Promise<{ savedAt: string }> {
    const validated = parseKnowledgeGraph(JSON.stringify(graph));
    if (!validated.ok) {
      throw new Error(`Refusing to save an invalid graph: ${validated.reason}`);
    }

    const savedAt = new Date().toISOString();
    const stamped: KnowledgeGraph = { ...validated.value, id, updatedAt: savedAt };
    await this.writeGraph(id, stamped);
    return { savedAt };
  }

  async delete(id: string): Promise<boolean> {
    const dir = this.directoryFor(id);
    if (!(await pathExists(dir))) return false;
    await fs.rm(dir, { recursive: true, force: true });
    log.info('deleted vault', { id });
    return true;
  }

  async rename(id: string, name: string): Promise<VaultSummary> {
    const cleanName = normalizeVaultName(name);
    if (!cleanName) throw new Error('Vault name cannot be empty');
    // Excluding itself, so re-saving a vault under its own name is not a clash.
    await this.assertNameIsFree(cleanName, id);

    const graph = await this.open(id);
    const renamed: KnowledgeGraph = {
      ...graph,
      name: cleanName,
      updatedAt: new Date().toISOString(),
    };
    await this.writeGraph(id, renamed);
    return summaryOf(renamed, this.directoryFor(id));
  }

  // -- internals ------------------------------------------------------------

  private async writeGraph(id: string, graph: KnowledgeGraph): Promise<void> {
    const dir = this.directoryFor(id);
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, GRAPH_FILE), JSON.stringify(graph, null, JSON_INDENT));
    await writeFileAtomic(
      path.join(dir, META_FILE),
      JSON.stringify(summaryOf(graph, dir), null, JSON_INDENT),
    );
  }

  /** Returns null (with a log line) rather than failing the whole listing. */
  private async readMeta(id: string): Promise<VaultSummary | null> {
    const dir = path.join(this.rootDir, id);
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8')) as unknown;
      return toSummary(raw, id, dir);
    } catch (error: unknown) {
      log.warn('vault meta unreadable, skipping in listing', { id, error: errorMessage(error) });
      return null;
    }
  }
}

/** meta.json is our own file, but it still came off disk — validate it. */
function toSummary(raw: unknown, id: string, dir: string): VaultSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const name = normalizeVaultName(record.name);
  if (!name) return null;

  return {
    id,
    name,
    path: dir,
    nodeCount: typeof record.nodeCount === 'number' ? record.nodeCount : 0,
    cellCount: typeof record.cellCount === 'number' ? record.cellCount : 0,
    updatedAt:
      typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  };
}
