/**
 * End-to-end check of a ✦ cell action against the REAL local CLI.
 *
 * The chat pane and the cell actions share a bridge but not a code path — chat
 * takes the `kind: 'chat'` branch, cells take `kind: 'cell'` with a per-action
 * system prompt. Chat working therefore proves nothing about the ✦ button, and
 * a reported "the editor does nothing" needs the cell path exercised for real.
 *
 * Skipped unless BRAINDUMP_E2E=1, because it spends subscription tokens.
 * Run with:  BRAINDUMP_E2E=1 npx vitest run app/main/claude/cell-action
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ClaudeBridge } from './bridge';
import type { ClaudeStreamEvent, CellAction } from '../../../shared/types/claude';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const KNOWLEDGE_DIR = path.join(REPO_ROOT, 'resources/knowledge');

const isEnabled = process.env.BRAINDUMP_E2E === '1';
const describeE2E = isEnabled ? describe : describe.skip;

function resolveClaudeBinary(): string {
  return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
}

/** Run one cell action to completion and return everything the bridge emitted. */
async function runCellAction(
  action: CellAction,
  cellMarkdown: string,
  sourceDocument?: { name: string; text: string; isTruncated: boolean },
): Promise<ClaudeStreamEvent[]> {
  const events: ClaudeStreamEvent[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const bridge = new ClaudeBridge(
      {
        binaryPath: resolveClaudeBinary(),
        model: 'sonnet',
        timeoutMs: 180_000,
        knowledgeDir: KNOWLEDGE_DIR,
        vaultDir: REPO_ROOT,
      },
      (event: ClaudeStreamEvent) => {
        events.push(event);
        if (event.type === 'done' || event.type === 'error') resolve();
      },
    );

    void bridge
      .invoke({
        requestId: `it-${action}`,
        kind: 'cell',
        action,
        cellId: 'c1',
        cellMarkdown,
        ...(sourceDocument ? { sourceDocument } : {}),
      })
      .catch(reject);
  });

  await done;
  return events;
}

describeE2E('a ✦ cell action, against the real CLI', () => {
  it(
    'streams prose back for Continue',
    async () => {
      const events = await runCellAction(
        'continue',
        'The binding constraint in semiconductors is EUV lithography.',
      );

      const failure = events.find((event) => event.type === 'error');
      expect(failure, `bridge reported: ${JSON.stringify(failure)}`).toBeUndefined();

      const finished = events.find((event) => event.type === 'done');
      expect(finished).toBeDefined();
      if (finished?.type !== 'done') throw new Error('unreachable');

      expect(finished.fullText.trim().length).toBeGreaterThan(0);
      expect(finished.sessionId).toBeTruthy();
      // Deltas are what make text appear as it arrives rather than in one jump.
      expect(events.some((event) => event.type === 'delta')).toBe(true);
      // Mindset packs ride along on every invocation.
      expect(events.some((event) => event.type === 'packs')).toBe(true);
    },
    240_000,
  );

  it(
    'distils an imported document into wikilinked takeaways',
    async () => {
      const events = await runCellAction('distill-import', '', {
        name: 'euv-memo.txt',
        isTruncated: false,
        text: [
          'Q3 Semiconductor Capacity Memo',
          '',
          'ASML is the sole supplier of EUV lithography scanners. No competitor',
          'has produced a working alternative, and none is expected before 2030.',
          'Each scanner costs roughly $200m and takes about a year to install.',
          '',
          'Because advanced logic below 5nm cannot be manufactured without EUV,',
          'ASML shipment volume sets a hard ceiling on global leading-edge',
          'capacity. Foundry capex plans that assume otherwise are unfunded.',
          '',
          'We estimate 2027 capacity is already committed. This is an estimate,',
          'not a disclosed figure.',
        ].join('\n'),
      });

      const failure = events.find((event) => event.type === 'error');
      expect(failure, `bridge reported: ${JSON.stringify(failure)}`).toBeUndefined();

      const finished = events.find((event) => event.type === 'done');
      if (finished?.type !== 'done') throw new Error('no done event');

      const text = finished.fullText;
      // The whole point: concepts arrive pre-wrapped, so accepting the cell
      // populates the graph without the author bracketing anything by hand.
      const links = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
      expect(links.length).toBeGreaterThanOrEqual(4);

      // Labels must be concept-shaped, not sentences.
      for (const link of links) {
        expect(link!.length).toBeLessThan(60);
      }

      expect(text.toLowerCase()).toMatch(/takeaway/);
      // eslint-disable-next-line no-console
      console.log('\n--- distilled ---\n' + text + '\n--- end ---\n');
    },
    240_000,
  );
});
