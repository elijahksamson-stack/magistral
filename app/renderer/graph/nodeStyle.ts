/**
 * Node appearance: radius from authored content. Shared by
 * the on-screen renderer, the exporter and the hit-tester — they must agree or
 * clicks land next to what you see.
 */

import type { Cell, GraphNode } from '../../../shared/types/graph';
import { CATEGORY_COLORS } from '../shared/entityPresentation';
import {
  MAX_NODE_RADIUS,
  MAX_SCREEN_NODE_RADIUS,
  MIN_NODE_RADIUS,
  MIN_SCREEN_NODE_RADIUS,
} from './constants';

/** Roughly a substantial long-form cell. Anything beyond it stays at the cap. */
const FULL_SCALE_CONTENT_CHARS = 3_000;
/** Makes short notes visibly distinct without letting long documents explode. */
const CONTENT_CURVE_CHARS = 80;

export type NodeContentSizes = ReadonlyMap<string, number>;

function structuredContentLength(node: GraphNode): number {
  const noteLength = node.note?.trim().length ?? 0;
  const subConceptLength = (node.subConcepts ?? []).reduce(
    (total, concept) => total + concept.label.length + (concept.note?.length ?? 0),
    0,
  );
  return noteLength + subConceptLength;
}

/**
 * Measure the actual cells a node houses. Structured node prose is the
 * fallback for imported/legacy nodes that do not point at a cell.
 */
export function buildNodeContentSizes(
  nodes: readonly GraphNode[],
  cells: readonly Cell[],
): NodeContentSizes {
  const markdownByCellId = new Map(cells.map((cell) => [cell.id, cell.markdown] as const));
  return new Map(
    nodes.map((node) => {
      const cellLength = node.cellIds.reduce(
        (total, cellId) => total + (markdownByCellId.get(cellId)?.trim().length ?? 0),
        0,
      );
      return [node.id, cellLength > 0 ? cellLength : structuredContentLength(node)] as const;
    }),
  );
}

function contentWeight(contentChars: number): number {
  if (!Number.isFinite(contentChars) || contentChars <= 0) return 0;
  const capped = Math.min(FULL_SCALE_CONTENT_CHARS, contentChars);
  return (
    Math.log1p(capped / CONTENT_CURVE_CHARS) /
    Math.log1p(FULL_SCALE_CONTENT_CHARS / CONTENT_CURVE_CHARS)
  );
}

/**
 * World-space radius. A logarithmic curve makes a paragraph noticeably larger
 * than a title while compressing the difference between a long note and a
 * whole imported document. The hard max is intentionally modest.
 */
export function worldNodeRadius(node: GraphNode, contentChars?: number): number {
  const weight = contentWeight(contentChars ?? structuredContentLength(node));
  return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * weight;
}

export function screenNodeRadius(node: GraphNode, zoom: number, contentChars?: number): number {
  const scaled = worldNodeRadius(node, contentChars) * zoom;
  return Math.min(MAX_SCREEN_NODE_RADIUS, Math.max(MIN_SCREEN_NODE_RADIUS, scaled));
}

/** Stable category identity shared with Editor and Chat. */
export function nodeCategoryColor(node: GraphNode): string {
  return CATEGORY_COLORS[node.kind];
}
