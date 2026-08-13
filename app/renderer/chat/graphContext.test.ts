import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEW,
  SCHEMA_VERSION,
  type GraphNode,
  type KnowledgeGraph,
} from '../../../shared/types/graph';
import {
  MAX_TOP_NODE_LABELS,
  buildGraphContext,
  linkableLabels,
  normalizeLabel,
} from './graphContext';

function node(label: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `node-${label.toLowerCase().replace(/\s+/g, '-')}`,
    label,
    normalizedLabel: normalizeLabel(label),
    kind: 'concept',
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 1,
    centrality: 0.1,
    cluster: 0,
    ...overrides,
  };
}

function graphOf(nodes: GraphNode[]): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'graph-1',
    name: 'AI capex',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    cells: [],
    nodes,
    edges: [],
    view: DEFAULT_VIEW,
  };
}

describe('normalizeLabel', () => {
  // Mirrors braindump::normalizeLabel: lowercase, collapse whitespace, strip
  // punctuation at the ENDS only. Interior punctuation is part of the label —
  // this module used to strip it everywhere, which made "S&P 500" resolve to a
  // key the graph had never stored.
  it.each([
    ['Binding Constraint', 'binding constraint'],
    ['  HBM   supply  ', 'hbm supply'],
    ['Oil & Gas', 'oil & gas'],
    ['TSMC, Inc.', 'tsmc, inc'],
    ['Binding Constraint!', 'binding constraint'],
    ['S&P 500', 's&p 500'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeLabel(input)).toBe(expected);
  });
});

describe('buildGraphContext', () => {
  it('is undefined when no vault is open', () => {
    expect(buildGraphContext(null, null)).toBeUndefined();
  });

  it('summarises the graph and ranks labels by centrality', () => {
    const graph = graphOf([
      node('Low', { centrality: 0.1 }),
      node('High', { centrality: 0.9 }),
      node('Middle', { centrality: 0.5 }),
    ]);

    const context = buildGraphContext(graph, null);

    expect(context).toMatchObject({ graphName: 'AI capex', nodeCount: 3, edgeCount: 0 });
    expect(context!.topNodeLabels).toEqual(['High', 'Middle', 'Low']);
  });

  it('lists only the labels the selected cell references', () => {
    const graph = graphOf([
      node('Referenced', { cellIds: ['cell-1'] }),
      node('Elsewhere', { cellIds: ['cell-2'] }),
    ]);

    expect(buildGraphContext(graph, 'cell-1')!.linkedNodeLabels).toEqual(['Referenced']);
    expect(buildGraphContext(graph, null)!.linkedNodeLabels).toEqual([]);
  });

  it('caps the label list for context economy', () => {
    const nodes = Array.from({ length: MAX_TOP_NODE_LABELS + 20 }, (_, index) =>
      node(`Node ${index}`, { centrality: index / 100 }),
    );

    expect(buildGraphContext(graphOf(nodes), null)!.topNodeLabels).toHaveLength(
      MAX_TOP_NODE_LABELS,
    );
  });

  it('does not mutate the graph it summarises', () => {
    const graph = graphOf([node('B', { centrality: 0.2 }), node('A', { centrality: 0.8 })]);
    const before = graph.nodes.map((entry) => entry.label);

    buildGraphContext(graph, null);

    expect(graph.nodes.map((entry) => entry.label)).toEqual(before);
  });
});

describe('linkableLabels', () => {
  it('orders longest first so the most specific label wins a match', () => {
    const labels = linkableLabels(
      graphOf([node('Binding constraint'), node('Binding constraint migration')]),
    );
    expect(labels[0]).toBe('Binding constraint migration');
  });

  it('is empty without a graph', () => {
    expect(linkableLabels(null)).toEqual([]);
  });
});
