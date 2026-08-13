import { describe, expect, test } from 'vitest';
import type { GraphEdge, GraphNode } from '../../../../shared/types/graph';
import { CANVAS_BACKGROUND, DISCOVERY_COLOR, LABEL_ZOOM_MEDIUM } from '../constants';
import { FLOW_DOTS_PER_EDGE } from '../flow';
import { renderGraph, type RenderScene } from '../renderer';
import type { Viewport } from '../viewport';
import { FakeCanvasContext, parseColor } from './fakeCanvas';
import { makeEdge, makeNode, nodeMap } from './fixtures';

const CANVAS_SIZE = 200;

function makeScene(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[] = [],
  overrides: Partial<RenderScene> = {},
): RenderScene {
  const viewport: Viewport = overrides.viewport ?? { zoom: 1, panX: 0, panY: 0 };
  return {
    nodes,
    nodeById: nodeMap(nodes),
    edges,
    index: null,
    viewport,
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    dpr: 1,
    background: CANVAS_BACKGROUND,
    selectedNodeId: null,
    hoveredNodeId: null,
    highlightIds: null,
    forceLabels: false,
    connectDraft: null,
    ...overrides,
  };
}

describe('renderGraph culling', () => {
  test('draws only the nodes and edges near the viewport', () => {
    // Arrange
    const nodes = [
      makeNode('near', { x: 100, y: 100 }),
      makeNode('far-a', { x: 5000, y: 5000 }),
      makeNode('far-b', { x: 6000, y: 6000 }),
      makeNode('near-b', { x: 120, y: 120 }),
    ];
    const edges = [makeEdge('e1', 'near', 'near-b'), makeEdge('e2', 'far-a', 'far-b')];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    // Act
    const stats = renderGraph(ctx, makeScene(nodes, edges));

    // Assert
    expect(stats.nodesDrawn).toBe(2);
    expect(stats.edgesDrawn).toBe(1);
  });

  test('skips edges whose endpoints are missing from the graph', () => {
    const nodes = [makeNode('a', { x: 10, y: 10 })];
    const edges = [makeEdge('dangling', 'a', 'ghost')];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(ctx, makeScene(nodes, edges));

    expect(stats.edgesDrawn).toBe(0);
    expect(stats.nodesDrawn).toBe(1);
  });
});

describe('renderGraph device pixel ratio', () => {
  test('applies dpr once as the canvas transform', () => {
    const ctx = new FakeCanvasContext(CANVAS_SIZE * 2, CANVAS_SIZE * 2);

    renderGraph(ctx, makeScene([makeNode('a', { x: 50, y: 50 })], [], { dpr: 2 }));

    expect(ctx.transforms[0]).toEqual([2, 0, 0, 2, 0, 0]);
  });

  test('the background fill covers every device pixel, opaquely', () => {
    const ctx = new FakeCanvasContext(CANVAS_SIZE * 2, CANVAS_SIZE * 2);

    renderGraph(ctx, makeScene([makeNode('a', { x: 50, y: 50 })], [], { dpr: 2 }));

    const expected = parseColor(CANVAS_BACKGROUND);
    for (const corner of [
      { x: 0, y: 0 },
      { x: CANVAS_SIZE * 2 - 1, y: 0 },
      { x: 0, y: CANVAS_SIZE * 2 - 1 },
      { x: CANVAS_SIZE * 2 - 1, y: CANVAS_SIZE * 2 - 1 },
    ]) {
      // Opacity is the claim here. The colour is asserted off-grid below: the
      // grid is anchored to world coordinates, so a line legitimately lands on
      // the corner whenever world origin sits at the canvas edge.
      expect(ctx.getPixel(corner.x, corner.y).a).toBe(255);
    }

    const offGrid = ctx.getPixel(7, 7);
    expect(offGrid.r).toBe(expected.r);
    expect(offGrid.b).toBe(expected.b);
  });
});

describe('renderGraph labels', () => {
  test('suppresses a label that would collide with a stronger one', () => {
    const nodes = [
      makeNode('alpha', { x: 100, y: 100, centrality: 0.9 }),
      makeNode('alphb', { x: 102, y: 100, centrality: 0.1 }),
    ];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(ctx, makeScene(nodes));

    expect(stats.nodesDrawn).toBe(2);
    expect(stats.labelsDrawn).toBe(1);
    expect(ctx.filledTexts).toEqual(['alpha']);
  });

  test('draws both labels once they are far enough apart', () => {
    const nodes = [
      makeNode('alpha', { x: 20, y: 20, centrality: 0.9 }),
      makeNode('omega', { x: 160, y: 170, centrality: 0.1 }),
    ];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(ctx, makeScene(nodes));

    expect(stats.labelsDrawn).toBe(2);
  });

  test('hides every label below the zoom threshold', () => {
    const nodes = [makeNode('alpha', { x: 0, y: 0 }), makeNode('omega', { x: 300, y: 300 })];
    const viewport: Viewport = { zoom: LABEL_ZOOM_MEDIUM - 0.05, panX: 20, panY: 20 };
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(ctx, makeScene(nodes, [], { viewport }));

    expect(stats.nodesDrawn).toBe(2);
    expect(stats.labelsDrawn).toBe(0);
  });

  test('a landed relationship paints its lime pulse along the edge', () => {
    const nodes = [makeNode('a', { x: 20, y: 20 }), makeNode('b', { x: 140, y: 140 })];
    const edges = [makeEdge('e1', 'a', 'b')];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    renderGraph(
      ctx,
      makeScene(nodes, edges, { discovery: new Map([['e1', 0.5]]) }),
    );

    expect(ctx.strokeColors).toContain(DISCOVERY_COLOR);
  });

  test('flow paints travellers along an edge while it is playing', () => {
    const nodes = [makeNode('a', { x: 20, y: 20 }), makeNode('b', { x: 140, y: 140 })];
    const edges = [makeEdge('e1', 'a', 'b')];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    renderGraph(ctx, makeScene(nodes, edges, { flowPhase: 0.5 }));

    expect(ctx.arcCount).toBeGreaterThanOrEqual(FLOW_DOTS_PER_EDGE);
  });

  /* Stopped is stopped: a still map must paint nothing extra at all. */
  test('a stopped graph paints no flow', () => {
    const nodes = [makeNode('a', { x: 20, y: 20 }), makeNode('b', { x: 140, y: 140 })];
    const edges = [makeEdge('e1', 'a', 'b')];
    const flowing = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);
    const stopped = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    renderGraph(flowing, makeScene(nodes, edges, { flowPhase: 0.5 }));
    renderGraph(stopped, makeScene(nodes, edges, { flowPhase: null }));

    expect(flowing.arcCount - stopped.arcCount).toBe(FLOW_DOTS_PER_EDGE);
  });

  test('an ordinary map paints no discovery lime at all', () => {
    const nodes = [makeNode('a', { x: 20, y: 20 }), makeNode('b', { x: 140, y: 140 })];
    const edges = [makeEdge('e1', 'a', 'b')];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    renderGraph(ctx, makeScene(nodes, edges));

    expect(ctx.strokeColors).not.toContain(DISCOVERY_COLOR);
  });

  /*
   * The point of semantic zoom: pulled back to the whole map you get the few
   * landmarks, not 41 editorial titles competing for the same pixels.
   */
  test('names the landmark but not the ordinary concept when pulled back', () => {
    const nodes = [
      makeNode('landmark', { x: 0, y: 0, centrality: 1 }),
      makeNode('ordinary', { x: 300, y: 300, centrality: 0.05 }),
    ];
    const viewport: Viewport = { zoom: LABEL_ZOOM_MEDIUM - 0.05, panX: 20, panY: 20 };
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(ctx, makeScene(nodes, [], { viewport }));

    expect(stats.nodesDrawn).toBe(2);
    expect(ctx.filledTexts).toEqual(['landmark']);
  });

  test('zooming in reveals the concepts the far tier held back', () => {
    // Both must sit inside the 200px canvas at zoom 1, or culling — not the
    // label tier — would be what removed the second name.
    const nodes = [
      makeNode('landmark', { x: 0, y: 0, centrality: 1 }),
      makeNode('ordinary', { x: 120, y: 120, centrality: 0.05 }),
    ];
    const viewport: Viewport = { zoom: 1, panX: 20, panY: 20 };
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    renderGraph(ctx, makeScene(nodes, [], { viewport }));

    expect(ctx.filledTexts).toEqual(expect.arrayContaining(['landmark', 'ordinary']));
  });

  test('still labels the selected node when labels are otherwise hidden', () => {
    const nodes = [makeNode('alpha', { x: 0, y: 0 }), makeNode('omega', { x: 300, y: 300 })];
    const viewport: Viewport = { zoom: LABEL_ZOOM_MEDIUM - 0.05, panX: 20, panY: 20 };
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(
      ctx,
      makeScene(nodes, [], { viewport, selectedNodeId: 'omega' }),
    );

    expect(stats.labelsDrawn).toBe(1);
    expect(ctx.filledTexts).toEqual(['omega']);
  });

  test('forceLabels ignores the zoom threshold, which is what export needs', () => {
    const nodes = [makeNode('alpha', { x: 0, y: 0 }), makeNode('omega', { x: 300, y: 300 })];
    const viewport: Viewport = { zoom: LABEL_ZOOM_MEDIUM - 0.05, panX: 20, panY: 20 };
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(ctx, makeScene(nodes, [], { viewport, forceLabels: true }));

    expect(stats.labelsDrawn).toBe(2);
  });

  test('an expansion keeps context titles visible below the normal zoom threshold', () => {
    const nodes = [
      makeNode('alpha', { x: 0, y: 0 }),
      makeNode('omega', { x: 300, y: 300 }),
    ];
    const viewport: Viewport = { zoom: LABEL_ZOOM_MEDIUM - 0.05, panX: 20, panY: 20 };
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(
      ctx,
      makeScene(nodes, [], { viewport, exposedIds: new Set(['alpha']) }),
    );

    expect(stats.labelsDrawn).toBe(2);
    expect(ctx.filledTexts).toEqual(expect.arrayContaining(['alpha', 'omega']));
  });
});

describe('renderGraph expansion', () => {
  test('draws the visual parent-to-subnode tie without counting it as a graph edge', () => {
    const nodes = [
      makeNode('parent', { x: 50, y: 50 }),
      makeNode('sub', { x: 100, y: 100 }),
    ];
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);

    const stats = renderGraph(
      ctx,
      makeScene(nodes, [], {
        exposedIds: new Set(['parent', 'sub']),
        expansionLinks: [{ sourceId: 'parent', targetId: 'sub' }],
      }),
    );

    expect(stats.edgesDrawn).toBe(0);
    expect(ctx.strokeCount).toBe(3);
  });
});

describe('the background grid', () => {
  /** Screen x of every vertical grid line, read off the rasterised buffer. */
  function verticalLines(viewport: Viewport): number[] {
    const ctx = new FakeCanvasContext(CANVAS_SIZE, CANVAS_SIZE);
    renderGraph(ctx, makeScene([], [], { viewport }));

    const background = parseColor(CANVAS_BACKGROUND);
    const found: number[] = [];
    // Sampled off any horizontal line — row 0 sits on the one at world y = 0,
    // which would read as every column being a hit.
    for (let x = 0; x < CANVAS_SIZE; x += 1) {
      const pixel = ctx.getPixel(x, 5);
      const isBackground =
        pixel.r === background.r && pixel.g === background.g && pixel.b === background.b;
      if (!isBackground) found.push(x);
    }
    return found;
  }

  test('travels with the graph when the viewport pans', () => {
    // The reported bug: the nodes moved and the ground stayed put, so a drag
    // read as the map dissolving rather than being carried.
    const still = verticalLines({ zoom: 1, panX: 0, panY: 0 });
    const panned = verticalLines({ zoom: 1, panX: 17, panY: 0 });

    expect(still.length).toBeGreaterThan(0);
    expect(panned).not.toEqual(still);
    // Every line moved by exactly the pan: the grid is welded to the scene.
    for (const x of still) {
      if (x + 17 < CANVAS_SIZE) expect(panned).toContain(x + 17);
    }
  });

  test('is deterministic for an unchanged viewport', () => {
    expect(verticalLines({ zoom: 1, panX: 0, panY: 0 })).toEqual(
      verticalLines({ zoom: 1, panX: 0, panY: 0 }),
    );
  });

  test('coarsens rather than painting a solid wall when zoomed far out', () => {
    // One world cell is well under a pixel here; without coarsening this walks
    // thousands of lines to paint fog.
    expect(verticalLines({ zoom: 0.02, panX: 0, panY: 0 }).length).toBeLessThan(CANVAS_SIZE / 2);
  });
});
