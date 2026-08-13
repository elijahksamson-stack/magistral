/**
 * The index builder, run against the REAL bundled corpus.
 *
 * Fixtures would prove the parser works on fixtures. The thing that actually
 * has to hold is that all 45 shipped files index correctly and that every byte
 * range slices back to the heading it claims — so that is what is tested here.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildIndexPayload, describePath, humanizeFileName } from './lib/corpus.mjs';
import { verifyIndex } from './lib/verify-index.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWLEDGE_DIR = join(REPO_ROOT, 'resources', 'knowledge');
const INDEX_PATH = join(KNOWLEDGE_DIR, 'index.json');

/**
 * The public repository ships no research corpus — resources/knowledge holds
 * only _system, the per-action instruction wording. Everything below asserts
 * properties of a SPECIFIC bundled corpus, so with none present there is
 * nothing to assert and these suites skip instead of failing. Supply a corpus
 * and they run again.
 */
const HAS_CORPUS = readdirSync(KNOWLEDGE_DIR, { withFileTypes: true }).some(
  (entry) => entry.isDirectory() && entry.name !== '_system',
);

const EXPECTED_FILE_COUNT = 45;
const EXPECTED_SECTOR_FILES = 39;
const EXPECTED_MINDSET_FILES = 5;
const EXPECTED_MACROMAN_FILES = 1;
const SECTIONS_PER_SECTOR_MODULE = 13;

/** @type {{ fileCount: number, sections: import('./lib/types.mjs').PackSectionLike[] }} */
let payload;

beforeAll(async () => {
  if (!HAS_CORPUS) return;
  payload = await buildIndexPayload(KNOWLEDGE_DIR);
});

describe.skipIf(!HAS_CORPUS)('corpus coverage', () => {
  it('indexes all 45 bundled files', () => {
    expect(payload.fileCount).toBe(EXPECTED_FILE_COUNT);
  });

  it('splits sector modules at section level and keeps the small files whole', () => {
    const counts = payload.sections.reduce((totals, section) => {
      totals[section.kind] = (totals[section.kind] ?? 0) + 1;
      return totals;
    }, {});

    expect(counts.mindset).toBe(EXPECTED_MINDSET_FILES);
    expect(counts.macroman).toBe(EXPECTED_MACROMAN_FILES);
    expect(counts.sector).toBe(EXPECTED_SECTOR_FILES * SECTIONS_PER_SECTOR_MODULE);
  });

  it('never emits a whole-file sector section', () => {
    const sectorFiles = new Set(
      payload.sections.filter((s) => s.kind === 'sector').map((s) => s.relPath),
    );
    expect(sectorFiles.size).toBe(EXPECTED_SECTOR_FILES);

    for (const relPath of sectorFiles) {
      const sections = payload.sections.filter((s) => s.relPath === relPath);
      expect(sections.length).toBeGreaterThan(1);
      expect(sections.every((s) => s.byteStart > 0 || s.section.startsWith('1.'))).toBe(true);
    }
  });

  it('covers all 11 GICS sector folders', () => {
    const sectors = new Set(
      payload.sections.filter((s) => s.kind === 'sector').map((s) => s.sector),
    );
    expect(sectors.size).toBe(11);
    expect(sectors).toContain('Technology');
    expect(sectors).toContain('Real Estate');
  });

  it('gives every section a unique id', () => {
    const ids = payload.sections.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.skipIf(!HAS_CORPUS)('byte ranges', () => {
  it('slices back to the exact heading for every single section', async () => {
    const report = await verifyIndex(KNOWLEDGE_DIR, payload);
    expect(report.failures).toEqual([]);
    expect(report.checked).toBe(payload.sections.length);
  });

  it('re-reads each sector slice from disk and finds its own heading first', async () => {
    const buffers = new Map();

    for (const section of payload.sections.filter((s) => s.kind === 'sector')) {
      if (!buffers.has(section.relPath)) {
        buffers.set(section.relPath, await readFile(join(KNOWLEDGE_DIR, section.relPath)));
      }
      const slice = buffers
        .get(section.relPath)
        .subarray(section.byteStart, section.byteEnd)
        .toString('utf8');

      expect(slice.startsWith(`## ${section.section}\n`)).toBe(true);
    }
  });

  it('produces slices that survive a UTF-8 round trip', async () => {
    // Multi-byte characters are everywhere in this corpus. A range that cut one
    // in half would decode to U+FFFD and re-encode to a different length.
    const multiByteSections = [];

    for (const section of payload.sections) {
      const buffer = await readFile(join(KNOWLEDGE_DIR, section.relPath));
      const slice = buffer.subarray(section.byteStart, section.byteEnd);
      const text = slice.toString('utf8');
      expect(Buffer.byteLength(text, 'utf8')).toBe(slice.length);
      if (text.length !== slice.length) multiByteSections.push(section.id);
    }

    // Guard against the test passing vacuously on an all-ASCII corpus.
    expect(multiByteSections.length).toBeGreaterThan(100);
  });

  it('tiles each file contiguously to its last byte', async () => {
    const byFile = new Map();
    for (const section of payload.sections) {
      byFile.set(section.relPath, [...(byFile.get(section.relPath) ?? []), section]);
    }

    for (const [relPath, sections] of byFile) {
      const ordered = [...sections].sort((a, b) => a.byteStart - b.byteStart);
      const buffer = await readFile(join(KNOWLEDGE_DIR, relPath));

      expect(ordered.at(-1).byteEnd).toBe(buffer.length);
      for (let i = 1; i < ordered.length; i += 1) {
        expect(ordered[i].byteStart).toBe(ordered[i - 1].byteEnd);
      }
    }
  });

  it('leaves only the title and table of contents outside the indexed range', async () => {
    // Deliberate: the TOC is navigation, not reasoning material, and injecting
    // it would spend budget on a list of links the model cannot follow.
    for (const relPath of new Set(
      payload.sections.filter((s) => s.kind === 'sector').map((s) => s.relPath),
    )) {
      const first = payload.sections
        .filter((s) => s.relPath === relPath)
        .reduce((lowest, s) => (s.byteStart < lowest.byteStart ? s : lowest));
      const buffer = await readFile(join(KNOWLEDGE_DIR, relPath));
      const preamble = buffer.subarray(0, first.byteStart).toString('utf8');

      expect(first.section).toMatch(/^1\. /);
      expect(preamble).toContain('## Table of contents');
      expect(preamble).not.toContain('\n## 1. ');
    }
  });
});

describe.skipIf(!HAS_CORPUS)('section metadata', () => {
  it('estimates tokens from the byte range', () => {
    for (const section of payload.sections) {
      expect(section.approxTokens).toBe(Math.ceil((section.byteEnd - section.byteStart) / 4));
      expect(section.approxTokens).toBeGreaterThan(0);
    }
  });

  it('gives every section at least a few routing keywords', () => {
    for (const section of payload.sections) {
      expect(section.keywords.length).toBeGreaterThanOrEqual(4);
      expect(section.keywords).toEqual([...new Set(section.keywords)]);
      expect(section.keywords.every((k) => k === k.toLowerCase())).toBe(true);
    }
  });

  it('leads the keywords with terms from the section heading', () => {
    const section = payload.sections.find(
      (s) => s.id === 'sector/technology/semiconductors#2',
    );
    expect(section.section).toBe('2. Inputs and Dependencies');
    expect(section.keywords.slice(0, 2)).toEqual(['inputs', 'dependencies']);
    expect(section.keywords).toContain('semiconductors');
  });

  it('sets sector only on sector sections', () => {
    for (const section of payload.sections) {
      if (section.kind === 'sector') expect(typeof section.sector).toBe('string');
      else expect(section.sector).toBeUndefined();
    }
  });

  it('uses forward-slashed relative paths', () => {
    for (const section of payload.sections) {
      expect(section.relPath.startsWith('/')).toBe(false);
      expect(section.relPath).not.toContain('\\');
      expect(section.relPath.endsWith('.md')).toBe(true);
    }
  });
});

describe.skipIf(!HAS_CORPUS)('idempotence', () => {
  it('produces byte-identical sections on a second build', async () => {
    const second = await buildIndexPayload(KNOWLEDGE_DIR);
    expect(JSON.stringify(second.sections)).toBe(JSON.stringify(payload.sections));
  });

  it('matches the committed resources/knowledge/index.json', async () => {
    const committed = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
    expect(committed.fileCount).toBe(payload.fileCount);
    expect(JSON.stringify(committed.sections)).toBe(JSON.stringify(payload.sections));
    expect(typeof committed.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(committed.generatedAt))).toBe(false);
  });
});

describe.skipIf(!HAS_CORPUS)('path classification', () => {
  it.each([
    ['sectors/Technology/Semiconductors.md', 'sector', 'Technology', 'Semiconductors'],
    ['mindset/01_Seeing_Clearly.md', 'mindset', undefined, 'Seeing Clearly'],
    ['macroman/macroman.md', 'macroman', undefined, 'macroman'],
  ])('%s', (relPath, kind, sector, module) => {
    expect(describePath(relPath)).toEqual({ kind, ...(sector ? { sector } : {}), module });
  });

  it('ignores paths that are not corpus', () => {
    expect(describePath('index.json')).toBeNull();
    expect(describePath('sectors/Technology/nested/Deep.md')).toBeNull();
  });

  it('humanizes filenames without mangling ampersands', () => {
    expect(humanizeFileName('Oil & Gas.md')).toBe('Oil & Gas');
    expect(humanizeFileName('05_Underwriting_a_Business.md')).toBe('Underwriting a Business');
  });
});
