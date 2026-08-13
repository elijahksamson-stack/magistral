/**
 * What the ✦ menu sends. The CLI is never spawned here — `window.braindump` is
 * a fake, so the only thing under test is the payload.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CELL_ACTIONS,
  type CellAction,
  type CellInvokeRequest,
} from '../../../../shared/types/claude';
// Pulls in the `declare global { interface Window }` contract for the fake below.
import type {} from '../../../../shared/types/ipc';
import {
  TOP_NODE_LABEL_LIMIT,
  buildCellInvokeRequest,
  buildGraphContext,
  collectSuggestableLabels,
  findNodeIdByLabel,
} from '../cell-request';
import { makeCell, makeEdge, makeGraph, makeNode } from './fixtures';

const graph = makeGraph({
  nodes: [
    makeNode({ id: 'n-moat', label: 'Moat', normalizedLabel: 'moat', centrality: 0.9 }),
    makeNode({
      id: 'n-bind',
      label: 'Binding Constraint',
      normalizedLabel: 'binding constraint',
      centrality: 0.5,
      cellIds: ['cell-1'],
    }),
    makeNode({
      id: 'n-cycle',
      label: 'Capital Cycle',
      normalizedLabel: 'capital cycle',
      centrality: 0.1,
      cellIds: ['cell-9'],
    }),
  ],
  edges: [makeEdge({ source: 'n-moat', target: 'n-bind' })],
});

describe('buildGraphContext', () => {
  it('summarizes the graph and ranks labels by centrality', () => {
    expect(buildGraphContext(graph, 'cell-1')).toEqual({
      graphName: 'Capital Cycles',
      nodeCount: 3,
      edgeCount: 1,
      topNodeLabels: ['Moat', 'Binding Constraint', 'Capital Cycle'],
      linkedNodeLabels: ['Binding Constraint'],
    });
  });

  it('caps the top labels for context economy', () => {
    const many = makeGraph({
      nodes: Array.from({ length: 40 }, (_unused, index) =>
        makeNode({ id: `n-${index}`, label: `L${index}`, centrality: 1 - index / 100 }),
      ),
    });

    expect(buildGraphContext(many, 'cell-1').topNodeLabels).toHaveLength(TOP_NODE_LABEL_LIMIT);
  });

  it('does not mutate the graph it was handed', () => {
    const order = graph.nodes.map((node) => node.id);
    buildGraphContext(graph, 'cell-1');
    expect(graph.nodes.map((node) => node.id)).toEqual(order);
  });
});

describe('buildCellInvokeRequest', () => {
  const cell = makeCell({ id: 'cell-1', markdown: 'Capital is the [[Binding Constraint]].' });

  it('builds a well-formed request for every action', () => {
    for (const action of CELL_ACTIONS) {
      const request = buildCellInvokeRequest({ action, cell, graph });

      expect(request.kind).toBe('cell');
      expect(request.action).toBe(action);
      expect(request.cellId).toBe('cell-1');
      expect(request.cellMarkdown).toBe(cell.markdown);
      expect(request.graphContext?.graphName).toBe('Capital Cycles');
      expect(request).not.toHaveProperty('requestId');
    }
  });

  it('includes the selection when the author has one', () => {
    const request = buildCellInvokeRequest({
      action: 'enhance',
      cell,
      selectionText: 'Capital is',
      graph,
    });

    expect(request.selectionText).toBe('Capital is');
  });

  it('omits a whitespace-only selection entirely', () => {
    const request = buildCellInvokeRequest({
      action: 'enhance',
      cell,
      selectionText: '   \n ',
      graph,
    });

    expect(request).not.toHaveProperty('selectionText');
  });

  it('resumes the cell session when one exists', () => {
    const resumed = buildCellInvokeRequest({
      action: 'continue',
      cell: makeCell({ claudeSessionId: 'sess-42' }),
      graph,
    });

    expect(resumed.resumeSessionId).toBe('sess-42');
  });

  it('omits the session and graph context when neither is available', () => {
    const request = buildCellInvokeRequest({ action: 'distill', cell, graph: null });

    expect(request).not.toHaveProperty('resumeSessionId');
    expect(request).not.toHaveProperty('graphContext');
  });
});

describe('the payload that reaches the bridge', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('sends exactly one claude:invoke per action and never touches a CLI', async () => {
    const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({
      accepted: true as const,
    }));
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { braindump: { invoke, on: () => () => undefined } },
    });

    const cell = makeCell({ id: 'cell-7' });
    let requestCounter = 0;

    for (const action of CELL_ACTIONS) {
      requestCounter += 1;
      const request: CellInvokeRequest = {
        requestId: `req-${requestCounter}`,
        ...buildCellInvokeRequest({ action, cell, graph }),
      };
      await window.braindump.invoke('claude:invoke', request);
    }

    expect(invoke).toHaveBeenCalledTimes(CELL_ACTIONS.length);

    const sentActions = invoke.mock.calls.map(
      (call) => (call[1] as CellInvokeRequest).action as CellAction,
    );
    expect(sentActions).toEqual([...CELL_ACTIONS]);
    expect(invoke.mock.calls.every((call) => call[0] === 'claude:invoke')).toBe(true);
  });
});

describe('label lookup', () => {
  it('resolves a clicked label through the shared dedup key', () => {
    expect(findNodeIdByLabel(graph.nodes, 'binding   CONSTRAINT!')).toBe('n-bind');
  });

  it('returns null for a label with no node yet', () => {
    expect(findNodeIdByLabel(graph.nodes, 'Reflexivity')).toBeNull();
  });

  it('offers existing labels to the autocomplete, most central first', () => {
    expect(collectSuggestableLabels(graph).map((candidate) => candidate.label)).toEqual([
      'Moat',
      'Binding Constraint',
      'Capital Cycle',
    ]);
  });

  it('reports how heavily the graph leans on each concept', () => {
    // linkCount drives both the ranking tie-break and the "7 links" hint in the
    // popup, which is what pulls an author toward reuse over a near-duplicate.
    const counts = collectSuggestableLabels(graph).map((candidate) => candidate.linkCount);
    expect(counts.every((count) => Number.isInteger(count) && count >= 0)).toBe(true);
  });

  it('offers nothing before a graph is open', () => {
    expect(collectSuggestableLabels(null)).toEqual([]);
  });
});
