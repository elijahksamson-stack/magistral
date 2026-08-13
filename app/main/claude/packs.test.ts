import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeIndex, PackSection } from '../../../shared/types/claude';
import {
  hasMacroLanguage,
  loadKnowledgeIndex,
  readSection,
  renderSections,
  resetPackWarnings,
  selectSections,
} from './packs';

function section(overrides: Partial<PackSection> & Pick<PackSection, 'id' | 'kind'>): PackSection {
  return {
    module: 'Module',
    section: 'Section',
    relPath: 'mindset/01.md',
    byteStart: 0,
    byteEnd: 100,
    approxTokens: 1_000,
    keywords: [],
    ...overrides,
  };
}

function index(sections: PackSection[]): KnowledgeIndex {
  return { generatedAt: '2026-01-01T00:00:00.000Z', fileCount: sections.length, sections };
}

describe('selectSections', () => {
  it('always includes mindset sections', () => {
    const result = selectSections(
      index([section({ id: 'mindset:01', kind: 'mindset' })]),
      'anything at all',
    );

    expect(result.ids).toEqual(['mindset:01']);
  });

  it('returns nothing when there is no index — the mindset-only degrade path', () => {
    const result = selectSections(null, 'semiconductors');

    expect(result.ids).toEqual([]);
    expect(result.approxTokens).toBe(0);
  });

  it('selects sector sections by keyword match', () => {
    const result = selectSections(
      index([
        section({ id: 'sec:semis', kind: 'sector', keywords: ['semiconductor', 'fab'] }),
        section({ id: 'sec:banks', kind: 'sector', keywords: ['deposit', 'net interest margin'] }),
      ]),
      'The semiconductor fab cycle is turning.',
    );

    expect(result.ids).toEqual(['sec:semis']);
  });

  it('ranks sector sections by how many keywords hit', () => {
    const result = selectSections(
      index([
        section({ id: 'sec:one', kind: 'sector', keywords: ['fab'] }),
        section({ id: 'sec:two', kind: 'sector', keywords: ['fab', 'semiconductor', 'wafer'] }),
      ]),
      'wafer starts at the fab, semiconductor demand',
    );

    expect(result.ids[0]).toBe('sec:two');
  });

  it('includes macroman only when macro language is present', () => {
    const withMacro = selectSections(
      index([section({ id: 'macro:1', kind: 'macroman' })]),
      'Inflation is running hot.',
    );
    const without = selectSections(
      index([section({ id: 'macro:1', kind: 'macroman' })]),
      'This company sells shoes.',
    );

    expect(withMacro.ids).toEqual(['macro:1']);
    expect(without.ids).toEqual([]);
  });

  it('stays under the token budget', () => {
    const heavy = Array.from({ length: 20 }, (_unused, i) =>
      section({ id: `sec:${i}`, kind: 'sector', approxTokens: 3_000, keywords: ['fab'] }),
    );

    const result = selectSections(index(heavy), 'fab', 10_000);

    expect(result.approxTokens).toBeLessThanOrEqual(10_000);
    expect(result.sections.length).toBeLessThan(heavy.length);
  });

  it('caps mindset so it cannot crowd out topical material', () => {
    const sections = [
      ...Array.from({ length: 10 }, (_unused, i) =>
        section({ id: `mindset:${i}`, kind: 'mindset', approxTokens: 2_000 }),
      ),
      section({ id: 'sec:semis', kind: 'sector', approxTokens: 2_000, keywords: ['fab'] }),
    ];

    const result = selectSections(index(sections), 'the fab', 10_000);

    expect(result.ids).toContain('sec:semis');
  });

  it('ignores sector sections with no keyword hits', () => {
    const result = selectSections(
      index([section({ id: 'sec:x', kind: 'sector', keywords: ['unrelated'] })]),
      'nothing matches here',
    );

    expect(result.ids).toEqual([]);
  });
});

describe('hasMacroLanguage', () => {
  it('detects macro vocabulary case-insensitively', () => {
    expect(hasMacroLanguage('The Yield Curve inverted')).toBe(true);
    expect(hasMacroLanguage('CPI came in hot')).toBe(true);
  });

  it('does not fire on ordinary business prose', () => {
    expect(hasMacroLanguage('They sell running shoes in Ohio.')).toBe(false);
  });
});

describe('index and section I/O', () => {
  let dir = '';

  beforeEach(async () => {
    resetPackWarnings();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'braindump-packs-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null, not a throw, when index.json is absent', async () => {
    expect(await loadKnowledgeIndex(dir)).toBeNull();
  });

  it('returns null when index.json is malformed', async () => {
    await fs.writeFile(path.join(dir, 'index.json'), '{not json');

    expect(await loadKnowledgeIndex(dir)).toBeNull();
  });

  it('drops index entries that fail validation instead of trusting them', async () => {
    await fs.writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify({
        generatedAt: 'now',
        fileCount: 2,
        sections: [section({ id: 'ok', kind: 'mindset' }), { id: 'broken' }],
      }),
    );

    const loaded = await loadKnowledgeIndex(dir);

    expect(loaded?.sections.map((s) => s.id)).toEqual(['ok']);
  });

  it('reads only the requested byte range', async () => {
    await fs.mkdir(path.join(dir, 'mindset'), { recursive: true });
    await fs.writeFile(path.join(dir, 'mindset', '01.md'), 'AAAABBBBCCCC');

    const text = await readSection(
      dir,
      section({ id: 's', kind: 'mindset', relPath: 'mindset/01.md', byteStart: 4, byteEnd: 8 }),
    );

    expect(text).toBe('BBBB');
  });

  it('refuses a relPath that escapes the knowledge directory', async () => {
    const text = await readSection(
      dir,
      section({ id: 's', kind: 'mindset', relPath: '../../etc/passwd', byteEnd: 4 }),
    );

    expect(text).toBeNull();
  });

  it('renders selected sections with headings', async () => {
    await fs.mkdir(path.join(dir, 'mindset'), { recursive: true });
    await fs.writeFile(path.join(dir, 'mindset', '01.md'), 'the body text');

    const chosen = section({
      id: 's',
      kind: 'mindset',
      module: 'Seeing Clearly',
      section: '1. Frames',
      relPath: 'mindset/01.md',
      byteStart: 0,
      byteEnd: 13,
    });

    const rendered = await renderSections(dir, {
      sections: [chosen],
      approxTokens: 1,
      ids: ['s'],
    });

    expect(rendered).toBe('### Seeing Clearly — 1. Frames\nthe body text');
  });
});
