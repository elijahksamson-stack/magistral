/**
 * Selection helpers: what dims when you hover, and where an arrow key goes.
 */

import type { GraphEdge, GraphNode } from '../../../shared/types/graph';
import { NAVIGATE_CONE_RADIANS, NAVIGATE_MAX_DISTANCE } from './constants';
import { nodePoint, type PositionIndex } from './positionIndex';
import type { Point } from './viewport';

export type Direction = 'up' | 'down' | 'left' | 'right';

const DIRECTION_VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** The hovered node plus everything one edge away. Null id means no highlight. */
export function computeNeighbourhood(
  edges: readonly GraphEdge[],
  nodeId: string | null,
): ReadonlySet<string> | null {
  if (!nodeId) return null;

  const ids = new Set<string>([nodeId]);
  for (const edge of edges) {
    if (edge.source === nodeId) ids.add(edge.target);
    else if (edge.target === nodeId) ids.add(edge.source);
  }
  return ids;
}

export function mostCentralNodeId(nodes: readonly GraphNode[]): string | null {
  let best: GraphNode | null = null;
  for (const node of nodes) {
    if (!best || node.centrality > best.centrality) best = node;
  }
  return best?.id ?? null;
}

/**
 * Nearest node inside a cone pointing `direction` from the current selection.
 * Falls back to the most central node when nothing is selected yet.
 */
export function nearestNodeInDirection(
  nodes: readonly GraphNode[],
  index: PositionIndex | null,
  fromId: string | null,
  direction: Direction,
): string | null {
  const origin = nodes.find((node) => node.id === fromId);
  if (!origin) return mostCentralNodeId(nodes);

  const from = nodePoint(index, origin);
  const vector = DIRECTION_VECTORS[direction];
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const node of nodes) {
    if (node.id === origin.id) continue;
    const to = nodePoint(index, node);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < Number.EPSILON || distance > NAVIGATE_MAX_DISTANCE) continue;

    const alongAxis = (dx * vector.x + dy * vector.y) / distance;
    if (alongAxis <= 0) continue;
    if (Math.acos(Math.min(1, alongAxis)) > NAVIGATE_CONE_RADIANS) continue;
    if (distance >= bestDistance) continue;

    bestDistance = distance;
    bestId = node.id;
  }

  return bestId;
}
