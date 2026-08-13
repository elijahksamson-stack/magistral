/**
 * Where a group's topology-shaped region goes.
 *
 * The ring is derived from its members rather than stored, so it always
 * encloses exactly what is inside it — a stored radius would drift out of
 * agreement with the layout the moment anything moved.
 */

import type { GraphNode } from '../../../shared/types/graph';
import { GROUP_EXIT_MARGIN_PX, GROUP_MIN_RADIUS_PX, GROUP_PADDING_PX } from './constants';
import { nodePoint, type PositionIndex } from './positionIndex';
import { screenNodeRadius, type NodeContentSizes } from './nodeStyle';

export interface GroupHull {
  readonly groupId: string;
  readonly label: string;
  /** World coordinates of the group node itself. */
  readonly x: number;
  readonly y: number;
  /** World-space radius covering every member plus padding. */
  readonly radius: number;
  readonly memberCount: number;
  /** Convex, padded contour. Optional only for legacy/test callers. */
  readonly points?: readonly { x: number; y: number }[];
}

function cross(
  origin: { x: number; y: number },
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

function convexHull(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 2) return sorted;
  const lower: { x: number; y: number }[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: { x: number; y: number }[] = [];
  for (const point of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function radialContour(
  centre: { x: number; y: number },
  radius: number,
  count = 10,
): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    const variation = index % 2 === 0 ? 1 : 0.92;
    return {
      x: centre.x + Math.cos(angle) * radius * variation,
      y: centre.y + Math.sin(angle) * radius * variation,
    };
  });
}

function paddedContour(
  points: readonly { x: number; y: number }[],
  centre: { x: number; y: number },
  padding: number,
): { x: number; y: number }[] {
  const hull = convexHull(points);
  if (hull.length < 3) {
    const reach = Math.max(
      GROUP_MIN_RADIUS_PX,
      ...points.map((point) => Math.hypot(point.x - centre.x, point.y - centre.y) + padding),
    );
    return radialContour(centre, reach);
  }
  return hull.map((point) => {
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    const distance = Math.max(0.01, Math.hypot(dx, dy));
    return { x: point.x + dx / distance * padding, y: point.y + dy / distance * padding };
  });
}

export function isGroup(node: GraphNode): boolean {
  return node.kind === 'group';
}

/**
 * Centre of the members' bounding box, or null when there are none.
 *
 * The box rather than the mean: one dense cluster and a single outlier would
 * drag a centroid toward the cluster and leave the ring reaching much further
 * than it needs to on the other side. The box centre minimises the reach,
 * which is the whole point of the ring.
 */
function membersCentre(
  members: readonly GraphNode[],
  index: PositionIndex | null,
): { x: number; y: number } | null {
  if (members.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    const at = nodePoint(index, member);
    minX = Math.min(minX, at.x);
    minY = Math.min(minY, at.y);
    maxX = Math.max(maxX, at.x);
    maxY = Math.max(maxY, at.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * One hull per group node.
 *
 * Centred on the members, not on the group node. Centring on the node looked
 * right while a group was being dragged, but the group node is itself in the
 * force simulation: as it drifted away from what it contains, the radius —
 * which has to reach the furthest member — grew without limit, and rings
 * sharing no members swallowed one another. A ring bounding its own members is
 * the only version that stays honest about what is inside it.
 *
 * An empty group has nothing to bound, so it keeps its node's position: it
 * still needs somewhere to drop the first node.
 */
export function computeGroupHulls(
  nodes: readonly GraphNode[],
  index: PositionIndex | null,
  zoom: number,
  contentSizes?: NodeContentSizes,
): GroupHull[] {
  const groups = nodes.filter(isGroup);
  if (groups.length === 0) return [];

  const membersByGroup = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (!node.groupId || isGroup(node)) continue;
    const list = membersByGroup.get(node.groupId) ?? [];
    list.push(node);
    membersByGroup.set(node.groupId, list);
  }

  return groups.map((group) => {
    const members = membersByGroup.get(group.id) ?? [];
    const centre = membersCentre(members, index) ?? nodePoint(index, group);

    let reach = GROUP_MIN_RADIUS_PX;
    for (const member of members) {
      const at = nodePoint(index, member);
      const distance = Math.hypot(at.x - centre.x, at.y - centre.y);
      // Include the member's own disc, or the ring clips through it.
      reach = Math.max(
        reach,
        distance +
          screenNodeRadius(member, zoom, contentSizes?.get(member.id)) / Math.max(zoom, 0.01),
      );
    }

    const memberPoints = members.map((member) => nodePoint(index, member));
    const points = paddedContour(memberPoints, centre, reach === GROUP_MIN_RADIUS_PX
      ? GROUP_MIN_RADIUS_PX
      : GROUP_PADDING_PX);
    const contourRadius = Math.max(...points.map((point) => Math.hypot(point.x - centre.x, point.y - centre.y)));

    return {
      groupId: group.id,
      label: group.label,
      x: centre.x,
      y: centre.y,
      radius: Math.max(reach + GROUP_PADDING_PX, contourRadius),
      memberCount: members.length,
      points,
    };
  });
}

/**
 * The group a node at this world point belongs to, or null for none.
 *
 * Smallest containing ring wins, so dropping into a tight group nested
 * visually inside a sprawling one does what it looks like it does.
 *
 * Asymmetric on purpose. Joining is immediate, but leaving is sticky: pass the
 * node's current group and it keeps that membership until it has been dragged
 * GROUP_EXIT_MARGIN_PX clear of the ring. Membership is something the author
 * asserted deliberately, and a node grazing the boundary while the layout is
 * being tidied is not them taking it back. Moving straight into another group
 * still happens at once — only leaving to nowhere resists.
 */
export function groupAt(
  hulls: readonly GroupHull[],
  world: { x: number; y: number },
  currentGroupId: string | null = null,
): string | null {
  let bestId: string | null = null;
  let bestRadius = Number.POSITIVE_INFINITY;

  for (const hull of hulls) {
    const distance = Math.hypot(world.x - hull.x, world.y - hull.y);
    const inside = hull.points && hull.points.length >= 3
      ? pointInPolygon(world, hull.points)
      : distance <= hull.radius;
    if (!inside) continue;
    if (hull.radius >= bestRadius) continue;
    bestRadius = hull.radius;
    bestId = hull.groupId;
  }
  if (bestId !== null) return bestId;

  if (!currentGroupId) return null;
  const held = hulls.find((hull) => hull.groupId === currentGroupId);
  if (!held) return null;
  const distance = Math.hypot(world.x - held.x, world.y - held.y);
  return distance <= held.radius + GROUP_EXIT_MARGIN_PX ? currentGroupId : null;
}

function pointInPolygon(
  point: { x: number; y: number },
  polygon: readonly { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
