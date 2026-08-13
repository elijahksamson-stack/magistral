/**
 * Repair the cell <-> node invariant at graph boundaries.
 *
 * External tools can author valid schema JSON containing graph nodes with no
 * cells. That file loads, but the Editor then omits most of the knowledge and
 * only the canvas can reach it. Every content node must instead have a real
 * cell whose first wikilink names that node. Groups are structural canvas
 * containers, so they intentionally remain outside the document cell list.
 */

import { nodeCellMarkdownFor } from '../../shared/concept-cell';
import { normalizeLabel } from '../../shared/labels';
import type { Cell, GraphNode, KnowledgeGraph } from '../../shared/types/graph';

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const WIKILINK_PATTERN = /\[\[([^\[\]\n]+?)\]\]/g;

export interface CellCoverageRepair {
  readonly graph: KnowledgeGraph;
  readonly changed: boolean;
  readonly addedCellCount: number;
  readonly repairedNodeIds: readonly string[];
  readonly removedDanglingCellRefs: number;
}

function isClosingFence(marker: string, openMarker: string): boolean {
  return marker[0] === openMarker[0] && marker.length >= openMarker.length;
}

/** The normalized target of the first authored wikilink, matching core rules. */
export function firstCellConcept(markdown: string): string | null {
  let openFence: string | null = null;

  for (const line of markdown.split('\n')) {
    const marker = FENCE_PATTERN.exec(line)?.[1] ?? null;
    if (openFence !== null) {
      if (marker !== null && isClosingFence(marker, openFence)) openFence = null;
      continue;
    }
    if (marker !== null) {
      openFence = marker;
      continue;
    }

    WIKILINK_PATTERN.lastIndex = 0;
    for (let match = WIKILINK_PATTERN.exec(line); match; match = WIKILINK_PATTERN.exec(line)) {
      const body = match[1];
      if (body === undefined) continue;
      const target = body.split('|', 1)[0]?.trim() ?? '';
      const normalized = normalizeLabel(target);
      if (normalized.length > 0) return normalized;
    }
  }
  return null;
}

function distinctValidCellIds(node: GraphNode, existing: ReadonlySet<string>): string[] {
  const rawIds: unknown = node.cellIds;
  if (!Array.isArray(rawIds)) return [];
  return [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && existing.has(id)))];
}

function uniqueCellId(nodeId: string, used: Set<string>): string {
  const base = `cell-for-${nodeId}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function makeCell(node: GraphNode, id: string, order: number, now: string): Cell {
  return {
    id,
    order,
    markdown: nodeCellMarkdownFor(node),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Idempotently make every non-group node visible and editable in the Editor.
 */
export function ensureNodeCellCoverage(
  graph: KnowledgeGraph,
  now: () => string = () => new Date().toISOString(),
): CellCoverageRepair {
  const orderedCells = [...graph.cells].sort((left, right) => left.order - right.order);
  const cells = orderedCells.map((cell, order) =>
    cell.order === order ? cell : { ...cell, order },
  );
  const existingCellIds = new Set(cells.map((cell) => cell.id));
  const usedCellIds = new Set(existingCellIds);
  const canonicalCells = new Map<string, string[]>();
  const nestedLabels = new Set(
    graph.nodes.flatMap((parent) =>
      (parent.subConcepts ?? []).map((subnode) => normalizeLabel(subnode.label)),
    ),
  );

  for (const cell of cells) {
    const concept = firstCellConcept(cell.markdown);
    if (concept === null) continue;
    canonicalCells.set(concept, [...(canonicalCells.get(concept) ?? []), cell.id]);
  }

  const repairedNodeIds: string[] = [];
  let removedDanglingCellRefs = 0;
  const nodes = graph.nodes.map((node) => {
    const rawCount = Array.isArray(node.cellIds) ? node.cellIds.length : 0;
    const validIds = distinctValidCellIds(node, existingCellIds);
    removedDanglingCellRefs += rawCount - validIds.length;

    if (node.kind === 'group') {
      return validIds.length === rawCount ? node : { ...node, cellIds: validIds };
    }

    const nodeKey = node.normalizedLabel || normalizeLabel(node.label);
    const canonicalIds = canonicalCells.get(nodeKey) ?? [];
    const nextIds = [...new Set([...validIds, ...canonicalIds])];
    // A materialized edge endpoint is still a child of its authored parent.
    // It deliberately has no standalone Editor cell; giving it one is what
    // falsely promoted every discovered subnode into a new top-level concept.
    if (nestedLabels.has(nodeKey) && canonicalIds.length === 0) {
      const unchanged =
        nextIds.length === rawCount &&
        Array.isArray(node.cellIds) &&
        nextIds.every((cellId, index) => node.cellIds[index] === cellId);
      if (unchanged) return node;
      repairedNodeIds.push(node.id);
      return { ...node, cellIds: nextIds };
    }
    if (canonicalIds.length === 0) {
      const timestamp = now();
      const cellId = uniqueCellId(node.id, usedCellIds);
      cells.push(makeCell(node, cellId, cells.length, timestamp));
      existingCellIds.add(cellId);
      nextIds.push(cellId);
      canonicalCells.set(nodeKey, [cellId]);
    }

    const unchanged =
      nextIds.length === rawCount &&
      Array.isArray(node.cellIds) &&
      nextIds.every((cellId, index) => node.cellIds[index] === cellId);
    if (unchanged) return node;
    repairedNodeIds.push(node.id);
    return { ...node, cellIds: nextIds };
  });

  const addedCellCount = cells.length - graph.cells.length;
  const reordered = cells.some((cell, index) => graph.cells[index]?.id !== cell.id || graph.cells[index]?.order !== cell.order);
  const changed = addedCellCount > 0 || repairedNodeIds.length > 0 || removedDanglingCellRefs > 0 || reordered;
  if (!changed) {
    return { graph, changed: false, addedCellCount: 0, repairedNodeIds: [], removedDanglingCellRefs: 0 };
  }

  return {
    graph: { ...graph, updatedAt: now(), cells, nodes },
    changed: true,
    addedCellCount,
    repairedNodeIds,
    removedDanglingCellRefs,
  };
}
