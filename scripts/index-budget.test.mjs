/**
 * Budgetability of the generated index.
 *
 * The bridge (app/main/claude/packs.ts) owns the selection policy. What this
 * file tests is the property of the INDEX that policy depends on: that the
 * sections are cut small enough that a budget-respecting selection is always
 * possible. A section larger than PACK_TOKEN_BUDGET could never be injected at
 * all, and mindset files that filled the budget on their own would silently
 * crowd out every sector answer — both are index defects, not policy defects.
 *
 * The greedy fill below is a deliberately dumb stand-in for any real policy: if
 * even the naive selector always fits, a smarter one does too.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWLEDGE_DIR = join(REPO_ROOT, 'resources', 'knowledge');
const CLAUDE_CONTRACT = join(REPO_ROOT, 'shared', 'types', 'claude.ts');

/**
 * No corpus ships publicly, so no index.json is generated. These assertions
 * are about a real index's shape; without one they skip rather than fail.
 */
const HAS_INDEX = existsSync(join(KNOWLEDGE_DIR, 'index.json'));

/**
 * Ceiling the bridge puts on the mindset frames so topical material always has
 * room. Mirrors MINDSET_BUDGET_RATIO in app/main/claude/packs.ts; it is a policy
 * number, and the assertions below only use it to show the index is compatible
 * with a cap of roughly this size.
 */
const MINDSET_BUDGET_SHARE = 0.45;

/** Frames the index must fit under that cap for the app to have a voice at all. */
const MIN_FRAMES_UNDER_CAP = 3;

/** @type {import('./lib/types.mjs').KnowledgeIndexLike} */
let index;
/** @type {number} */
let budget;

beforeAll(async () => {
  if (!HAS_INDEX) return;
  index = JSON.parse(await readFile(join(KNOWLEDGE_DIR, 'index.json'), 'utf8'));

  // Read the budget from the contract rather than mirroring it, so this test
  // cannot drift away from shared/types/claude.ts.
  const contract = await readFile(CLAUDE_CONTRACT, 'utf8');
  const match = /PACK_TOKEN_BUDGET\s*=\s*([\d_]+)/.exec(contract);
  budget = Number((match?.[1] ?? '').replace(/_/g, ''));
});

/**
 * Take sections in order while they fit. Skips anything too large rather than
 * truncating it — a half section is worse than none.
 *
 * @param {readonly import('./lib/types.mjs').PackSectionLike[]} candidates
 * @param {number} limit
 * @param {number} spent
 */
function greedyFill(candidates, limit, spent = 0) {
  const chosen = [];
  let used = spent;
  for (const section of candidates) {
    if (used + section.approxTokens > limit) continue;
    chosen.push(section);
    used += section.approxTokens;
  }
  return { chosen, used };
}

/** @param {import('./lib/types.mjs').PackSectionLike} section */
const ofKind = (kind) => index.sections.filter((section) => section.kind === kind);

describe.skipIf(!HAS_INDEX)('budget contract', () => {
  it('reads a positive PACK_TOKEN_BUDGET from shared/types/claude.ts', () => {
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_INDEX)('section sizing', () => {
  it('cuts every section small enough to be injectable on its own', () => {
    const oversized = index.sections.filter((section) => section.approxTokens > budget);
    expect(oversized.map((section) => section.id)).toEqual([]);
  });

  it('keeps every sector section well under the budget so several can combine', () => {
    for (const section of ofKind('sector')) {
      expect(section.approxTokens).toBeLessThan(budget / 2);
    }
  });

  it('would have blown the budget if sector files were indexed whole', () => {
    // Guards the reason section-level indexing exists at all.
    const wholeFileTokens = new Map();
    for (const section of ofKind('sector')) {
      wholeFileTokens.set(
        section.relPath,
        (wholeFileTokens.get(section.relPath) ?? 0) + section.approxTokens,
      );
    }

    expect(wholeFileTokens.size).toBe(39);
    for (const tokens of wholeFileTokens.values()) {
      expect(tokens).toBeGreaterThan(budget / 2);
    }
  });
});

describe.skipIf(!HAS_INDEX)('greedy selection stays under budget', () => {
  it('keeps the whole mindset corpus inside a single invocation budget', () => {
    // All five frames together are ~7.5k of the 12k budget, so a request that
    // wanted nothing but frames could have all of them.
    const total = ofKind('mindset').reduce((sum, section) => sum + section.approxTokens, 0);

    expect(total).toBeLessThan(budget);
  });

  it('fits several frames under the bridge’s mindset cap', () => {
    // Not all five fit under a 45% cap — the largest frame is the one that gets
    // dropped. What must hold is that the app is never left with no frame at all.
    const { chosen } = greedyFill(ofKind('mindset'), Math.floor(budget * MINDSET_BUDGET_SHARE));

    expect(chosen.length).toBeGreaterThanOrEqual(MIN_FRAMES_UNDER_CAP);
  });

  it('leaves room for topical material after the mindset frames', () => {
    const mindsetSpend = greedyFill(
      ofKind('mindset'),
      Math.floor(budget * MINDSET_BUDGET_SHARE),
    ).used;
    const smallestSector = Math.min(...ofKind('sector').map((s) => s.approxTokens));

    expect(budget - mindsetSpend).toBeGreaterThan(smallestSector);
  });

  it('stays under budget for every sector in the corpus', () => {
    const mindset = greedyFill(ofKind('mindset'), Math.floor(budget * MINDSET_BUDGET_SHARE));

    for (const sector of new Set(ofKind('sector').map((section) => section.sector))) {
      const candidates = index.sections.filter((section) => section.sector === sector);
      const { used } = greedyFill(candidates, budget, mindset.used);
      expect(used).toBeLessThanOrEqual(budget);
    }
  });

  it('stays under budget when every section in the corpus is a candidate', () => {
    const { chosen, used } = greedyFill(index.sections, budget);

    expect(used).toBeLessThanOrEqual(budget);
    expect(chosen.length).toBeGreaterThan(1);
  });

  it('selects nothing rather than overshooting when the budget is tiny', () => {
    const { chosen, used } = greedyFill(index.sections, 1);

    expect(chosen).toEqual([]);
    expect(used).toBe(0);
  });
});
