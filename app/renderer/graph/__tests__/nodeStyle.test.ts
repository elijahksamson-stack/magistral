import { describe, expect, test } from 'vitest';
import type { Cell } from '../../../../shared/types/graph';
import { MAX_NODE_RADIUS, MAX_SCREEN_NODE_RADIUS, MIN_NODE_RADIUS } from '../constants';
import { buildNodeContentSizes, screenNodeRadius, worldNodeRadius } from '../nodeStyle';
import { makeNode } from './fixtures';

const AT = '2026-08-08T00:00:00.000Z';

function cell(id: string, markdown: string): Cell {
  return { id, order: 0, markdown, createdAt: AT, updatedAt: AT };
}

describe('content-scaled node radii', () => {
  test('measures the authored cells housed by each node', () => {
    const nodes = [
      makeNode('short', { cellIds: ['c-short'] }),
      makeNode('long', { cellIds: ['c-long'] }),
    ];
    const sizes = buildNodeContentSizes(nodes, [
      cell('c-short', '[[Short]] one sentence.'),
      cell('c-long', `[[Long]] ${'substantial analysis '.repeat(80)}`),
    ]);

    expect(sizes.get('long')).toBeGreaterThan(sizes.get('short') ?? 0);
    expect(worldNodeRadius(nodes[1]!, sizes.get('long'))).toBeGreaterThan(
      worldNodeRadius(nodes[0]!, sizes.get('short')),
    );
  });

  test('uses node notes as a fallback when no cell is attached', () => {
    const empty = makeNode('empty', { centrality: 1 });
    const described = makeNode('described', { centrality: 0, note: 'A useful explanation. '.repeat(20) });

    expect(worldNodeRadius(empty)).toBe(MIN_NODE_RADIUS);
    expect(worldNodeRadius(described)).toBeGreaterThan(worldNodeRadius(empty));
  });

  test('compresses very long content into modest hard caps', () => {
    const node = makeNode('document');

    expect(worldNodeRadius(node, 1_000_000)).toBeCloseTo(MAX_NODE_RADIUS);
    expect(screenNodeRadius(node, 100, 1_000_000)).toBe(MAX_SCREEN_NODE_RADIUS);
    expect(MAX_NODE_RADIUS).toBeLessThanOrEqual(12);
    expect(MAX_SCREEN_NODE_RADIUS).toBeLessThanOrEqual(30);
  });
});
