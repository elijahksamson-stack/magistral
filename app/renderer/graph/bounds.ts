/**
 * World-space rectangle helpers, and the graph bounding box the exporter uses.
 *
 * An export is the WHOLE graph, so the box has to include what is actually
 * painted: the node discs and the labels hanging under them, not just the
 * centre points.
 */

import type { GraphNode } from '../../../shared/types/graph';
import { shortGraphName } from '../shared/entityPresentation';
import { EPSILON, LABEL_FONT_SIZE_PX, LABEL_OFFSET_PX } from './constants';
import { estimateLabelWidth } from './labels';
import { worldNodeRadius, type NodeContentSizes } from './nodeStyle';
import { nodePoint, type PositionIndex } from './positionIndex';
import type { Bounds, Point, Size } from './viewport';

export interface GraphBoundsOptions {
  /** Reserve room for the label drawn under each node. */
  readonly includeLabels?: boolean;
  readonly contentSizes?: NodeContentSizes;
}

export function boundsSize(bounds: Bounds): Size {
  return {
    width: Math.max(0, bounds.maxX - bounds.minX),
    height: Math.max(0, bounds.maxY - bounds.minY),
  };
}

export function boundsCenter(bounds: Bounds): Point {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

export function expandBounds(bounds: Bounds, padding: number): Bounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

export function containsPoint(bounds: Bounds, point: Point): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

/** Conservative segment test: the segment's own box against the rect. */
export function segmentIntersectsBounds(a: Point, b: Point, bounds: Bounds): boolean {
  if (Math.max(a.x, b.x) < bounds.minX) return false;
  if (Math.min(a.x, b.x) > bounds.maxX) return false;
  if (Math.max(a.y, b.y) < bounds.minY) return false;
  if (Math.min(a.y, b.y) > bounds.maxY) return false;
  return true;
}

function nodeExtent(
  node: GraphNode,
  index: PositionIndex | null,
  includeLabels: boolean,
  contentChars?: number,
): Bounds {
  const point = nodePoint(index, node);
  const radius = worldNodeRadius(node, contentChars);
  const base: Bounds = {
    minX: point.x - radius,
    minY: point.y - radius,
    maxX: point.x + radius,
    maxY: point.y + radius,
  };
  if (!includeLabels) return base;

  const halfLabel = estimateLabelWidth(shortGraphName(node.label)) / 2;
  return {
    minX: Math.min(base.minX, point.x - halfLabel),
    minY: base.minY,
    maxX: Math.max(base.maxX, point.x + halfLabel),
    maxY: base.maxY + LABEL_OFFSET_PX + LABEL_FONT_SIZE_PX,
  };
}

/** Null when there is nothing to frame — callers must decide what that means. */
export function computeGraphBounds(
  nodes: readonly GraphNode[],
  index: PositionIndex | null = null,
  options: GraphBoundsOptions = {},
): Bounds | null {
  if (nodes.length === 0) return null;
  const includeLabels = options.includeLabels === true;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const extent = nodeExtent(node, index, includeLabels, options.contentSizes?.get(node.id));
    if (!Number.isFinite(extent.minX) || !Number.isFinite(extent.minY)) continue;
    minX = Math.min(minX, extent.minX);
    minY = Math.min(minY, extent.minY);
    maxX = Math.max(maxX, extent.maxX);
    maxY = Math.max(maxY, extent.maxY);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  if (maxX - minX < EPSILON) maxX = minX + EPSILON;
  if (maxY - minY < EPSILON) maxY = minY + EPSILON;
  return { minX, minY, maxX, maxY };
}
