/**
 * Reversing a relationship must work more than once.
 *
 * Reported: after flipping an edge, it could never be flipped again. Replacing
 * an edge mints a NEW id, and the pane's effect handler was hit-testing
 * against the edge list captured in its closure — so every later click
 * resolved to the deleted id and the editor never opened.
 *
 * These tests pin the two halves of that: that hit-testing follows the current
 * edges rather than a stale snapshot, and that a flipped edge is still
 * findable at the same place on screen.
 */

import { describe, expect, it } from 'vitest';

import type { GraphEdge } from '../../../../shared/types/graph';
import { hitTestEdge } from '../hitTest';
import { makeNode } from './fixtures';

const VIEWPORT = { zoom: 1, panX: 0, panY: 0 };

const NODES = [
  makeNode('n1', { x: 100, y: 100, centrality: 0 }),
  makeNode('n2', { x: 400, y: 100, centrality: 0 }),
];
const NODE_BY_ID = new Map(NODES.map((node) => [node.id, node] as const));

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target, relation: 'causes', weight: 1, directed: true };
}

/** Somewhere along the drawn curve between the two nodes. */
function pointOnEdge(edges: readonly GraphEdge[]): { x: number; y: number } {
  for (let y = 80; y <= 140; y += 1) {
    for (let x = 200; x <= 300; x += 5) {
      if (hitTestEdge({ edges, nodeById: NODE_BY_ID, index: null, viewport: VIEWPORT }, { x, y })) {
        return { x, y };
      }
    }
  }
  throw new Error('no point found on the edge');
}

describe('hit-testing an edge', () => {
  it('finds an edge under the cursor', () => {
    const edges = [edge('e1', 'n1', 'n2')];
    const at = pointOnEdge(edges);
    expect(
      hitTestEdge({ edges, nodeById: NODE_BY_ID, index: null, viewport: VIEWPORT }, at),
    ).toBe('e1');
  });

  it('finds the REPLACEMENT edge after a flip, not the deleted one', () => {
    // Exactly the sequence that broke: flipping replaces e1 with e2 (reversed).
    const before = [edge('e1', 'n1', 'n2')];
    const at = pointOnEdge(before);

    const after = [edge('e2', 'n2', 'n1')];
    const found = hitTestEdge(
      { edges: after, nodeById: NODE_BY_ID, index: null, viewport: VIEWPORT },
      at,
    );

    expect(found).toBe('e2');
    expect(found).not.toBe('e1');
  });

  it('stays findable across repeated flips', () => {
    // Four flips, four ids. Every one must remain clickable.
    let edges = [edge('e1', 'n1', 'n2')];
    const at = pointOnEdge(edges);

    for (const [index, next] of [
      edge('e2', 'n2', 'n1'),
      edge('e3', 'n1', 'n2'),
      edge('e4', 'n2', 'n1'),
      edge('e5', 'n1', 'n2'),
    ].entries()) {
      edges = [next];
      const found = hitTestEdge(
        { edges, nodeById: NODE_BY_ID, index: null, viewport: VIEWPORT },
        at,
      );
      expect(found, `flip ${index + 1} produced an unclickable edge`).toBe(next.id);
    }
  });

  it('returns null when the click is nowhere near a line', () => {
    const edges = [edge('e1', 'n1', 'n2')];
    expect(
      hitTestEdge(
        { edges, nodeById: NODE_BY_ID, index: null, viewport: VIEWPORT },
        { x: 250, y: 400 },
      ),
    ).toBeNull();
  });

  it('ignores an edge whose endpoint no longer exists', () => {
    // A node deleted out from under an edge must not crash the hit test.
    const edges = [edge('e1', 'n1', 'missing')];
    expect(
      hitTestEdge(
        { edges, nodeById: NODE_BY_ID, index: null, viewport: VIEWPORT },
        { x: 250, y: 100 },
      ),
    ).toBeNull();
  });
});
