/** Shared builders for graph tests. Not a test file — vitest ignores it. */

import type {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
} from '../../../../shared/types/graph';
import { DEFAULT_VIEW, SCHEMA_VERSION } from '../../../../shared/types/graph';

export function makeNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    normalizedLabel: id.toLowerCase(),
    kind: 'concept',
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 0,
    centrality: 0.5,
    cluster: 0,
    ...overrides,
  };
}

export function makeEdge(
  id: string,
  source: string,
  target: string,
  overrides: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    id,
    source,
    target,
    relation: 'relates_to',
    weight: 1,
    directed: false,
    ...overrides,
  };
}

export function makeGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[] = [],
  overrides: Partial<KnowledgeGraph> = {},
): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'graph-1',
    name: 'Test Graph',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cells: [],
    nodes: [...nodes],
    edges: [...edges],
    view: DEFAULT_VIEW,
    ...overrides,
  };
}

export function nodeMap(nodes: readonly GraphNode[]): ReadonlyMap<string, GraphNode> {
  return new Map(nodes.map((node) => [node.id, node] as const));
}
