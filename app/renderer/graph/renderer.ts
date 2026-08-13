/**
 * The Canvas 2D graph renderer. No WebGL, no graph library — we own every
 * pixel, which keeps the dependency surface at zero and makes the JPG export
 * literally these same draw calls at a different scale.
 *
 * Two properties are load-bearing:
 *  - devicePixelRatio is applied once via setTransform, so everything below is
 *    plain CSS pixels and nothing is blurry on a Retina panel;
 *  - nothing outside the viewport is drawn, so a large graph costs what is on
 *    screen rather than what exists.
 */

import type { GraphEdge, GraphNode } from '../../../shared/types/graph';
import type { EntityPresentation } from '../shared/entityPresentation';
import { containsPoint, expandBounds, segmentIntersectsBounds } from './bounds';
import type { ExpansionLink } from './expansion';
import {
  ARROWHEAD_GAP_PX,
  ARROWHEAD_HALF_ANGLE,
  ARROWHEAD_LENGTH_PX,
  CONNECT_DRAFT_COLOR,
  CONNECT_DRAFT_DASH,
  CONNECT_DRAFT_WIDTH,
  CONNECT_TARGET_COLOR,
  CONNECT_TARGET_RING_GAP,
  CONNECT_TARGET_RING_WIDTH,
  CANVAS_GRID_MAJOR_COLOR,
  CANVAS_GRID_MAJOR_EVERY,
  CANVAS_GRID_MINOR_COLOR,
  CANVAS_GRID_MIN_SPACING_PX,
  CANVAS_GRID_SIZE_PX,
  CULL_MARGIN_PX,
  DISCOVERY_COLOR,
  DISCOVERY_DOT_RADIUS_PX,
  DISCOVERY_ENDPOINT_RADIUS_PX,
  DISCOVERY_TRAIL,
  FLOW_COLOR,
  FLOW_DOT_RADIUS_PX,
  FLOW_PEAK_ALPHA,
  GREYED_NODE_COLOR,
  GROUP_ACTIVE_FILL,
  GROUP_ACTIVE_STROKE,
  GROUP_DASH,
  GROUP_FILL,
  GROUP_LABEL_COLOR,
  GROUP_LABEL_FONT,
  GROUP_STROKE,
  GROUP_STROKE_WIDTH,
  RECALL_COLOR,
  RECALL_GLOW_COLOR,
  RECALL_HALO_PX,
  RECALL_RING_WIDTH,
  DIMMED_ALPHA,
  EDGE_ALPHA,
  EDGE_BOW_RATIO,
  EDGE_COLOR,
  EDGE_HIGHLIGHT_ALPHA,
  EDGE_HIGHLIGHT_COLOR,
  EDGE_WEIGHT_CEILING,
  EPSILON,
  LABEL_ACTIVE_COLOR,
  LABEL_COLOR,
  LABEL_FONT,
  LABEL_FONT_SIZE_PX,
  LABEL_OFFSET_PX,
  MAX_EDGE_WIDTH,
  MIN_EDGE_WIDTH,
  NODE_STROKE_COLOR,
  NODE_STROKE_WIDTH,
  NODE_CORE_COLOR,
  NODE_CATEGORY_RING_WIDTH,
  HOVER_HALO_COLOR,
  HOVER_RING_COLOR,
  HOVER_RING_GAP,
  HOVER_RING_WIDTH,
  PINNED_RING_COLOR,
  PINNED_RING_WIDTH,
  SELECTED_RING_COLOR,
  SELECTED_RING_GAP,
  SELECTED_RING_WIDTH,
  SUBNODE_LINK_COLOR,
  SUBNODE_LINK_DASH,
  SUBNODE_LINK_WIDTH,
  SUBNODE_RING_COLOR,
  SUBNODE_RING_GAP,
  SUBNODE_RING_WIDTH,
} from './constants';
import {
  earnsLabel,
  labelBoxAt,
  labelTier,
  selectVisibleLabels,
  type LabelCandidate,
} from './labels';
import { flowOffsets } from './flow';
import type { GroupHull } from './groups';
import { nodeCategoryColor, screenNodeRadius, type NodeContentSizes } from './nodeStyle';
import { nodePoint, type PositionIndex } from './positionIndex';
import type { RenderContext2D } from './renderContext';
import { visibleWorldBounds, worldToScreen, type Bounds, type Point, type Viewport } from './viewport';

const TAU = Math.PI * 2;

export interface RenderScene {
  readonly nodes: readonly GraphNode[];
  /** Edge endpoint lookup. Memoised by the caller; never rebuilt per frame. */
  readonly nodeById: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly index: PositionIndex | null;
  readonly viewport: Viewport;
  /** Logical canvas size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** devicePixelRatio on screen; the scale factor when exporting. */
  readonly dpr: number;
  readonly background: string;
  readonly selectedNodeId: string | null;
  readonly hoveredNodeId: string | null;
  /** Hovered node plus its neighbours. Everything else dims. Null = no hover. */
  readonly highlightIds: ReadonlySet<string> | null;
  /** Exports label everything regardless of the zoom threshold. */
  readonly forceLabels: boolean;
  /** An edge being drawn right now, or null. Never present in an export. */
  readonly connectDraft: ConnectDraft | null;
  /** Authored character count per node, used by the compressed radius scale. */
  readonly contentSizes?: NodeContentSizes;
  /**
   * Pulse strength per node, 0..1, for concepts a chat answer just recalled.
   * Absent outside the chat pane.
   */
  readonly recall?: ReadonlyMap<string, number> | null;
  /**
   * Travel progress, 0..1, per relationship that has just landed. Like
   * `recall`, the caller resolves the timing so this module stays free of time.
   */
  readonly discovery?: ReadonlyMap<string, number> | null;
  /**
   * Position within the flow cycle, 0..1, or null when flow is stopped. Like
   * `recall`, the caller owns the clock so this module stays free of time.
   */
  readonly flowPhase?: number | null;
  /** Topology-aware regions for group nodes, drawn behind everything. */
  readonly groupHulls?: readonly GroupHull[];
  /** Group a dragged node is currently over and would join on release. */
  readonly activeGroupId?: string | null;
  /**
   * Nodes in the current expansion: an expanded concept plus the sub-concepts
   * it names. Everything else renders greyscale but KEEPS its label. Null when
   * nothing is expanded, which is the ordinary full-colour map.
   */
  readonly exposedIds?: ReadonlySet<string> | null;
  /** View-only facets, so they can be distinguished from persisted nodes. */
  readonly subNodeIds?: ReadonlySet<string> | null;
  /** Visual parent-to-facet ties. They are deliberately not editable edges. */
  readonly expansionLinks?: readonly ExpansionLink[];
  /** Shared identity projection used by Editor, Graph and Chat. */
  readonly presentations?: ReadonlyMap<string, EntityPresentation>;
}

/** The in-flight state of a drag-to-connect gesture. */
export interface ConnectDraft {
  readonly sourceId: string;
  /** Loose end, in screen pixels. */
  readonly to: Point;
  /** Node the edge would land on, or null over blank space. */
  readonly targetId: string | null;
}

export interface RenderStats {
  readonly nodesDrawn: number;
  readonly edgesDrawn: number;
  readonly labelsDrawn: number;
}

function isActive(scene: RenderScene, nodeId: string): boolean {
  return scene.selectedNodeId === nodeId || scene.hoveredNodeId === nodeId;
}

function nodeAlpha(scene: RenderScene, nodeId: string): number {
  // Expansion uses greyscale, not transparency: every context title remains
  // readable while the two exposed neighbourhoods carry the colour signal.
  if (scene.exposedIds) return 1;
  if (!scene.highlightIds) return 1;
  return scene.highlightIds.has(nodeId) ? 1 : DIMMED_ALPHA;
}

function pointOf(scene: RenderScene, nodeId: string): Point | null {
  const node = scene.nodeById.get(nodeId);
  if (!node) return null;
  return nodePoint(scene.index, node);
}

function edgeWidth(edge: GraphEdge): number {
  const span = Math.max(1, EDGE_WEIGHT_CEILING - 1);
  const weight = Math.min(1, Math.max(0, (edge.weight - 1) / span));
  return MIN_EDGE_WIDTH + (MAX_EDGE_WIDTH - MIN_EDGE_WIDTH) * weight;
}

/**
 * Draw an arrowhead at `tip`, aimed along the direction from `from` to `tip`.
 *
 * `backOff` pulls the head off the node rim so it points at the node rather
 * than disappearing underneath it.
 */
function drawArrowhead(
  ctx: RenderContext2D,
  from: Point,
  tip: Point,
  backOff: number,
): void {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return;

  const ux = dx / length;
  const uy = dy / length;
  const baseX = tip.x - ux * backOff;
  const baseY = tip.y - uy * backOff;
  const angle = Math.atan2(uy, ux);

  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  for (const sign of [-1, 1]) {
    const theta = angle + Math.PI + sign * ARROWHEAD_HALF_ANGLE;
    ctx.lineTo(baseX + Math.cos(theta) * ARROWHEAD_LENGTH_PX, baseY + Math.sin(theta) * ARROWHEAD_LENGTH_PX);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Control point for the bow, computed from a STABLE ordering of the endpoints.
 *
 * The bow is a perpendicular offset from the chord, so deriving it from the
 * drawing direction mirrors the curve when an edge is reversed: the line jumps
 * to the other side of the straight path between the same two nodes. It looks
 * like the edge moved, and a click where it used to be misses it entirely.
 *
 * Ordering by node id makes the curve a property of the PAIR, so reversing
 * changes only the arrowhead — which is the only thing that actually changed.
 */
function stableBowControl(a: Point, b: Point, aId: string, bId: string): Point {
  return aId <= bId ? bowControlPoint(a, b) : bowControlPoint(b, a);
}

/** Control point for the slight bow that keeps parallel edges readable. */
function bowControlPoint(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  if (length < EPSILON) return { x: midX, y: midY };

  const offset = length * EDGE_BOW_RATIO;
  return { x: midX - (dy / length) * offset, y: midY + (dx / length) * offset };
}

/**
 * The contours that enclose grouped nodes.
 *
 * Drawn FIRST so everything else sits on top: a group is a backdrop the author
 * arranges nodes onto, not another thing competing for the foreground.
 */
function drawGroupContour(
  ctx: RenderContext2D,
  scene: RenderScene,
  hull: GroupHull,
): readonly Point[] {
  const points = hull.points?.map((point) => worldToScreen(scene.viewport, point.x, point.y));
  if (!points || points.length < 3) {
    const centre = worldToScreen(scene.viewport, hull.x, hull.y);
    ctx.arc(centre.x, centre.y, hull.radius * scene.viewport.zoom, 0, TAU);
    return [centre];
  }

  const last = points.at(-1)!;
  const first = points[0]!;
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  ctx.closePath();
  return points;
}

function drawGroupHulls(ctx: RenderContext2D, scene: RenderScene): void {
  const hulls = scene.groupHulls;
  if (!hulls || hulls.length === 0) return;

  ctx.save();
  for (const hull of hulls) {
    const isActive = scene.activeGroupId === hull.groupId;
    const selected = scene.selectedNodeId ? scene.nodeById.get(scene.selectedNodeId) : undefined;
    const selectionBelongsHere = selected?.id === hull.groupId || selected?.groupId === hull.groupId;
    ctx.globalAlpha = scene.selectedNodeId && !selectionBelongsHere ? 0.34 : 1;

    ctx.beginPath();
    const contour = drawGroupContour(ctx, scene, hull);
    ctx.fillStyle = isActive ? GROUP_ACTIVE_FILL : GROUP_FILL;
    ctx.fill();

    ctx.setLineDash(isActive ? [] : [...GROUP_DASH]);
    ctx.strokeStyle = isActive ? GROUP_ACTIVE_STROKE : GROUP_STROKE;
    ctx.lineWidth = GROUP_STROKE_WIDTH;
    ctx.stroke();
    ctx.setLineDash([]);

    // Label rides on the ring itself rather than at the centre, where it would
    // collide with whatever members happen to sit there.
    ctx.font = GROUP_LABEL_FONT;
    ctx.fillStyle = GROUP_LABEL_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const top = contour.reduce(
      (best, point) => point.y < best.y ? point : best,
      contour[0] ?? worldToScreen(scene.viewport, hull.x, hull.y),
    );
    ctx.fillText(hull.label, top.x, top.y - 7);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Point on the same quadratic the edge itself is stroked along. */
function quadraticPointAt(from: Point, control: Point, to: Point, t: number): Point {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

/**
 * A relationship arriving: short lime dash → travelling head → endpoint.
 *
 * The trail is drawn as a run of points along the curve rather than a straight
 * segment, so on a bowed edge the dash lies ON the relationship instead of
 * cutting the corner off it.
 */
function drawDiscoveryPulse(
  ctx: RenderContext2D,
  from: Point,
  control: Point,
  to: Point,
  progress: number,
): void {
  const head = Math.min(1, Math.max(0, progress));
  const tail = Math.max(0, head - DISCOVERY_TRAIL);

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = DISCOVERY_COLOR;
  ctx.fillStyle = DISCOVERY_COLOR;
  ctx.lineWidth = 2;

  if (head > tail) {
    ctx.beginPath();
    const steps = 6;
    for (let step = 0; step <= steps; step += 1) {
      const at = quadraticPointAt(from, control, to, tail + ((head - tail) * step) / steps);
      if (step === 0) ctx.moveTo(at.x, at.y);
      else ctx.lineTo(at.x, at.y);
    }
    ctx.stroke();
  }

  // Arrived: resolve into the endpoint. Still travelling: keep the head moving.
  const point = quadraticPointAt(from, control, to, head);
  const radius = head >= 1 ? DISCOVERY_ENDPOINT_RADIUS_PX : DISCOVERY_DOT_RADIUS_PX;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * Travellers running source → target, showing which way a relationship points.
 *
 * Cyan, because this is the graph's own structure being read rather than
 * Magistral acting — the lime endpoint pulse means something happened, and the
 * two must not be confused while both can be on screen at once.
 *
 * Each traveller fades in at the source and out at the target, so the map reads
 * as movement along the edges rather than as beads sliding between fixed stops.
 */
function drawFlow(
  ctx: RenderContext2D,
  from: Point,
  control: Point,
  to: Point,
  phase: number,
  isHot: boolean,
): void {
  ctx.save();
  ctx.fillStyle = isHot ? EDGE_HIGHLIGHT_COLOR : FLOW_COLOR;
  for (const offset of flowOffsets(phase)) {
    // Brightest mid-edge: a dot at either end would sit under a node.
    ctx.globalAlpha = Math.sin(offset * Math.PI) * FLOW_PEAK_ALPHA;
    const at = quadraticPointAt(from, control, to, offset);
    ctx.beginPath();
    ctx.arc(at.x, at.y, FLOW_DOT_RADIUS_PX, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawEdges(ctx: RenderContext2D, scene: RenderScene, view: Bounds): number {
  let drawn = 0;
  for (const edge of scene.edges) {
    const a = pointOf(scene, edge.source);
    const b = pointOf(scene, edge.target);
    if (!a || !b) continue;
    if (!segmentIntersectsBounds(a, b, view)) continue;

    const isHoverHot =
      scene.highlightIds !== null &&
      scene.highlightIds.has(edge.source) &&
      scene.highlightIds.has(edge.target);
    const isExpansionHot =
      scene.exposedIds?.has(edge.source) === true && scene.exposedIds.has(edge.target);
    const isHot = isHoverHot || isExpansionHot;

    ctx.globalAlpha = scene.exposedIds
      ? isExpansionHot
        ? EDGE_HIGHLIGHT_ALPHA
        : DIMMED_ALPHA
      : scene.highlightIds === null
        ? EDGE_ALPHA
        : isHot
          ? EDGE_HIGHLIGHT_ALPHA
          : DIMMED_ALPHA;
    ctx.strokeStyle = isHot ? EDGE_HIGHLIGHT_COLOR : EDGE_COLOR;
    ctx.lineWidth = edgeWidth(edge);

    const from = worldToScreen(scene.viewport, a.x, a.y);
    const to = worldToScreen(scene.viewport, b.x, b.y);
    const control = stableBowControl(from, to, edge.source, edge.target);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
    ctx.stroke();

    if (edge.directed) {
      // Aim from the curve's control point so the head follows the bow rather
      // than the straight chord, and stop short of the target node's rim.
      const target = scene.nodeById.get(edge.target);
      const radius = target
        ? screenNodeRadius(target, scene.viewport.zoom, scene.contentSizes?.get(target.id))
        : 0;
      ctx.fillStyle = isHot ? EDGE_HIGHLIGHT_COLOR : EDGE_COLOR;
      drawArrowhead(ctx, control, to, radius + ARROWHEAD_GAP_PX);
    }

    // Flow rides on the edge it belongs to, and only where that edge is already
    // being drawn — so an expansion showing sub-concepts animates those ties
    // too, without flow deciding for itself what belongs on screen.
    if (scene.flowPhase !== null && scene.flowPhase !== undefined) {
      drawFlow(ctx, from, control, to, scene.flowPhase, isHot);
    }

    const progress = scene.discovery?.get(edge.id);
    if (progress !== undefined) drawDiscoveryPulse(ctx, from, control, to, progress);
    drawn += 1;
  }
  ctx.globalAlpha = 1;
  return drawn;
}

/** Quiet, non-semantic ties showing which parent revealed each sub-concept. */
function drawExpansionLinks(ctx: RenderContext2D, scene: RenderScene, view: Bounds): void {
  if (!scene.expansionLinks?.length) return;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = SUBNODE_LINK_COLOR;
  ctx.lineWidth = SUBNODE_LINK_WIDTH;
  ctx.setLineDash([...SUBNODE_LINK_DASH]);
  for (const link of scene.expansionLinks) {
    const source = pointOf(scene, link.sourceId);
    const target = pointOf(scene, link.targetId);
    if (!source || !target || !segmentIntersectsBounds(source, target, view)) continue;

    const from = worldToScreen(scene.viewport, source.x, source.y);
    const to = worldToScreen(scene.viewport, target.x, target.y);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * The rubber-band line for an edge being drawn. Dashed while it floats free,
 * solid with a ring on the target once it has somewhere to land — so the
 * author knows the drop will take before releasing.
 */
function drawConnectDraft(ctx: RenderContext2D, scene: RenderScene): void {
  const draft = scene.connectDraft;
  if (!draft) return;

  const anchor = pointOf(scene, draft.sourceId);
  if (!anchor) return;

  const from = worldToScreen(scene.viewport, anchor.x, anchor.y);
  const to = draft.to;
  const isLanding = draft.targetId !== null;

  ctx.save();
  ctx.strokeStyle = isLanding ? CONNECT_TARGET_COLOR : CONNECT_DRAFT_COLOR;
  ctx.lineWidth = CONNECT_DRAFT_WIDTH;

  // Keep the chosen source unmistakable during click-to-click linking. When
  // the pointer has not moved yet, the draft line has zero length; without a
  // source ring Connect mode looked as though the first click did nothing.
  const sourceNode = scene.nodeById.get(draft.sourceId);
  if (sourceNode) {
    const sourceRadius = screenNodeRadius(
      sourceNode,
      scene.viewport.zoom,
      scene.contentSizes?.get(sourceNode.id),
    );
    ctx.beginPath();
    ctx.arc(from.x, from.y, sourceRadius + CONNECT_TARGET_RING_GAP, 0, TAU);
    ctx.stroke();
  }

  ctx.setLineDash(isLanding ? [] : [...CONNECT_DRAFT_DASH]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);

  if (isLanding && draft.targetId) {
    const target = scene.nodeById.get(draft.targetId);
    const landing = pointOf(scene, draft.targetId);
    if (target && landing) {
      const centre = worldToScreen(scene.viewport, landing.x, landing.y);
      const radius = screenNodeRadius(
        target,
        scene.viewport.zoom,
        scene.contentSizes?.get(target.id),
      );
      ctx.fillStyle = CONNECT_TARGET_COLOR;
      drawArrowhead(ctx, from, centre, radius + ARROWHEAD_GAP_PX);

      ctx.lineWidth = CONNECT_TARGET_RING_WIDTH;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius + CONNECT_TARGET_RING_GAP, 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawNodeRings(ctx: RenderContext2D, scene: RenderScene, node: GraphNode, at: Point, radius: number): void {
  if (scene.subNodeIds?.has(node.id)) {
    ctx.strokeStyle = SUBNODE_RING_COLOR;
    ctx.lineWidth = SUBNODE_RING_WIDTH;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius + SUBNODE_RING_GAP, 0, TAU);
    ctx.stroke();
  }
  if (node.pinned) {
    ctx.strokeStyle = PINNED_RING_COLOR;
    ctx.lineWidth = PINNED_RING_WIDTH;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius + SELECTED_RING_GAP / 2, 0, TAU);
    ctx.stroke();
  }
  if (scene.hoveredNodeId === node.id && scene.selectedNodeId !== node.id) {
    ctx.strokeStyle = HOVER_RING_COLOR;
    ctx.lineWidth = HOVER_RING_WIDTH;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius + HOVER_RING_GAP, 0, TAU);
    ctx.stroke();
  }
  if (scene.selectedNodeId !== node.id) return;

  ctx.strokeStyle = SELECTED_RING_COLOR;
  ctx.lineWidth = SELECTED_RING_WIDTH;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius + SELECTED_RING_GAP, 0, TAU);
  ctx.stroke();
}

function drawInteractionHalo(
  ctx: RenderContext2D,
  scene: RenderScene,
  nodeId: string,
  at: Point,
  radius: number,
): void {
  if (scene.hoveredNodeId !== nodeId || scene.selectedNodeId === nodeId) return;
  ctx.save();
  ctx.fillStyle = HOVER_HALO_COLOR;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius + HOVER_RING_GAP + 5, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * The halo of a node firing: an expanding, fading ring.
 *
 * `intensity` is 1 at the instant of recall and eases to 0, so a burst of
 * mentions reads as a sequence of discharges rather than a steady glow.
 */
function drawRecallPulse(
  ctx: RenderContext2D,
  at: Point,
  radius: number,
  intensity: number,
): void {
  ctx.save();
  ctx.globalAlpha = intensity;

  // Halo: widest at the moment of firing.
  ctx.fillStyle = RECALL_GLOW_COLOR;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius + RECALL_HALO_PX * intensity, 0, TAU);
  ctx.fill();

  // Ring: travels outward as the pulse decays, like a wavefront.
  ctx.strokeStyle = RECALL_COLOR;
  ctx.lineWidth = RECALL_RING_WIDTH;
  ctx.globalAlpha = intensity * 0.8;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius + RECALL_HALO_PX * (1 - intensity) + 2, 0, TAU);
  ctx.stroke();

  ctx.restore();
}

/**
 * Shape is the stable semantic channel; colour is deliberately left to graph
 * clustering. That makes a claim distinguishable from a person even when
 * both happen to sit in the same community, and it remains readable without
 * colour perception.
 */
function traceNodeShape(
  ctx: RenderContext2D,
  node: GraphNode,
  at: Point,
  radius: number,
): void {
  ctx.beginPath();
  if (node.kind === 'concept' || node.kind === 'group') {
    ctx.arc(at.x, at.y, radius, 0, TAU);
    return;
  }

  const sides = node.kind === 'question' ? 3 : node.kind === 'source' ? 6 : 4;
  const rotation = node.kind === 'entity' ? Math.PI / 4 : -Math.PI / 2;
  for (let side = 0; side < sides; side += 1) {
    const angle = rotation + (side / sides) * TAU;
    const x = at.x + Math.cos(angle) * radius;
    const y = at.y + Math.sin(angle) * radius;
    if (side === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawNodes(
  ctx: RenderContext2D,
  scene: RenderScene,
  view: Bounds,
  candidates: LabelCandidate[],
): number {
  // Exports name everything, and an expansion names its whole context so the
  // greyed surroundings stay readable. Otherwise the scale decides how much of
  // the map is named, and centrality decides which parts.
  const namesEverything =
    scene.forceLabels || (scene.exposedIds !== null && scene.exposedIds !== undefined);
  const tier = labelTier(scene.viewport.zoom);
  let drawn = 0;

  for (const node of scene.nodes) {
    const world = nodePoint(scene.index, node);
    if (!containsPoint(view, world)) continue;

    const at = worldToScreen(scene.viewport, world.x, world.y);
    const radius = screenNodeRadius(node, scene.viewport.zoom, scene.contentSizes?.get(node.id));
    const active = isActive(scene, node.id);

    // Drawn under the node so the halo reads as light coming off it.
    const pulse = scene.recall?.get(node.id) ?? 0;
    if (pulse > 0) drawRecallPulse(ctx, at, radius, pulse);
    drawInteractionHalo(ctx, scene, node.id, at, radius);

    ctx.globalAlpha = nodeAlpha(scene, node.id);
    // A firing node takes the recall colour outright — a tinted blend would
    // read as a different concept rather than the same one, active.
    // Greyed, not faded: a node outside the expansion keeps its size, its
    // label and its place, and loses only its colour.
    const isExposed = !scene.exposedIds || scene.exposedIds.has(node.id);
    const categoryColor = scene.presentations?.get(node.id)?.categoryColor ?? nodeCategoryColor(node);
    const isSelected = scene.selectedNodeId === node.id;
    ctx.fillStyle = pulse > 0.15
      ? RECALL_COLOR
      : isExposed
        ? isSelected ? categoryColor : NODE_CORE_COLOR
        : GREYED_NODE_COLOR;
    traceNodeShape(ctx, node, at, radius);
    ctx.fill();

    ctx.strokeStyle = isExposed ? categoryColor : NODE_STROKE_COLOR;
    ctx.lineWidth = isExposed ? NODE_CATEGORY_RING_WIDTH : NODE_STROKE_WIDTH;
    ctx.stroke();
    if (node.kind === 'metric') {
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(1.5, radius * 0.32), 0, TAU);
      ctx.stroke();
    }
    drawNodeRings(ctx, scene, node, at, radius);
    drawn += 1;

    // `active` is the selected or hovered concept, which is always named — so
    // the thing the author is looking at keeps its title even zoomed right out.
    if (!namesEverything && !active && !earnsLabel(tier, node.centrality)) continue;
    const identity = scene.presentations?.get(node.id);
    const text = active ? (identity?.canonicalName ?? node.label.trim()) : (identity?.shortGraphName ?? node.label.trim());
    if (text.length === 0) continue;
    const width = ctx.measureText(text).width;
    candidates.push({
      nodeId: node.id,
      text,
      box: labelBoxAt(at.x, at.y + radius + LABEL_OFFSET_PX, width, LABEL_FONT_SIZE_PX),
      priority:
        active || scene.exposedIds?.has(node.id)
          ? Number.POSITIVE_INFINITY
          : node.centrality,
    });
  }

  ctx.globalAlpha = 1;
  return drawn;
}

/**
 * A quiet drafting grid: enough structure to orient the map, never graph paper.
 *
 * Drawn in WORLD space. It used to be laid out in screen pixels, which nailed
 * it to the viewport while the graph slid across it — the nodes moved and the
 * ground did not, so a drag read as the map dissolving rather than being
 * carried. Anchoring the lines to world coordinates makes the grid part of the
 * scene: pan and it travels, zoom and it scales.
 */
function drawCanvasGrid(ctx: RenderContext2D, scene: RenderScene): void {
  const { viewport, width, height } = scene;
  if (viewport.zoom <= EPSILON) return;

  // Coarsen by doubling until a cell is actually visible. Doubling rather than
  // any other factor keeps every coarse line on the fine grid, so lines hold
  // still as the zoom crosses a threshold instead of shuffling sideways.
  let worldStep = CANVAS_GRID_SIZE_PX;
  while (worldStep * viewport.zoom < CANVAS_GRID_MIN_SPACING_PX) worldStep *= 2;

  const bounds = visibleWorldBounds(viewport, { width, height });

  const firstColumn = Math.ceil(bounds.minX / worldStep);
  const lastColumn = Math.floor(bounds.maxX / worldStep);
  for (let column = firstColumn; column <= lastColumn; column += 1) {
    // Majors keyed off the world index, so the same lines stay major while
    // panning instead of re-striping as they cross the viewport edge.
    ctx.fillStyle =
      column % CANVAS_GRID_MAJOR_EVERY === 0 ? CANVAS_GRID_MAJOR_COLOR : CANVAS_GRID_MINOR_COLOR;
    const x = worldToScreen(viewport, column * worldStep, 0).x;
    ctx.fillRect(Math.round(x), 0, 1, height);
  }

  const firstRow = Math.ceil(bounds.minY / worldStep);
  const lastRow = Math.floor(bounds.maxY / worldStep);
  for (let row = firstRow; row <= lastRow; row += 1) {
    ctx.fillStyle =
      row % CANVAS_GRID_MAJOR_EVERY === 0 ? CANVAS_GRID_MAJOR_COLOR : CANVAS_GRID_MINOR_COLOR;
    const y = worldToScreen(viewport, 0, row * worldStep).y;
    ctx.fillRect(0, Math.round(y), width, 1);
  }
}

function drawLabels(ctx: RenderContext2D, scene: RenderScene, candidates: readonly LabelCandidate[]): number {
  const accepted = selectVisibleLabels(candidates);
  let drawn = 0;

  for (const candidate of candidates) {
    if (!accepted.has(candidate.nodeId)) continue;
    const active = isActive(scene, candidate.nodeId);
    ctx.globalAlpha = nodeAlpha(scene, candidate.nodeId);
    if (active) {
      const padX = 5;
      const padY = 3;
      ctx.fillStyle = 'rgba(9, 10, 11, 0.88)';
      ctx.fillRect(
        candidate.box.x - padX,
        candidate.box.y - padY,
        candidate.box.width + padX * 2,
        candidate.box.height + padY * 2,
      );
    }
    ctx.fillStyle = active ? LABEL_ACTIVE_COLOR : LABEL_COLOR;
    ctx.fillText(candidate.text, candidate.box.x + candidate.box.width / 2, candidate.box.y);
    drawn += 1;
  }

  ctx.globalAlpha = 1;
  return drawn;
}

/**
 * Paint one frame. The canvas is filled opaquely first — on screen that is the
 * app background, and on export it is what stops JPEG's missing alpha channel
 * from encoding the whole image black.
 */
export function renderGraph(ctx: RenderContext2D, scene: RenderScene): RenderStats {
  ctx.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, scene.width, scene.height);
  drawCanvasGrid(ctx, scene);

  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const margin = CULL_MARGIN_PX / Math.max(EPSILON, scene.viewport.zoom);
  const view = expandBounds(
    visibleWorldBounds(scene.viewport, { width: scene.width, height: scene.height }),
    margin,
  );

  const candidates: LabelCandidate[] = [];
  drawGroupHulls(ctx, scene);
  drawExpansionLinks(ctx, scene, view);
  const edgesDrawn = drawEdges(ctx, scene, view);
  const nodesDrawn = drawNodes(ctx, scene, view, candidates);
  const labelsDrawn = drawLabels(ctx, scene, candidates);
  // Last, so the in-flight line rides above the nodes it is being drawn between.
  drawConnectDraft(ctx, scene);

  return { nodesDrawn, edgesDrawn, labelsDrawn };
}
