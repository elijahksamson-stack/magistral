/**
 * Binds the flat Float64Array a layout frame returns to node ids.
 *
 * See shared/types/addon.ts: node identity is fetched once via
 * `layout:node-order` and cached; each tick returns only coordinates, aligned
 * to that order. This module is the cache. `withPositions` swaps in a new
 * frame's buffer while reusing the (expensive) id -> slot map, so a frame costs
 * one small object rather than a rebuilt Map.
 */

import type { GraphNode } from '../../../shared/types/graph';
import type { Point } from './viewport';

export interface PositionIndex {
  readonly order: readonly string[];
  readonly indexById: ReadonlyMap<string, number>;
  readonly positions: Float64Array;
  readonly topologyVersion: number;
}

export function createPositionIndex(
  order: readonly string[],
  positions: Float64Array,
  topologyVersion: number,
): PositionIndex {
  const indexById = new Map<string, number>();
  order.forEach((id, slot) => indexById.set(id, slot));
  return { order, indexById, positions, topologyVersion };
}

/** New index over the same topology with a fresh coordinate buffer. */
export function withPositions(index: PositionIndex, positions: Float64Array): PositionIndex {
  return { ...index, positions };
}

/** Overlay display-only coordinates without mutating the live C++ frame. */
export function withPositionOverrides(
  index: PositionIndex | null,
  overrides: ReadonlyMap<string, Point>,
): PositionIndex | null {
  if (!index || overrides.size === 0) return index;
  const positions = index.positions.slice();
  for (const [nodeId, point] of overrides) {
    const slot = index.indexById.get(nodeId);
    if (slot === undefined) continue;
    positions[slot * 2] = point.x;
    positions[slot * 2 + 1] = point.y;
  }
  return { ...index, positions };
}

/** True when a frame's buffer no longer matches the cached order. */
export function isFrameAligned(index: PositionIndex, positions: Float64Array): boolean {
  return positions.length === index.order.length * 2;
}

export function slotOf(index: PositionIndex, nodeId: string): number {
  const slot = index.indexById.get(nodeId);
  return slot === undefined ? -1 : slot;
}

export function getPosition(index: PositionIndex, nodeId: string): Point | null {
  const slot = slotOf(index, nodeId);
  if (slot < 0) return null;
  const x = index.positions[slot * 2];
  const y = index.positions[slot * 2 + 1];
  if (x === undefined || y === undefined) return null;
  return { x, y };
}

/**
 * Live position of a node: the layout frame when we have one, otherwise the
 * coordinates baked into the snapshot. Never null, so callers stay simple.
 */
export function nodePoint(index: PositionIndex | null, node: GraphNode): Point {
  if (!index) return { x: node.x, y: node.y };
  const live = getPosition(index, node.id);
  return live ?? { x: node.x, y: node.y };
}
