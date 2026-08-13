/**
 * Building the payload for a ✦ invocation.
 *
 * Kept pure and separate from the menu component so the exact shape handed to
 * the Claude bridge is directly testable — this is the boundary where the
 * author's text leaves the renderer.
 */

import type {
  CellAction,
  CellInvokeRequest,
  GraphContext,
  SourceDocument,
} from '../../../shared/types/claude';
import type { Cell, GraphNode, KnowledgeGraph } from '../../../shared/types/graph';
import { normalizeLabel } from './wikilink';
import type { LabelCandidate } from './wikilink-suggest';

/** How many high-centrality labels ride along as context. Context economy. */
export const TOP_NODE_LABEL_LIMIT = 12;

/** The request minus the id — `useClaude().invoke` mints that. */
export type PendingCellInvokeRequest = Omit<CellInvokeRequest, 'requestId'>;

function byImportance(a: GraphNode, b: GraphNode): number {
  if (b.centrality !== a.centrality) return b.centrality - a.centrality;
  if (b.degree !== a.degree) return b.degree - a.degree;
  return a.label.localeCompare(b.label);
}

/** Nodes this cell references, in graph order. */
function nodesLinkedToCell(nodes: readonly GraphNode[], cellId: string): GraphNode[] {
  return nodes.filter((node) => node.cellIds.includes(cellId));
}

/**
 * A compact summary of the graph, so Claude answers in the vocabulary the
 * author has already established instead of inventing a parallel one.
 */
export function buildGraphContext(
  graph: KnowledgeGraph,
  cellId: string,
  topLabelLimit: number = TOP_NODE_LABEL_LIMIT,
): GraphContext {
  const ranked = [...graph.nodes].sort(byImportance);

  return {
    graphName: graph.name,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    topNodeLabels: ranked.slice(0, Math.max(0, topLabelLimit)).map((node) => node.label),
    linkedNodeLabels: nodesLinkedToCell(graph.nodes, cellId).map((node) => node.label),
  };
}

/** Whitespace-only selections are not selections. */
function normalizeSelection(selectionText: string | null | undefined): string | null {
  if (typeof selectionText !== 'string') return null;
  const trimmed = selectionText.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface CellInvokeInput {
  action: CellAction;
  cell: Cell;
  /** The author's current selection, when they have one. */
  selectionText?: string | null;
  /** Omitted when the store has not produced a snapshot yet. */
  graph?: KnowledgeGraph | null;
  /** Present only for `distill-import` — the file being read. */
  sourceDocument?: SourceDocument;
}

/**
 * Assemble a `CellInvokeRequest`. Optional fields are omitted entirely rather
 * than set to undefined, so the IPC structured clone stays clean.
 */
export function buildCellInvokeRequest(input: CellInvokeInput): PendingCellInvokeRequest {
  const { action, cell, graph, sourceDocument } = input;
  const selectionText = normalizeSelection(input.selectionText);
  const graphContext = graph ? buildGraphContext(graph, cell.id) : null;

  return {
    kind: 'cell',
    action,
    cellId: cell.id,
    cellMarkdown: cell.markdown,
    ...(sourceDocument ? { sourceDocument } : {}),
    ...(selectionText !== null ? { selectionText } : {}),
    ...(graphContext !== null ? { graphContext } : {}),
    ...(cell.claudeSessionId ? { resumeSessionId: cell.claudeSessionId } : {}),
  };
}

/** Resolve a `[[label]]` to the node it denotes, via the shared dedup key. */
export function findNodeIdByLabel(
  nodes: readonly GraphNode[],
  label: string,
): string | null {
  const normalized = normalizeLabel(label);
  if (normalized.length === 0) return null;

  const hit = nodes.find((node) => node.normalizedLabel === normalized);
  return hit ? hit.id : null;
}

/**
 * Existing concepts for the `[[` autocomplete, most central first.
 *
 * `linkCount` combines cell references and graph degree — it answers "how much
 * does this graph already lean on this concept?", which is what tells the
 * author whether to reuse it or mint something new.
 */
export function collectSuggestableLabels(
  graph: KnowledgeGraph | null,
): readonly LabelCandidate[] {
  if (!graph) return [];
  return [...graph.nodes].sort(byImportance).map((node) => ({
    label: node.label,
    linkCount: node.cellIds.length + node.degree,
  }));
}
