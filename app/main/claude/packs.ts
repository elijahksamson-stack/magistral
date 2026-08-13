/**
 * Knowledge pack selection.
 *
 * The bundled corpus is 45 files; the sector modules alone are 45-69 KB each
 * (~15k tokens), so a whole sector file would blow PACK_TOKEN_BUDGET on its
 * own. resources/knowledge/index.json maps every module down to SECTION level
 * with byte ranges, and this module slices only the sections a request needs
 * straight out of the file with a positional read — the big files are never
 * loaded into memory.
 *
 * Selection policy:
 *   mindset  — always, capped so it cannot crowd out topical material
 *   sector   — by keyword hit-count against the request text
 *   macroman — only when the text uses macro language
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PACK_TOKEN_BUDGET,
  type KnowledgeIndex,
  type PackKind,
  type PackSection,
} from '../../../shared/types/claude';
import { createLogger, errorMessage } from '../logger';

const log = createLogger('packs');

export const INDEX_FILENAME = 'index.json';

/** Mindset is unconditional, so it gets a ceiling — topical packs need room. */
export const MINDSET_BUDGET_RATIO = 0.45;

/** A sector section must clear this many keyword hits to be worth its tokens. */
export const MIN_SECTOR_KEYWORD_HITS = 1;

/** Words that make a request macro-shaped. */
export const MACRO_TRIGGER_TERMS: readonly string[] = [
  'inflation',
  'deflation',
  'interest rate',
  'rates',
  'yield curve',
  'central bank',
  'federal reserve',
  'the fed',
  'monetary',
  'fiscal',
  'recession',
  'gdp',
  'cpi',
  'unemployment',
  'tariff',
  'currency',
  'macro',
  'liquidity',
  'credit cycle',
  'commodity prices',
] as const;

export interface PackSelection {
  readonly sections: readonly PackSection[];
  readonly approxTokens: number;
  /** Section ids, for the `packs` stream event. */
  readonly ids: readonly string[];
}

// ---------------------------------------------------------------------------
// Index loading
// ---------------------------------------------------------------------------

let hasWarnedAboutMissingIndex = false;

function isPackSection(value: unknown): value is PackSection {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<PackSection>;
  return (
    typeof s.id === 'string' &&
    (s.kind === 'mindset' || s.kind === 'sector' || s.kind === 'macroman') &&
    typeof s.module === 'string' &&
    typeof s.section === 'string' &&
    typeof s.relPath === 'string' &&
    typeof s.byteStart === 'number' &&
    typeof s.byteEnd === 'number' &&
    s.byteEnd > s.byteStart &&
    typeof s.approxTokens === 'number' &&
    Array.isArray(s.keywords)
  );
}

/**
 * Load and validate the index. Returns an empty section list — never throws —
 * when agent 6 has not generated index.json yet; the caller then degrades to
 * mindset-only. The warning is logged once, not once per keystroke.
 */
export async function loadKnowledgeIndex(knowledgeDir: string): Promise<KnowledgeIndex | null> {
  const indexPath = path.join(knowledgeDir, INDEX_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (error: unknown) {
    if (!hasWarnedAboutMissingIndex) {
      hasWarnedAboutMissingIndex = true;
      log.warn(
        `${indexPath} is not present — falling back to mindset-only packs`,
        errorMessage(error),
      );
    }
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const record = parsed as Record<string, unknown>;
    const sections = Array.isArray(record.sections) ? record.sections.filter(isPackSection) : [];
    return {
      generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
      fileCount: typeof record.fileCount === 'number' ? record.fileCount : 0,
      sections,
    };
  } catch (error: unknown) {
    log.error(`${indexPath} is malformed — falling back to mindset-only packs`, error);
    return null;
  }
}

/** Exposed for tests; resets the "warn once" latch. */
export function resetPackWarnings(): void {
  hasWarnedAboutMissingIndex = false;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function countKeywordHits(section: PackSection, haystack: string): number {
  let hits = 0;
  for (const keyword of section.keywords) {
    if (typeof keyword !== 'string' || keyword.length === 0) continue;
    if (haystack.includes(keyword.toLowerCase())) hits += 1;
  }
  return hits;
}

export function hasMacroLanguage(text: string): boolean {
  const haystack = text.toLowerCase();
  return MACRO_TRIGGER_TERMS.some((term) => haystack.includes(term));
}

function ofKind(sections: readonly PackSection[], kind: PackKind): PackSection[] {
  return sections.filter((section) => section.kind === kind);
}

/** Take sections in order until adding the next one would exceed `budget`. */
function takeWithinBudget(
  candidates: readonly PackSection[],
  budget: number,
  spent: number,
): { chosen: PackSection[]; spent: number } {
  const chosen: PackSection[] = [];
  let used = spent;
  for (const section of candidates) {
    if (used + section.approxTokens > budget) continue;
    chosen.push(section);
    used += section.approxTokens;
  }
  return { chosen, spent: used };
}

/**
 * Choose sections for a request. Pure — no I/O — so the policy is testable
 * without a corpus on disk.
 */
export function selectSections(
  index: KnowledgeIndex | null,
  requestText: string,
  budget: number = PACK_TOKEN_BUDGET,
): PackSelection {
  const sections = index?.sections ?? [];
  if (sections.length === 0) return { sections: [], approxTokens: 0, ids: [] };

  const haystack = requestText.toLowerCase();

  const mindset = takeWithinBudget(
    [...ofKind(sections, 'mindset')].sort((a, b) => a.id.localeCompare(b.id)),
    Math.floor(budget * MINDSET_BUDGET_RATIO),
    0,
  );

  const sectorRanked = ofKind(sections, 'sector')
    .map((section) => ({ section, hits: countKeywordHits(section, haystack) }))
    .filter((entry) => entry.hits >= MIN_SECTOR_KEYWORD_HITS)
    .sort((a, b) => b.hits - a.hits || a.section.id.localeCompare(b.section.id))
    .map((entry) => entry.section);

  const withSectors = takeWithinBudget(sectorRanked, budget, mindset.spent);

  const macroCandidates = hasMacroLanguage(requestText) ? ofKind(sections, 'macroman') : [];
  const withMacro = takeWithinBudget(macroCandidates, budget, withSectors.spent);

  const chosen = [...mindset.chosen, ...withSectors.chosen, ...withMacro.chosen];
  return {
    sections: chosen,
    approxTokens: withMacro.spent,
    ids: chosen.map((section) => section.id),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Read exactly [byteStart, byteEnd) of a corpus file. Never reads the whole file. */
export async function readSection(
  knowledgeDir: string,
  section: PackSection,
): Promise<string | null> {
  const absolute = path.resolve(knowledgeDir, section.relPath);
  if (!absolute.startsWith(path.resolve(knowledgeDir) + path.sep)) {
    log.error('pack section escapes the knowledge dir, refusing to read', section.relPath);
    return null;
  }

  const length = section.byteEnd - section.byteStart;
  if (length <= 0) return null;

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(absolute, 'r');
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, section.byteStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error: unknown) {
    log.error(`could not read pack section ${section.id}`, error);
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Render the selected sections as the corpus block of the prompt. */
export async function renderSections(
  knowledgeDir: string,
  selection: PackSelection,
): Promise<string> {
  if (selection.sections.length === 0) return '';

  const blocks: string[] = [];
  for (const section of selection.sections) {
    const text = await readSection(knowledgeDir, section);
    if (!text) continue;
    const heading = section.sector
      ? `${section.sector} / ${section.module} — ${section.section}`
      : `${section.module} — ${section.section}`;
    blocks.push(`### ${heading}\n${text.trim()}`);
  }
  return blocks.join('\n\n');
}
