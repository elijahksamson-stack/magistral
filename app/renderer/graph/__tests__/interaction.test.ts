import { describe, expect, test } from 'vitest';
import {
  INITIAL_INTERACTION_STATE,
  doubleClick,
  keyDown,
  pointerCancel,
  pointerDown,
  pointerMove,
  pointerUp,
  wheel,
  withViewport,
  type InteractionState,
  type SceneContext,
} from '../interaction';
import { screenToWorld, worldToScreen } from '../viewport';
import { makeNode } from './fixtures';

const NODES = [
  makeNode('a', { x: 50, y: 50, centrality: 0 }),
  makeNode('b', { x: 400, y: 50, centrality: 0 }),
  makeNode('c', { x: 50, y: 400, centrality: 0 }),
];
const CTX: SceneContext = { nodes: NODES, index: null };
const SIZE = { width: 800, height: 600 };

function stateAt(zoom: number, panX: number, panY: number): InteractionState {
  return withViewport(INITIAL_INTERACTION_STATE, { zoom, panX, panY });
}

describe('panning', () => {
  test('dragging the background moves the viewport by the pointer delta', () => {
    const down = pointerDown(stateAt(2, 0, 0), CTX, { x: 700, y: 500 });
    expect(down.state.mode).toBe('pan');

    const moved = pointerMove(down.state, CTX, { x: 720, y: 480 });

    expect(moved.state.viewport).toEqual({ zoom: 2, panX: 20, panY: -20 });
    expect(moved.effects).toEqual([]);
  });
});

describe('node dragging', () => {
  test('grabbing a node wakes the layout and pins it under the cursor', () => {
    // Arrange: node 'a' at world (50, 50) sits at screen (100, 100).
    const start = stateAt(2, 0, 0);
    expect(worldToScreen(start.viewport, 50, 50)).toEqual({ x: 100, y: 100 });

    // Act
    const down = pointerDown(start, CTX, { x: 100, y: 100 });
    const moved = pointerMove(down.state, CTX, { x: 140, y: 100 });

    // Assert
    expect(down.state.mode).toBe('node');
    expect(down.state.dragNodeId).toBe('a');
    expect(down.effects).toEqual([{ kind: 'wake' }]);
    expect(moved.effects).toEqual([{ kind: 'pin', nodeId: 'a', x: 70, y: 50 }]);
    expect(moved.state.viewport).toBe(start.viewport);
  });

  test('a click that only jitters does not pin the node', () => {
    // Arrange: a real pointer emits a move between down and up. One pixel of
    // travel is a click, not a drag — pinning here would silently freeze the
    // node in the layout every time the user selected it.
    const down = pointerDown(stateAt(1, 0, 0), CTX, { x: 50, y: 50 });

    // Act
    const moved = pointerMove(down.state, CTX, { x: 51, y: 50 });
    const up = pointerUp(moved.state, CTX, { x: 51, y: 50 });

    // Assert
    expect(moved.state.hasMoved).toBe(false);
    expect(moved.effects).toEqual([]);
    expect(up.effects).toMatchObject([{ kind: 'select', nodeId: 'a' }]);
  });

  test('crossing the click threshold starts pinning, and keeps pinning after', () => {
    const down = pointerDown(stateAt(1, 0, 0), CTX, { x: 50, y: 50 });
    const jitter = pointerMove(down.state, CTX, { x: 52, y: 50 });
    const dragged = pointerMove(jitter.state, CTX, { x: 70, y: 50 });
    const settled = pointerMove(dragged.state, CTX, { x: 71, y: 50 });

    expect(jitter.effects).toEqual([]);
    expect(dragged.effects).toEqual([{ kind: 'pin', nodeId: 'a', x: 70, y: 50 }]);
    // hasMoved latches, so a slow tail of the same drag still pins.
    expect(settled.effects).toEqual([{ kind: 'pin', nodeId: 'a', x: 71, y: 50 }]);
  });

  test('a drag drops rather than selecting', () => {
    const down = pointerDown(stateAt(1, 0, 0), CTX, { x: 50, y: 50 });
    const moved = pointerMove(down.state, CTX, { x: 90, y: 90 });
    const up = pointerUp(moved.state, CTX, { x: 90, y: 90 });

    // A drag ends in a drop, which is where group membership is decided.
    // It must never also select: the author was moving the node, not picking it.
    expect(up.effects).toEqual([{ kind: 'drop', nodeId: 'a' }]);
    expect(up.effects.some((effect) => effect.kind === 'select')).toBe(false);
    expect(up.state.mode).toBe('idle');
    expect(up.state.dragNodeId).toBeNull();
  });
});

describe('click selection', () => {
  test('a press that never travels selects the node under it', () => {
    const down = pointerDown(stateAt(1, 0, 0), CTX, { x: 50, y: 50 });
    const up = pointerUp(down.state, CTX, { x: 51, y: 51 });

    expect(up.effects).toMatchObject([{ kind: 'select', nodeId: 'a' }]);
  });

  test('clicking empty canvas clears the selection', () => {
    const down = pointerDown(stateAt(1, 0, 0), CTX, { x: 700, y: 550 });
    const up = pointerUp(down.state, CTX, { x: 700, y: 550 });

    expect(up.effects).toMatchObject([{ kind: 'select', nodeId: null }]);
  });

  test('double-clicking a node unpins it', () => {
    const result = doubleClick(stateAt(1, 0, 0), CTX, { x: 50, y: 50 });

    expect(result.effects).toEqual([{ kind: 'unpin', nodeId: 'a' }, { kind: 'wake' }]);
  });

  test('double-clicking the background does nothing at all', () => {
    const state = stateAt(1, 0, 0);
    const result = doubleClick(state, CTX, { x: 700, y: 550 });

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });
});

describe('hover', () => {
  test('reports a new hovered node and stays referentially stable otherwise', () => {
    const state = stateAt(1, 0, 0);

    const entered = pointerMove(state, CTX, { x: 50, y: 50 });
    const stillInside = pointerMove(entered.state, CTX, { x: 51, y: 50 });
    const left = pointerMove(stillInside.state, CTX, { x: 700, y: 550 });

    expect(entered.state.hoveredNodeId).toBe('a');
    expect(stillInside.state).toBe(entered.state);
    expect(left.state.hoveredNodeId).toBeNull();
  });
});

describe('wheel zoom', () => {
  test('zooms toward the cursor and keeps that world point fixed', () => {
    const state = stateAt(1, 0, 0);
    const cursor = { x: 620, y: 140 };
    const before = screenToWorld(state.viewport, cursor.x, cursor.y);

    const zoomed = wheel(state, cursor, -120);
    const after = screenToWorld(zoomed.state.viewport, cursor.x, cursor.y);

    expect(zoomed.state.viewport.zoom).toBeGreaterThan(1);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  test('a positive wheel delta zooms out', () => {
    const zoomed = wheel(stateAt(1, 0, 0), { x: 0, y: 0 }, 120);

    expect(zoomed.state.viewport.zoom).toBeLessThan(1);
  });
});

describe('keyboard', () => {
  test('arrows move the selection to the nearest node in that direction', () => {
    const right = keyDown(stateAt(1, 0, 0), CTX, 'ArrowRight', SIZE, 'a');
    const down = keyDown(stateAt(1, 0, 0), CTX, 'ArrowDown', SIZE, 'a');
    const up = keyDown(stateAt(1, 0, 0), CTX, 'ArrowUp', SIZE, 'a');

    expect(right.effects).toEqual([{ kind: 'select', nodeId: 'b' }]);
    expect(down.effects).toEqual([{ kind: 'select', nodeId: 'c' }]);
    expect(up.effects).toEqual([]);
    expect(up.handled).toBe(true);
  });

  test('with nothing selected an arrow picks the most central node', () => {
    const nodes = [makeNode('dim', { centrality: 0.1 }), makeNode('hub', { centrality: 0.9 })];
    const result = keyDown(stateAt(1, 0, 0), { nodes, index: null }, 'ArrowRight', SIZE, null);

    expect(result.effects).toEqual([{ kind: 'select', nodeId: 'hub' }]);
  });

  test('+ and - zoom around the centre of the pane', () => {
    const zoomedIn = keyDown(stateAt(1, 0, 0), CTX, '+', SIZE, null);
    const zoomedOut = keyDown(stateAt(1, 0, 0), CTX, '-', SIZE, null);

    expect(zoomedIn.state.viewport.zoom).toBeGreaterThan(1);
    expect(zoomedOut.state.viewport.zoom).toBeLessThan(1);
  });

  test('f frames the whole graph inside the pane', () => {
    const framed = keyDown(stateAt(4, -900, -900), CTX, 'f', SIZE, null);

    for (const node of NODES) {
      const screen = worldToScreen(framed.state.viewport, node.x, node.y);
      expect(screen.x).toBeGreaterThanOrEqual(0);
      expect(screen.x).toBeLessThanOrEqual(SIZE.width);
      expect(screen.y).toBeGreaterThanOrEqual(0);
      expect(screen.y).toBeLessThanOrEqual(SIZE.height);
    }
  });

  test('0 resets the zoom and centres the graph', () => {
    const reset = keyDown(stateAt(3.5, 999, -400), CTX, '0', SIZE, null);
    const center = worldToScreen(reset.state.viewport, 225, 225);

    expect(reset.state.viewport.zoom).toBe(1);
    expect(center.x).toBeCloseTo(SIZE.width / 2, 6);
    expect(center.y).toBeCloseTo(SIZE.height / 2, 6);
  });

  test('reports unknown keys as unhandled without touching state', () => {
    const state = stateAt(1, 0, 0);
    const result = keyDown(state, CTX, 'q', SIZE, null);

    expect(result.handled).toBe(false);
    expect(result.state).toBe(state);
  });
});

describe('drag-to-connect', () => {
  const CONNECT = { connect: true } as const;
  const at = (nodeId: 'a' | 'b' | 'c') => {
    const node = NODES.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`no fixture node ${nodeId}`);
    return worldToScreen({ zoom: 1, panX: 0, panY: 0 }, node.x, node.y);
  };

  test('shift on a node draws an edge instead of moving it', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);

    expect(down.state.mode).toBe('connect');
    expect(down.state.connectFromId).toBe('a');
    // Critically NOT a node drag — that would pin the source mid-gesture.
    expect(down.state.dragNodeId).toBeNull();
    expect(down.effects).toEqual([]);
  });

  test('shift on empty space still pans, since there is nothing to draw from', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, { x: 780, y: 580 }, CONNECT);
    expect(down.state.mode).toBe('pan');
  });

  test('plain drag on a node still moves and pins it', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'));
    expect(down.state.mode).toBe('node');
    expect(down.state.connectFromId).toBeNull();
  });

  test('tracks a landing target while the line is over another node', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);
    const overBlank = pointerMove(down.state, CTX, { x: 250, y: 300 });
    expect(overBlank.state.connectTargetId).toBeNull();

    const overB = pointerMove(overBlank.state, CTX, at('b'));
    expect(overB.state.connectTargetId).toBe('b');
  });

  test('never offers the source node as its own target', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);
    const backOnSource = pointerMove(down.state, CTX, at('a'));
    expect(backOnSource.state.connectTargetId).toBeNull();
  });

  test('releasing over another node asks for the relation', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);
    const moved = pointerMove(down.state, CTX, at('b'));
    const up = pointerUp(moved.state, CTX, at('b'));

    expect(up.effects).toEqual([
      { kind: 'connect', sourceId: 'a', targetId: 'b', at: at('b') },
    ]);
    expect(up.state.mode).toBe('idle');
  });

  test('releasing over blank space quietly abandons the edge', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);
    const moved = pointerMove(down.state, CTX, { x: 250, y: 300 });
    const up = pointerUp(moved.state, CTX, { x: 250, y: 300 });

    expect(up.effects).toEqual([]);
    expect(up.state.connectFromId).toBeNull();
  });

  test('releasing back on the source abandons it too, and never self-links', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);
    const up = pointerUp(down.state, CTX, at('a'));
    expect(up.effects).toEqual([]);
  });

  test('a connect drag never pins the node it started from', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);
    const moved = pointerMove(down.state, CTX, { x: 300, y: 300 });
    expect(moved.effects).toEqual([]);
  });

  test('cancelling clears the draft so no line is left on the canvas', () => {
    const down = pointerDown(INITIAL_INTERACTION_STATE, CTX, at('a'), CONNECT);
    const moved = pointerMove(down.state, CTX, at('b'));
    const cancelled = pointerCancel(moved.state);

    expect(cancelled.state.mode).toBe('idle');
    expect(cancelled.state.connectFromId).toBeNull();
    expect(cancelled.state.connectScreen).toBeNull();
    expect(cancelled.state.connectTargetId).toBeNull();
  });
});
