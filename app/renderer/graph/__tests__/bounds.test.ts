import { describe, expect, test } from 'vitest';
import {
  boundsCenter,
  boundsSize,
  computeGraphBounds,
  containsPoint,
  expandBounds,
  segmentIntersectsBounds,
} from '../bounds';
import { LABEL_FONT_SIZE_PX, LABEL_OFFSET_PX, MIN_NODE_RADIUS } from '../constants';
import { createPositionIndex } from '../positionIndex';
import { makeNode } from './fixtures';

const SMALL = { centrality: 0 };

describe('computeGraphBounds', () => {
  test('returns null when there is nothing to frame', () => {
    expect(computeGraphBounds([])).toBeNull();
  });

  test('includes each node disc, not just its centre', () => {
    const bounds = computeGraphBounds([
      makeNode('a', { ...SMALL, x: 0, y: 0 }),
      makeNode('b', { ...SMALL, x: 100, y: 60 }),
    ]);

    expect(bounds).toEqual({
      minX: -MIN_NODE_RADIUS,
      minY: -MIN_NODE_RADIUS,
      maxX: 100 + MIN_NODE_RADIUS,
      maxY: 60 + MIN_NODE_RADIUS,
    });
  });

  test('reserves room under the node for its label when asked', () => {
    const nodes = [makeNode('a', { ...SMALL, x: 0, y: 0, label: 'a long enough label' })];

    const plain = computeGraphBounds(nodes);
    const labelled = computeGraphBounds(nodes, null, { includeLabels: true });

    expect(plain).not.toBeNull();
    expect(labelled).not.toBeNull();
    expect(labelled?.maxY).toBeCloseTo(
      (plain?.maxY ?? 0) + LABEL_OFFSET_PX + LABEL_FONT_SIZE_PX,
      8,
    );
    expect(labelled?.maxX).toBeGreaterThan(plain?.maxX ?? 0);
    expect(labelled?.minX).toBeLessThan(plain?.minX ?? 0);
    // A label hangs below the node, so the top edge must not move.
    expect(labelled?.minY).toBeCloseTo(plain?.minY ?? 0, 8);
  });

  test('frames the live layout positions rather than the stale snapshot ones', () => {
    const nodes = [makeNode('a', { ...SMALL, x: 0, y: 0 }), makeNode('b', { ...SMALL, x: 1, y: 1 })];
    const index = createPositionIndex(['a', 'b'], Float64Array.from([-500, -500, 500, 500]), 3);

    const bounds = computeGraphBounds(nodes, index);

    expect(bounds?.minX).toBe(-500 - MIN_NODE_RADIUS);
    expect(bounds?.maxX).toBe(500 + MIN_NODE_RADIUS);
  });

  test('never returns a zero-area box', () => {
    const bounds = computeGraphBounds([makeNode('only', { x: 42, y: 42 })]);
    const size = boundsSize(bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 });

    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    expect(boundsCenter(bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 })).toEqual({
      x: 42,
      y: 42,
    });
  });
});

describe('rectangle helpers', () => {
  test('expandBounds grows every edge and does not mutate the input', () => {
    const original = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const grown = expandBounds(original, 5);

    expect(grown).toEqual({ minX: -5, minY: -5, maxX: 15, maxY: 15 });
    expect(original).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  test('containsPoint is inclusive on the edge', () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

    expect(containsPoint(bounds, { x: 0, y: 10 })).toBe(true);
    expect(containsPoint(bounds, { x: 5, y: 5 })).toBe(true);
    expect(containsPoint(bounds, { x: 10.1, y: 5 })).toBe(false);
    expect(containsPoint(bounds, { x: 5, y: -0.1 })).toBe(false);
  });

  test('segmentIntersectsBounds rejects segments that are entirely outside', () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

    expect(segmentIntersectsBounds({ x: -5, y: 5 }, { x: 15, y: 5 }, bounds)).toBe(true);
    expect(segmentIntersectsBounds({ x: 2, y: 2 }, { x: 3, y: 3 }, bounds)).toBe(true);
    expect(segmentIntersectsBounds({ x: 11, y: 0 }, { x: 20, y: 20 }, bounds)).toBe(false);
    expect(segmentIntersectsBounds({ x: -20, y: -20 }, { x: -1, y: 40 }, bounds)).toBe(false);
  });
});
