/**
 * One visual identity for an entity everywhere it appears.
 *
 * Graph data remains the durable contract. This is a renderer-only projection
 * that keeps Editor rows, canvas nodes, Chat references, search and inspectors
 * from inventing their own names, colours and state language.
 */

import type {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  NodeKind,
} from '../../../shared/types/graph';

export type MappedState = 'mapped' | 'unlinked';
export type SelectionState = 'idle' | 'hovered' | 'selected';

export interface EntityPresentation {
  readonly id: string;
  readonly canonicalName: string;
  readonly shortGraphName: string;
  readonly category: NodeKind;
  readonly categoryLabel: string;
  readonly categoryColor: string;
  readonly glyph: string;
  readonly mappedState: MappedState;
  readonly relationshipCount: number;
  readonly selectionState: SelectionState;
}

export interface GraphStatus {
  readonly cells: number;
  readonly mapped: number;
  readonly unlinked: number;
  readonly relationships: number;
}

export const CATEGORY_COLORS: Readonly<Record<NodeKind, string>> = {
  concept: '#7aa2d6',
  entity: '#6fbf8b',
  claim: '#d8a657',
  question: '#b48ead',
  source: '#7fb8c4',
  metric: '#c98f6f',
  group: '#8d989b',
};

export const CATEGORY_GLYPHS: Readonly<Record<NodeKind, string>> = {
  concept: '●',
  entity: '◆',
  claim: '■',
  question: '▲',
  source: '⬢',
  metric: '⊙',
  group: '◯',
};

const CATEGORY_LABELS: Readonly<Record<NodeKind, string>> = {
  concept: 'Concept',
  entity: 'Entity',
  claim: 'Claim',
  question: 'Question',
  source: 'Source',
  metric: 'Metric',
  group: 'Group',
};

const SHORT_NAME_LIMIT = 30;
const JOINERS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

/**
 * Produce a semantic canvas label without an ambiguous trailing ellipsis.
 * The canonical name is always restored for a selected entity.
 */
export function shortGraphName(label: string, limit = SHORT_NAME_LIMIT): string {
  const canonical = label.trim().replace(/\s+/g, ' ');
  if (canonical.length <= limit) return canonical;

  const withoutAside = canonical.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutAside.length > 0 && withoutAside.length <= limit) return withoutAside;

  const words = (withoutAside || canonical).split(' ');
  const meaningful = words.filter((word) => !JOINERS.has(word.toLocaleLowerCase()));
  const compact = meaningful.join(' ');
  if (compact.length <= limit) return compact;

  // Preserve both ends: the opening establishes the subject, while the final
  // noun usually carries the distinguishing idea ("… Unit Economics").
  const head = meaningful.slice(0, 2);
  const tail = meaningful.slice(-2);
  const bridged = [...head, '·', ...tail].join(' ');
  if (bridged.length <= limit) return bridged;

  return [...meaningful.slice(0, 1), '·', ...meaningful.slice(-2)].join(' ');
}

function relationCounts(edges: readonly GraphEdge[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}

/** Private: every caller builds the whole map via buildEntityPresentations. */
function presentEntity(
  node: GraphNode,
  relationshipCount: number,
  selectedNodeId: string | null,
  hoveredNodeId: string | null,
): EntityPresentation {
  const selectionState: SelectionState = selectedNodeId === node.id
    ? 'selected'
    : hoveredNodeId === node.id
      ? 'hovered'
      : 'idle';
  return {
    id: node.id,
    canonicalName: node.label.trim(),
    shortGraphName: shortGraphName(node.label),
    category: node.kind,
    categoryLabel: CATEGORY_LABELS[node.kind],
    categoryColor: CATEGORY_COLORS[node.kind],
    glyph: CATEGORY_GLYPHS[node.kind],
    mappedState: node.cellIds.length > 0 || node.kind === 'group' ? 'mapped' : 'unlinked',
    relationshipCount,
    selectionState,
  };
}

export function buildEntityPresentations(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  selectedNodeId: string | null = null,
  hoveredNodeId: string | null = null,
): ReadonlyMap<string, EntityPresentation> {
  const counts = relationCounts(edges);
  return new Map(nodes.map((node) => [
    node.id,
    presentEntity(node, counts.get(node.id) ?? 0, selectedNodeId, hoveredNodeId),
  ]));
}

/** Cell mapping, not node count: one authored cell is either on the map or not. */
export function graphStatus(graph: KnowledgeGraph): GraphStatus {
  // Defensive defaults keep the shell readable while a legacy snapshot is
  // being migrated and make this projection safe around partial test fixtures.
  const cells = graph.cells ?? [];
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const mappedCellIds = new Set(
    nodes
      .filter((node) => node.kind !== 'group')
      .flatMap((node) => node.cellIds),
  );
  const mapped = cells.filter((cell) => mappedCellIds.has(cell.id)).length;
  return {
    cells: cells.length,
    mapped,
    unlinked: cells.length - mapped,
    relationships: edges.length,
  };
}

export function formatGraphStatus(graph: KnowledgeGraph): string {
  const status = graphStatus(graph);
  return `${status.cells} cells · ${status.mapped} mapped · ${status.unlinked} unlinked · ${status.relationships} relationships`;
}
