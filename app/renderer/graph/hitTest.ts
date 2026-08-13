/**
 * What is under the cursor. Runs in screen space using the same radius
 * function the renderer draws with, so the clickable disc is exactly the disc
 * you can see at the current pan and zoom.
 */

import type { GraphEdge, GraphNode } from '../../../shared/types/graph';
import { EDGE_BOW_RATIO, EDGE_HIT_SAMPLES, EDGE_HIT_SLOP_PX, NODE_HIT_SLOP_PX } from './constants';
import { screenNodeRadius, type NodeContentSizes } from './nodeStyle';
import { nodePoint, type PositionIndex } from './positionIndex';
import { worldToScreen, type Point, type Viewport } from './viewport';

export interface HitTestScene {
  readonly nodes: readonly GraphNode[];
  readonly index: PositionIndex | null;
  readonly viewport: Viewport;
  readonly contentSizes?: NodeContentSizes;
}

/**
 * Closest node whose disc (plus slop) contains the point, or null. Ties go to
 * the node drawn last, which is the one visually on top.
 */
export function hitTestNode(
  scene: HitTestScene,
  screenPoint: Point,
  slop: number = NODE_HIT_SLOP_PX,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const node of scene.nodes) {
    const world = nodePoint(scene.index, node);
    const at = worldToScreen(scene.viewport, world.x, world.y);
    const distance = Math.hypot(at.x - screenPoint.x, at.y - screenPoint.y);
    const reach =
      screenNodeRadius(node, scene.viewport.zoom, scene.contentSizes?.get(node.id)) + slop;
    if (distance > reach) continue;
    if (distance > bestDistance) continue;
    bestDistance = distance;
    bestId = node.id;
  }

  return bestId;
}

/**
 * Closest edge within `slop` pixels of the point, or null.
 *
 * Edges are drawn as quadratic curves, so the curve is sampled and each
 * segment measured — matching the bow the renderer actually draws rather than
 * the straight chord between endpoints, which can sit a long way off it.
 *
 * Nodes are hit-tested first by the caller: an edge passing under a node must
 * never win over the node itself.
 */
export function hitTestEdge(
  scene: EdgeHitScene,
  screenPoint: Point,
  slop: number = EDGE_HIT_SLOP_PX,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const edge of scene.edges) {
    const source = scene.nodeById.get(edge.source);
    const target = scene.nodeById.get(edge.target);
    if (!source || !target) continue;

    const a = worldToScreen(scene.viewport, ...pointOf(scene, source));
    const b = worldToScreen(scene.viewport, ...pointOf(scene, target));
    // Same stable ordering the renderer uses, so the hit area follows the
    // curve actually drawn rather than a mirror image of it.
    const control =
      edge.source <= edge.target
        ? quadraticControlPoint(a, b)
        : quadraticControlPoint(b, a);

    let previous = a;
    for (let step = 1; step <= EDGE_HIT_SAMPLES; step += 1) {
      const t = step / EDGE_HIT_SAMPLES;
      const current = quadraticAt(a, control, b, t);
      const distance = distanceToSegment(screenPoint, previous, current);
      if (distance <= slop && distance < bestDistance) {
        bestDistance = distance;
        bestId = edge.id;
      }
      previous = current;
    }
  }
  return bestId;
}

export interface EdgeHitScene {
  readonly edges: readonly GraphEdge[];
  readonly nodeById: ReadonlyMap<string, GraphNode>;
  readonly index: PositionIndex | null;
  readonly viewport: Viewport;
}

function pointOf(scene: EdgeHitScene, node: GraphNode): [number, number] {
  const world = nodePoint(scene.index, node);
  return [world.x, world.y];
}

/** Same bow the renderer uses, so the hit area follows the drawn curve. */
function quadraticControlPoint(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  if (length < 1e-6) return { x: midX, y: midY };

  const offset = length * EDGE_BOW_RATIO;
  return { x: midX - (dy / length) * offset, y: midY + (dx / length) * offset };
}

function quadraticAt(a: Point, control: Point, b: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * a.x + 2 * inverse * t * control.x + t * t * b.x,
    y: inverse * inverse * a.y + 2 * inverse * t * control.y + t * t * b.y,
  };
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
