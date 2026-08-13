/** Small builders so each test states only what it actually cares about. */

import { SCHEMA_VERSION, DEFAULT_VIEW } from '../../../../shared/types/graph';
import type { Cell, GraphEdge, GraphNode, KnowledgeGraph } from '../../../../shared/types/graph';

const ISO = '2026-01-01T00:00:00.000Z';

export function makeCell(overrides: Partial<Cell> = {}): Cell {
  return {
    id: 'cell-1',
    order: 0,
    markdown: 'The binding constraint is capital, not ideas.',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

export function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node-1',
    label: 'Binding Constraint',
    normalizedLabel: 'binding constraint',
    kind: 'concept',
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 0,
    centrality: 0,
    cluster: 0,
    ...overrides,
  };
}

export function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: 'edge-1',
    source: 'node-1',
    target: 'node-2',
    relation: 'relates_to',
    weight: 1,
    directed: false,
    ...overrides,
  };
}

export function makeGraph(overrides: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'graph-1',
    name: 'Capital Cycles',
    createdAt: ISO,
    updatedAt: ISO,
    cells: [makeCell()],
    nodes: [],
    edges: [],
    view: DEFAULT_VIEW,
    ...overrides,
  };
}
