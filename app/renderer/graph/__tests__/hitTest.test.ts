import { describe, expect, test } from 'vitest';
import { MIN_NODE_RADIUS, NODE_HIT_SLOP_PX } from '../constants';
import { hitTestNode, type HitTestScene } from '../hitTest';
import { createPositionIndex } from '../positionIndex';
import { makeNode } from './fixtures';

/** centrality 0 pins the world radius to MIN_NODE_RADIUS, so reach is exact. */
const SMALL = { centrality: 0 };

describe('hitTestNode', () => {
  test('accounts for pan and zoom', () => {
    // Arrange: node at world (100, 50) drawn at screen (230, 90).
    const scene: HitTestScene = {
      nodes: [makeNode('a', { ...SMALL, x: 100, y: 50 })],
      index: null,
      viewport: { zoom: 2, panX: 30, panY: -10 },
    };
    const reach = MIN_NODE_RADIUS * 2 + NODE_HIT_SLOP_PX; // 13

    // Act / Assert
    expect(hitTestNode(scene, { x: 230, y: 90 })).toBe('a');
    expect(hitTestNode(scene, { x: 230 + reach - 1, y: 90 })).toBe('a');
    expect(hitTestNode(scene, { x: 230 + reach + 2, y: 90 })).toBeNull();
    // The un-transformed world coordinate must NOT be a hit.
    expect(hitTestNode(scene, { x: 100, y: 50 })).toBeNull();
  });

  test('shrinks the target as you zoom out', () => {
    const scene: HitTestScene = {
      nodes: [makeNode('a', { ...SMALL, x: 100, y: 50 })],
      index: null,
      viewport: { zoom: 0.5, panX: 0, panY: 0 },
    };

    expect(hitTestNode(scene, { x: 50, y: 25 })).toBe('a');
    expect(hitTestNode(scene, { x: 62, y: 25 })).toBeNull();
  });

  test('returns the closest node when discs overlap', () => {
    const scene: HitTestScene = {
      nodes: [
        makeNode('left', { ...SMALL, x: 100, y: 50 }),
        makeNode('right', { ...SMALL, x: 110, y: 50 }),
      ],
      index: null,
      viewport: { zoom: 1, panX: 0, panY: 0 },
    };

    expect(hitTestNode(scene, { x: 108, y: 50 })).toBe('right');
    expect(hitTestNode(scene, { x: 101, y: 50 })).toBe('left');
  });

  test('prefers live layout positions over the snapshot coordinates', () => {
    const node = makeNode('a', { ...SMALL, x: 0, y: 0 });
    const index = createPositionIndex(['a'], Float64Array.from([300, 100]), 7);
    const scene: HitTestScene = {
      nodes: [node],
      index,
      viewport: { zoom: 1, panX: 0, panY: 0 },
    };

    expect(hitTestNode(scene, { x: 300, y: 100 })).toBe('a');
    expect(hitTestNode(scene, { x: 0, y: 0 })).toBeNull();
  });

  test('misses cleanly on an empty graph', () => {
    const scene: HitTestScene = {
      nodes: [],
      index: null,
      viewport: { zoom: 1, panX: 0, panY: 0 },
    };

    expect(hitTestNode(scene, { x: 0, y: 0 })).toBeNull();
  });

  test('uses the same content-scaled radius as the renderer', () => {
    const node = makeNode('rich', { x: 0, y: 0 });
    const scene: HitTestScene = {
      nodes: [node],
      index: null,
      viewport: { zoom: 1, panX: 0, panY: 0 },
      contentSizes: new Map([['rich', 3_000]]),
    };

    expect(hitTestNode(scene, { x: 10, y: 0 }, 0)).toBe('rich');
    expect(hitTestNode({ ...scene, contentSizes: new Map() }, { x: 10, y: 0 }, 0)).toBeNull();
  });
});
