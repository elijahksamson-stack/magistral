import { describe, expect, test } from 'vitest';
import {
  createPositionIndex,
  getPosition,
  isFrameAligned,
  nodePoint,
  slotOf,
  withPositions,
} from '../positionIndex';
import { makeNode } from './fixtures';

const ORDER = ['a', 'b', 'c'];
const FRAME = Float64Array.from([0, 0, 10, 20, -5, -6]);

describe('positionIndex', () => {
  test('maps ids to slots in the coordinate buffer', () => {
    const index = createPositionIndex(ORDER, FRAME, 1);

    expect(slotOf(index, 'b')).toBe(1);
    expect(slotOf(index, 'missing')).toBe(-1);
    expect(getPosition(index, 'b')).toEqual({ x: 10, y: 20 });
    expect(getPosition(index, 'c')).toEqual({ x: -5, y: -6 });
    expect(getPosition(index, 'missing')).toBeNull();
  });

  test('a new frame reuses the id map instead of rebuilding it', () => {
    // This is the whole point of the nodeOrder cache: a frame must cost a
    // buffer swap, not N id strings across the IPC boundary.
    const index = createPositionIndex(ORDER, FRAME, 1);
    const next = withPositions(index, Float64Array.from([1, 1, 2, 2, 3, 3]));

    expect(next).not.toBe(index);
    expect(next.indexById).toBe(index.indexById);
    expect(next.order).toBe(index.order);
    expect(next.topologyVersion).toBe(1);
    expect(getPosition(next, 'a')).toEqual({ x: 1, y: 1 });
    // The previous frame is untouched.
    expect(getPosition(index, 'a')).toEqual({ x: 0, y: 0 });
  });

  test('detects a frame that no longer matches the cached order', () => {
    const index = createPositionIndex(ORDER, FRAME, 1);

    expect(isFrameAligned(index, Float64Array.from([1, 1, 2, 2, 3, 3]))).toBe(true);
    expect(isFrameAligned(index, Float64Array.from([1, 1, 2, 2]))).toBe(false);
  });

  test('falls back to snapshot coordinates when the layout has no opinion', () => {
    const node = makeNode('ghost', { x: 7, y: 9 });
    const index = createPositionIndex(ORDER, FRAME, 1);

    expect(nodePoint(null, node)).toEqual({ x: 7, y: 9 });
    expect(nodePoint(index, node)).toEqual({ x: 7, y: 9 });
    expect(nodePoint(index, makeNode('a', { x: 99, y: 99 }))).toEqual({ x: 0, y: 0 });
  });

  test('a truncated buffer yields null rather than NaN coordinates', () => {
    const index = createPositionIndex(ORDER, Float64Array.from([0, 0]), 1);

    expect(getPosition(index, 'c')).toBeNull();
  });
});
