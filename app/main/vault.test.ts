import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeGraph } from '../../shared/types/graph';
import {
  FileVaultStorage,
  createEmptyGraph,
  isValidVaultId,
  normalizeVaultName,
  writeFileAtomic,
} from './vault';

describe('vault id validation', () => {
  it('accepts a uuid', () => {
    expect(isValidVaultId('0f9b0a2e-9c1a-4f3e-9d1a-2b3c4d5e6f70')).toBe(true);
  });

  it('rejects anything with path syntax — a vault id names a directory', () => {
    expect(isValidVaultId('../escape')).toBe(false);
    expect(isValidVaultId('a/b')).toBe(false);
    expect(isValidVaultId('')).toBe(false);
    expect(isValidVaultId(null)).toBe(false);
  });
});

describe('normalizeVaultName', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeVaultName('  Semis   thesis  ')).toBe('Semis thesis');
  });

  it('returns empty for non-strings', () => {
    expect(normalizeVaultName(undefined)).toBe('');
  });
});

describe('FileVaultStorage', () => {
  let root = '';
  let storage: FileVaultStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'braindump-vaults-'));
    storage = new FileVaultStorage(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('starts empty', async () => {
    expect(await storage.list()).toEqual([]);
  });

  /*
   * Names are how the author picks a vault out of a list, so a duplicate makes
   * every later reference ambiguous — including an import landing beside the
   * file it was made from.
   */
  it('refuses a name another vault already answers to', async () => {
    await storage.create('economy');

    await expect(storage.create('economy')).rejects.toThrow(/already exists/i);
    expect(await storage.list()).toHaveLength(1);
  });

  it('treats case and surrounding space as the same name', async () => {
    await storage.create('economy');

    await expect(storage.create('  Economy ')).rejects.toThrow(/already exists/i);
  });

  it('refuses a rename onto another vault name', async () => {
    await storage.create('economy');
    const second = await storage.create('semis');

    await expect(storage.rename(second.id, 'economy')).rejects.toThrow(/already exists/i);
  });

  /* Re-saving a vault under the name it already has is not a collision. */
  it('lets a vault keep its own name', async () => {
    const only = await storage.create('economy');

    const renamed = await storage.rename(only.id, 'economy');

    expect(renamed.name).toBe('economy');
  });

  it('creates a vault with graph.json and meta.json', async () => {
    const summary = await storage.create('Semis');

    const files = await fs.readdir(path.join(root, summary.id));
    expect(files.sort()).toEqual(['graph.json', 'meta.json']);
    expect(summary.name).toBe('Semis');
  });

  it('round-trips a graph through save and open', async () => {
    const created = await storage.create('Round trip');
    const graph = await storage.open(created.id);

    const edited: KnowledgeGraph = {
      ...graph,
      cells: [
        {
          id: 'cell-1',
          order: 0,
          markdown: 'A [[binding constraint]].',
          createdAt: graph.createdAt,
          updatedAt: graph.createdAt,
        },
      ],
    };
    await storage.save(created.id, edited);

    const reopened = await storage.open(created.id);
    expect(reopened.cells).toHaveLength(1);
    expect(reopened.cells[0]?.markdown).toBe('A [[binding constraint]].');
  });

  it('lists vaults newest-updated first', async () => {
    const first = await storage.create('First');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await storage.create('Second');

    const list = await storage.list();
    expect(list.map((entry) => entry.id)).toEqual([second.id, first.id]);
  });

  it('refuses to load a graph that fails schema validation', async () => {
    const created = await storage.create('Corrupt');
    await fs.writeFile(
      path.join(root, created.id, 'graph.json'),
      JSON.stringify({ schemaVersion: 1, id: created.id }),
    );

    await expect(storage.open(created.id)).rejects.toThrow(/not a valid Magistral graph/);
  });

  it('refuses to load a graph that is not JSON at all', async () => {
    const created = await storage.create('Truncated');
    await fs.writeFile(path.join(root, created.id, 'graph.json'), '{"schemaVersion":1,"id"');

    await expect(storage.open(created.id)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses to save a graph that fails schema validation', async () => {
    const created = await storage.create('Guarded');
    const broken = { ...createEmptyGraph(created.id, 'Guarded', new Date().toISOString()) };
    (broken as { nodes: unknown }).nodes = [{ label: 'no id here' }];

    await expect(storage.save(created.id, broken)).rejects.toThrow(/Refusing to save/);
  });

  it('renames without touching the rest of the document', async () => {
    const created = await storage.create('Old name');
    const before = await storage.open(created.id);

    const renamed = await storage.rename(created.id, 'New name');
    const after = await storage.open(created.id);

    expect(renamed.name).toBe('New name');
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it('rejects an empty rename', async () => {
    const created = await storage.create('Named');

    await expect(storage.rename(created.id, '   ')).rejects.toThrow(/cannot be empty/);
  });

  it('deletes a vault and reports whether it existed', async () => {
    const created = await storage.create('Doomed');

    expect(await storage.delete(created.id)).toBe(true);
    expect(await storage.delete(created.id)).toBe(false);
    expect(await storage.list()).toEqual([]);
  });

  it('rejects a traversal id rather than resolving it', async () => {
    await expect(storage.open('../../etc')).rejects.toThrow(/Invalid vault id/);
  });

  it('skips a vault with unreadable meta rather than failing the whole listing', async () => {
    const good = await storage.create('Good');
    const bad = await storage.create('Bad');
    await fs.writeFile(path.join(root, bad.id, 'meta.json'), 'not json');

    const list = await storage.list();
    expect(list.map((entry) => entry.id)).toEqual([good.id]);
  });
});

describe('writeFileAtomic', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'braindump-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the file', async () => {
    const target = path.join(dir, 'out.json');

    await writeFileAtomic(target, '{"a":1}');

    expect(await fs.readFile(target, 'utf8')).toBe('{"a":1}');
  });

  it('replaces existing content wholesale', async () => {
    const target = path.join(dir, 'out.json');
    await writeFileAtomic(target, 'a longer previous value');

    await writeFileAtomic(target, 'short');

    expect(await fs.readFile(target, 'utf8')).toBe('short');
  });

  it('leaves no temp file behind', async () => {
    const target = path.join(dir, 'out.json');

    await writeFileAtomic(target, 'content');

    expect(await fs.readdir(dir)).toEqual(['out.json']);
  });
});
