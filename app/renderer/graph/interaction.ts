/**
 * Pointer and keyboard behaviour as a pure state machine.
 *
 * Nothing here touches the DOM or IPC: each handler returns the next state plus
 * a list of effects for the pane to carry out. That keeps every gesture — drag
 * to pan, wheel to zoom under the cursor, drag a node to pin it — testable
 * without a browser, and keeps side effects in one obvious place.
 */

import type { GraphNode } from '../../../shared/types/graph';
import { computeGraphBounds } from './bounds';
import {
  CLICK_SLOP_PX,
  FIT_PADDING_PX,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_STEP,
} from './constants';
import { hitTestNode } from './hitTest';
import type { PositionIndex } from './positionIndex';
import type { NodeContentSizes } from './nodeStyle';
import { nearestNodeInDirection, type Direction } from './selection';
import {
  IDENTITY_VIEWPORT,
  centerOn,
  fitToBounds,
  panBy,
  screenToWorld,
  zoomAt,
  type Point,
  type Size,
  type Viewport,
} from './viewport';

export type DragMode = 'idle' | 'pan' | 'node' | 'connect';

/**
 * Modifier keys at the moment of a press.
 *
 * Shift turns a node drag into an edge draw. Dragging a node already means
 * "move and pin it", so drawing an edge needs its own gesture; the hover
 * handle on a node's rim is the discoverable form of the same action, and
 * both arrive here as `connect: true`.
 */
export interface PointerModifiers {
  readonly connect: boolean;
}

export const NO_MODIFIERS: PointerModifiers = { connect: false };

export interface InteractionState {
  readonly viewport: Viewport;
  readonly mode: DragMode;
  readonly dragNodeId: string | null;
  readonly lastScreen: Point | null;
  readonly pressScreen: Point | null;
  readonly hasMoved: boolean;
  readonly hoveredNodeId: string | null;
  /** Node the in-flight edge is being drawn FROM. */
  readonly connectFromId: string | null;
  /** Where the loose end of the in-flight edge currently sits, in screen space. */
  readonly connectScreen: Point | null;
  /** Node under the cursor that the edge would land on. Null when over blank space. */
  readonly connectTargetId: string | null;
}

export type InteractionEffect =
  /**
   * `at` is where a CLICK landed, pane-local, so a click that hit no node can
   * be re-tested against the edges. Absent for keyboard selection, which has
   * no pointer position and must not open an edge editor.
   */
  | { readonly kind: 'select'; readonly nodeId: string | null; readonly at?: Point }
  | { readonly kind: 'pin'; readonly nodeId: string; readonly x: number; readonly y: number }
  | { readonly kind: 'unpin'; readonly nodeId: string }
  /**
   * A node drag ended. Separate from 'pin', which fires continuously during
   * the drag: joining a group is a decision made once, on release.
   */
  | { readonly kind: 'drop'; readonly nodeId: string }
  /**
   * A drawn edge landed on a node; the pane asks which relation it is.
   * `at` is the drop point in pane-local pixels, so the picker opens where the
   * author's attention already is rather than at some fixed corner.
   */
  | {
      readonly kind: 'connect';
      readonly sourceId: string;
      readonly targetId: string;
      readonly at: Point;
    }
  /** The layout has settled; a gesture just made it interesting again. */
  | { readonly kind: 'wake' };

export interface InteractionResult {
  readonly state: InteractionState;
  readonly effects: readonly InteractionEffect[];
}

export interface KeyResult extends InteractionResult {
  readonly handled: boolean;
}

/** What the handlers need to know about the graph to hit-test and navigate. */
export interface SceneContext {
  readonly nodes: readonly GraphNode[];
  readonly index: PositionIndex | null;
  readonly contentSizes?: NodeContentSizes;
}

const NO_EFFECTS: readonly InteractionEffect[] = [];

export const INITIAL_INTERACTION_STATE: InteractionState = {
  viewport: IDENTITY_VIEWPORT,
  mode: 'idle',
  dragNodeId: null,
  lastScreen: null,
  pressScreen: null,
  hasMoved: false,
  hoveredNodeId: null,
  connectFromId: null,
  connectScreen: null,
  connectTargetId: null,
};

/** Clear every drag field, whatever gesture was in flight. */
function toIdle(state: InteractionState): InteractionState {
  return {
    ...state,
    mode: 'idle',
    dragNodeId: null,
    lastScreen: null,
    pressScreen: null,
    hasMoved: false,
    connectFromId: null,
    connectScreen: null,
    connectTargetId: null,
  };
}

function unchanged(state: InteractionState): InteractionResult {
  return { state, effects: NO_EFFECTS };
}

function sceneAt(state: InteractionState, ctx: SceneContext) {
  return {
    nodes: ctx.nodes,
    index: ctx.index,
    viewport: state.viewport,
    ...(ctx.contentSizes ? { contentSizes: ctx.contentSizes } : {}),
  };
}

export function withViewport(state: InteractionState, viewport: Viewport): InteractionState {
  return viewport === state.viewport ? state : { ...state, viewport };
}

export function pointerDown(
  state: InteractionState,
  ctx: SceneContext,
  point: Point,
  modifiers: PointerModifiers = NO_MODIFIERS,
): InteractionResult {
  const nodeId = hitTestNode(sceneAt(state, ctx), point);

  // Shift on a node draws an edge instead of moving it. Shift on blank space
  // is a plain pan — there is nothing to draw from.
  if (nodeId && modifiers.connect) {
    const next: InteractionState = {
      ...state,
      mode: 'connect',
      dragNodeId: null,
      connectFromId: nodeId,
      connectScreen: point,
      connectTargetId: null,
      lastScreen: point,
      pressScreen: point,
      hasMoved: false,
    };
    return { state: next, effects: NO_EFFECTS };
  }

  const next: InteractionState = {
    ...state,
    mode: nodeId ? 'node' : 'pan',
    dragNodeId: nodeId,
    lastScreen: point,
    pressScreen: point,
    hasMoved: false,
  };
  return { state: next, effects: nodeId ? [{ kind: 'wake' }] : NO_EFFECTS };
}

function movedFarEnough(state: InteractionState, point: Point): boolean {
  if (state.hasMoved) return true;
  if (!state.pressScreen) return false;
  return Math.hypot(point.x - state.pressScreen.x, point.y - state.pressScreen.y) > CLICK_SLOP_PX;
}

export function pointerMove(
  state: InteractionState,
  ctx: SceneContext,
  point: Point,
): InteractionResult {
  if (state.mode === 'idle') {
    const hoveredNodeId = hitTestNode(sceneAt(state, ctx), point);
    if (hoveredNodeId === state.hoveredNodeId) return unchanged(state);
    return { state: { ...state, hoveredNodeId }, effects: NO_EFFECTS };
  }

  const last = state.lastScreen ?? point;
  const hasMoved = movedFarEnough(state, point);

  if (state.mode === 'connect') {
    // A node cannot connect to itself, so it never counts as a landing target.
    const over = hitTestNode(sceneAt(state, ctx), point);
    const connectTargetId = over && over !== state.connectFromId ? over : null;
    return {
      state: { ...state, connectScreen: point, connectTargetId, lastScreen: point, hasMoved },
      effects: NO_EFFECTS,
    };
  }

  if (state.mode === 'pan') {
    const viewport = panBy(state.viewport, point.x - last.x, point.y - last.y);
    return { state: { ...state, viewport, lastScreen: point, hasMoved }, effects: NO_EFFECTS };
  }

  const nodeId = state.dragNodeId;
  const next: InteractionState = { ...state, lastScreen: point, hasMoved };
  // Below CLICK_SLOP_PX this is still a click, not a drag. Pinning here would
  // freeze a node in the layout every time someone merely clicked to select it.
  if (!nodeId || !hasMoved) return { state: next, effects: NO_EFFECTS };

  const world = screenToWorld(state.viewport, point.x, point.y);
  return { state: next, effects: [{ kind: 'pin', nodeId, x: world.x, y: world.y }] };
}

/** A press that never travelled is a click: it selects, or clears selection. */
export function pointerUp(
  state: InteractionState,
  ctx: SceneContext,
  point: Point,
): InteractionResult {
  const idle = toIdle(state);

  if (state.mode === 'connect') {
    const sourceId = state.connectFromId;
    const targetId = hitTestNode(sceneAt(state, ctx), point);
    // Released over blank space, or back on the source: the author changed
    // their mind. Dropping the gesture silently is the right outcome.
    if (!sourceId || !targetId || targetId === sourceId) {
      return { state: idle, effects: NO_EFFECTS };
    }
    return { state: idle, effects: [{ kind: 'connect', sourceId, targetId, at: point }] };
  }

  if (state.mode === 'node' && state.hasMoved && state.dragNodeId) {
    return { state: idle, effects: [{ kind: 'drop', nodeId: state.dragNodeId }] };
  }
  if (state.mode === 'idle' || state.hasMoved) return { state: idle, effects: NO_EFFECTS };

  const nodeId = hitTestNode(sceneAt(state, ctx), point);
  return { state: idle, effects: [{ kind: 'select', nodeId, at: point }] };
}

export function pointerCancel(state: InteractionState): InteractionResult {
  if (state.mode === 'idle') return unchanged(state);
  // Routed through toIdle so an aborted connect drag cannot leave a dangling
  // rubber-band line on the canvas.
  return { state: toIdle(state), effects: NO_EFFECTS };
}

export function clearHover(state: InteractionState): InteractionState {
  return state.hoveredNodeId === null ? state : { ...state, hoveredNodeId: null };
}

export function doubleClick(
  state: InteractionState,
  ctx: SceneContext,
  point: Point,
): InteractionResult {
  const nodeId = hitTestNode(sceneAt(state, ctx), point);
  if (!nodeId) return unchanged(state);
  return { state, effects: [{ kind: 'unpin', nodeId }, { kind: 'wake' }] };
}

export function wheel(state: InteractionState, point: Point, deltaY: number): InteractionResult {
  const factor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
  return { state: withViewport(state, zoomAt(state.viewport, factor, point)), effects: NO_EFFECTS };
}

export function zoomByStep(state: InteractionState, steps: number, size: Size): InteractionState {
  const anchor: Point = { x: size.width / 2, y: size.height / 2 };
  return withViewport(state, zoomAt(state.viewport, Math.pow(ZOOM_STEP, steps), anchor));
}

export function frameGraph(state: InteractionState, ctx: SceneContext, size: Size): InteractionState {
  const bounds = computeGraphBounds(ctx.nodes, ctx.index, { contentSizes: ctx.contentSizes });
  if (!bounds) return state;
  return withViewport(state, fitToBounds(bounds, size, FIT_PADDING_PX));
}

export function resetView(state: InteractionState, ctx: SceneContext, size: Size): InteractionState {
  const bounds = computeGraphBounds(ctx.nodes, ctx.index, { contentSizes: ctx.contentSizes });
  const center: Point = bounds
    ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
    : { x: 0, y: 0 };
  return withViewport(state, centerOn(IDENTITY_VIEWPORT, center, size));
}

const ARROW_DIRECTIONS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export function keyDown(
  state: InteractionState,
  ctx: SceneContext,
  key: string,
  size: Size,
  selectedNodeId: string | null,
): KeyResult {
  const direction = ARROW_DIRECTIONS[key];
  if (direction) {
    const nodeId = nearestNodeInDirection(ctx.nodes, ctx.index, selectedNodeId, direction);
    if (!nodeId || nodeId === selectedNodeId) return { state, effects: NO_EFFECTS, handled: true };
    return { state, effects: [{ kind: 'select', nodeId }], handled: true };
  }

  if (key === '+' || key === '=') {
    return { state: zoomByStep(state, 1, size), effects: NO_EFFECTS, handled: true };
  }
  if (key === '-' || key === '_') {
    return { state: zoomByStep(state, -1, size), effects: NO_EFFECTS, handled: true };
  }
  if (key === '0') {
    return { state: resetView(state, ctx, size), effects: NO_EFFECTS, handled: true };
  }
  if (key === 'f' || key === 'F') {
    return { state: frameGraph(state, ctx, size), effects: NO_EFFECTS, handled: true };
  }

  return { state, effects: NO_EFFECTS, handled: false };
}
