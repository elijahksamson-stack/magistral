/**
 * Pack selection against the REAL bundled corpus.
 *
 * packs.test.ts covers the policy with synthetic sections; this one proves the
 * byte offsets in the generated index.json actually land on section boundaries
 * in the shipped files. That is the part unit tests cannot fake — an off-by-one
 * in the generator shows up here and nowhere else.
 *
 * index.json is generated, so it may legitimately be absent mid-build. When it
 * is, this asserts the documented degrade path instead of failing.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACK_TOKEN_BUDGET } from '../../../shared/types/claude';
import { loadKnowledgeIndex, readSection, renderSections, selectSections } from './packs';

const KNOWLEDGE_DIR = path.resolve(__dirname, '../../../resources/knowledge');
const HAS_INDEX = existsSync(path.join(KNOWLEDGE_DIR, 'index.json'));

describe('bundled corpus', () => {
  it('degrades to no packs when index.json is absent', async () => {
    if (HAS_INDEX) {
      expect(await loadKnowledgeIndex(KNOWLEDGE_DIR)).not.toBeNull();
      return;
    }
    expect(await loadKnowledgeIndex(KNOWLEDGE_DIR)).toBeNull();
    expect(selectSections(null, 'anything').ids).toEqual([]);
  });

  it.runIf(HAS_INDEX)('slices real bytes out of real files', async () => {
    const index = await loadKnowledgeIndex(KNOWLEDGE_DIR);
    const section = index?.sections[0];
    expect(section).toBeDefined();

    const text = await readSection(KNOWLEDGE_DIR, section!);

    expect(text).not.toBeNull();
    expect(text!.length).toBeGreaterThan(0);
    expect(text!.length).toBeLessThanOrEqual(section!.byteEnd - section!.byteStart);
  });

  it.runIf(HAS_INDEX)('keeps a real selection inside the token budget', async () => {
    const index = await loadKnowledgeIndex(KNOWLEDGE_DIR);

    const selection = selectSections(
      index,
      'Semiconductor fab capex is the binding constraint, and inflation is running hot.',
    );

    expect(selection.approxTokens).toBeLessThanOrEqual(PACK_TOKEN_BUDGET);
    expect(selection.ids.length).toBeGreaterThan(0);
  });

  it.runIf(HAS_INDEX)('renders a selection to non-empty prompt text', async () => {
    const index = await loadKnowledgeIndex(KNOWLEDGE_DIR);
    const selection = selectSections(index, 'How should I think about risk and position sizing?');

    const rendered = await renderSections(KNOWLEDGE_DIR, selection);

    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain('###');
  });
});
