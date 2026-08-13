/**
 * Builds the compact GraphContext sent with each chat turn, and the label ->
 * node id lookup that makes labels in a response clickable.
 *
 * The context is deliberately small. The point is to tell the model what the
 * author's graph asserts, not to ship the graph.
 */

import { normalizeLabel } from '../../../shared/labels';
import type { GraphContext } from '../../../shared/types/claude';
import type { GraphNode, KnowledgeGraph } from '../../../shared/types/graph';

/** How many high-centrality labels travel with a turn. Context economy. */
export const MAX_TOP_NODE_LABELS = 24;
/** Cap on labels the response renderer will try to linkify. */
export const MAX_LINKABLE_LABELS = 200;

/**
 * The core's dedup key. Re-exported rather than reimplemented — this module
 * used to carry its own copy, which stripped interior punctuation the core
 * keeps, so "S&P 500" resolved to a different key here than in the graph.
 */
export { normalizeLabel };

function byCentralityThenDegree(left: GraphNode, right: GraphNode): number {
  return (
    right.centrality - left.centrality ||
    right.degree - left.degree ||
    left.label.localeCompare(right.label)
  );
}

/**
 * @param graph        The open graph, or null when no vault is open.
 * @param selectedCellId Cell the author is currently in, if any.
 */
export function buildGraphContext(
  graph: KnowledgeGraph | null,
  selectedCellId: string | null,
): GraphContext | undefined {
  if (!graph) return undefined;

  const topNodeLabels = [...graph.nodes]
    .sort(byCentralityThenDegree)
    .slice(0, MAX_TOP_NODE_LABELS)
    .map((node) => node.label);

  const linkedNodeLabels = selectedCellId
    ? graph.nodes
        .filter((node) => node.cellIds.includes(selectedCellId))
        .map((node) => node.label)
    : [];

  return {
    graphName: graph.name,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    topNodeLabels,
    linkedNodeLabels,
  };
}

/**
 * Labels the response renderer may linkify, longest first so "Binding
 * constraint migration" wins over "Binding constraint".
 */
export function linkableLabels(graph: KnowledgeGraph | null): string[] {
  if (!graph) return [];

  const nodeLabels = [...graph.nodes]
    .sort(byCentralityThenDegree)
    .slice(0, MAX_LINKABLE_LABELS)
    .flatMap((node) => [node.label, ...(node.subConcepts ?? []).map((subnode) => subnode.label)]);
  return [...new Set(nodeLabels)]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}
