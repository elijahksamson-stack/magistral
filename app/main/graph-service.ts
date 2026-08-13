/**
 * Owns the ONE live native Graph handle for the open vault.
 *
 * Everything that mutates the graph goes through here, so there is exactly one
 * writer and the native handle never leaves the main process — the renderer
 * only ever sees structured clones produced by `snapshot()`.
 *
 * Degraded mode: if the addon fails to load the app still starts. Reads and
 * writes then throw one clear, actionable error instead of the app dying at
 * launch with a stack trace the user cannot act on.
 *
 * Cell ORDER lives here, not in the core: `NativeGraph` has no reorder entry
 * point in shared/types/addon.ts, but IpcInvokeMap has `cell:reorder`. This
 * service keeps the authoritative ordering and renumbers `cells[].order` on the
 * way out, leaving the core's contract untouched.
 */

import type {
  BrainDumpCoreAddon,
  LayoutFrame,
  NativeGraph,
} from '../../shared/types/addon';
import type {
  Cell,
  ExtractionResult,
  KnowledgeGraph,
  LayoutParams,
  LinkSyncReport,
  MergeReport,
  NodeKind,
  RelationKind,
  SearchHit,
} from '../../shared/types/graph';
import { loadCoreAddon, type AddonLoadResult } from './addon-loader';
import {
  ensureNodeCellCoverage,
  type CellCoverageRepair,
} from './graph-cell-coverage';
import { createLogger, errorMessage } from './logger';

const log = createLogger('graph-service');

export interface GraphServiceStatus {
  readonly ready: boolean;
  readonly coreVersion?: string;
  readonly reason?: string;
}

export type GraphOpenReport = Pick<
  CellCoverageRepair,
  'changed' | 'addedCellCount' | 'repairedNodeIds' | 'removedDanglingCellRefs'
>;

export class GraphService {
  private readonly load: AddonLoadResult;
  private graph: NativeGraph | null = null;
  private cellOrder: readonly string[] = [];

  constructor(candidatePaths: readonly string[]) {
    this.load = loadCoreAddon(candidatePaths);
    if (!this.load.ok) log.error('degraded: no native core', this.load.reason);
  }

  status(): GraphServiceStatus {
    if (!this.load.ok) return { ready: false, reason: this.load.reason };
    return { ready: true, coreVersion: this.safeCoreVersion(this.load.addon) };
  }

  isReady(): boolean {
    return this.load.ok;
  }

  hasOpenGraph(): boolean {
    return this.graph !== null;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Replace the live handle, repairing any imported canvas-only content. */
  openFromJSON(graph: KnowledgeGraph): GraphOpenReport {
    const repair = ensureNodeCellCoverage(graph);
    this.installGraph(repair.graph);
    this.logCoverageRepair(repair, 'graph open');
    return repair;
  }

  createEmpty(name: string): void {
    const addon = this.requireAddon();
    this.graph = addon.createGraph(name);
    this.cellOrder = [];
  }

  close(): void {
    this.graph = null;
    this.cellOrder = [];
  }

  // -- reads ----------------------------------------------------------------

  /** Describe what a relationship actually is. */
  setEdgeNote(edgeId: string, note: string): void {
    this.requireGraph().setEdgeNote(edgeId, note);
  }

  /** Describe what a concept is, for a node no cell wrote. */
  setNodeNote(nodeId: string, note: string): void {
    this.requireGraph().setNodeNote(nodeId, note);
  }

  /** Rename a node. */
  setNodeLabel(nodeId: string, label: string): void {
    this.requireGraph().setNodeLabel(nodeId, label);
  }

  /** Put a node in a group, or pass an empty groupId to take it out. */
  setNodeGroup(nodeId: string, groupId: string): void {
    this.requireGraph().setNodeGroup(nodeId, groupId);
  }

  /** Rename the open graph. The core owns the name; the vault mirrors it. */
  setName(name: string): void {
    this.requireGraph().setName(name);
  }

  snapshot(): KnowledgeGraph {
    const ordered = applyCellOrder(this.readNativeSnapshot(), this.cellOrder);
    const repair = ensureNodeCellCoverage(ordered);
    if (!repair.changed) return ordered;

    // Defense in depth: every read boundary enforces the invariant too. This
    // catches a future mutation path that creates a content node but forgets
    // to create its cell, before that broken state can reach either pane.
    this.installGraph(repair.graph);
    this.logCoverageRepair(repair, 'graph snapshot');
    return applyCellOrder(this.readNativeSnapshot(), this.cellOrder);
  }

  private readNativeSnapshot(): KnowledgeGraph {
    const graph = this.requireGraph();
    let parsed: unknown;
    try {
      parsed = JSON.parse(graph.toJSON(false));
    } catch (error: unknown) {
      throw new Error(`Native core produced unreadable JSON: ${errorMessage(error)}`);
    }
    return parsed as KnowledgeGraph;
  }

  nodeOrder(): { order: string[]; topologyVersion: number } {
    const graph = this.requireGraph();
    return { order: graph.nodeOrder(), topologyVersion: graph.topologyVersion() };
  }

  components(): string[][] {
    return this.requireGraph().components();
  }

  shortestPath(fromId: string, toId: string): string[] {
    return this.requireGraph().shortestPath(fromId, toId);
  }

  backlinks(nodeId: string): string[] {
    return this.requireGraph().backlinks(nodeId);
  }

  search(query: string, limit?: number): SearchHit[] {
    return this.requireGraph().search(query, limit);
  }

  // -- cells ----------------------------------------------------------------

  upsertCell(cellId: string, markdown: string): LinkSyncReport {
    const report = this.requireGraph().syncCell(cellId, markdown);
    if (!this.cellOrder.includes(cellId)) this.cellOrder = [...this.cellOrder, cellId];
    return report;
  }

  removeCell(cellId: string): LinkSyncReport {
    const report = this.requireGraph().removeCell(cellId);
    this.cellOrder = this.cellOrder.filter((id) => id !== cellId);
    return report;
  }

  /** Ids absent from `orderedIds` keep their relative position at the end. */
  reorderCells(orderedIds: readonly string[]): void {
    this.requireGraph();
    const known = new Set(this.cellOrder);
    const requested = orderedIds.filter((id) => known.has(id));
    const placed = new Set(requested);
    this.cellOrder = [...requested, ...this.cellOrder.filter((id) => !placed.has(id))];
  }

  // -- graph mutation -------------------------------------------------------

  addNode(label: string, kind: NodeKind): string {
    return this.requireGraph().addNode(label, kind);
  }

  removeNode(nodeId: string): boolean {
    return this.requireGraph().removeNode(nodeId);
  }

  addEdge(sourceId: string, targetId: string, relation: RelationKind, weight?: number): string {
    return this.requireGraph().addEdge(sourceId, targetId, relation, weight);
  }

  removeEdge(edgeId: string): boolean {
    return this.requireGraph().removeEdge(edgeId);
  }

  /**
   * Merge a structured extraction into a cell.
   *
   * No app path reaches this any more: the ✦ Extract Concepts action was
   * removed in favour of "Complete the map", which proposes against the whole
   * graph and lands through a review. Kept because it mirrors a core API that
   * is still there and still tested — `cellExtractionLinks` participates in
   * orphan collection, so the C++ side is not dead even though this wrapper is
   * currently uncalled.
   */
  mergeExtraction(cellId: string, result: ExtractionResult): MergeReport {
    return this.requireGraph().mergeExtraction(cellId, result);
  }

  computeMetrics(): void {
    this.requireGraph().computeMetrics();
  }

  // -- layout ---------------------------------------------------------------

  layoutConfigure(params: Partial<LayoutParams>): void {
    this.requireGraph().layoutConfigure(params);
  }

  layoutTick(iterations?: number): LayoutFrame {
    return this.requireGraph().layoutTick(iterations);
  }

  layoutSettle(maxIterations?: number): LayoutFrame {
    return this.requireGraph().layoutSettle(maxIterations);
  }

  pinNode(nodeId: string, x: number, y: number): void {
    this.requireGraph().pinNode(nodeId, x, y);
  }

  unpinNode(nodeId: string): void {
    this.requireGraph().unpinNode(nodeId);
  }

  layoutReset(seed?: number): void {
    this.requireGraph().layoutReset(seed);
  }

  // -- internals ------------------------------------------------------------

  private requireAddon(): BrainDumpCoreAddon {
    if (!this.load.ok) throw new Error(this.load.reason);
    return this.load.addon;
  }

  private requireGraph(): NativeGraph {
    this.requireAddon();
    if (!this.graph) {
      throw new Error('No vault is open. Create or open a vault first.');
    }
    return this.graph;
  }

  private installGraph(graph: KnowledgeGraph): void {
    const addon = this.requireAddon();
    try {
      this.graph = addon.graphFromJSON(JSON.stringify(graph));
    } catch (error: unknown) {
      throw new Error(`Native core rejected the graph document: ${errorMessage(error)}`);
    }
    this.cellOrder = [...graph.cells]
      .sort((left, right) => left.order - right.order)
      .map((cell) => cell.id);
  }

  private logCoverageRepair(repair: CellCoverageRepair, boundary: string): void {
    if (!repair.changed) return;
    log.warn('repaired node cell coverage', {
      boundary,
      addedCells: repair.addedCellCount,
      repairedNodes: repair.repairedNodeIds.length,
      removedDanglingCellRefs: repair.removedDanglingCellRefs,
    });
  }

  private safeCoreVersion(addon: BrainDumpCoreAddon): string {
    try {
      return addon.version();
    } catch {
      return 'unknown';
    }
  }
}

/**
 * Reorder + renumber `cells` to match `order`. Returns a new document; the
 * input is never mutated.
 */
export function applyCellOrder(
  graph: KnowledgeGraph,
  order: readonly string[],
): KnowledgeGraph {
  if (order.length === 0) return graph;

  const byId = new Map(graph.cells.map((cell) => [cell.id, cell] as const));
  const ordered: Cell[] = [];

  for (const id of order) {
    const cell = byId.get(id);
    if (cell) {
      ordered.push(cell);
      byId.delete(id);
    }
  }
  for (const cell of graph.cells) {
    if (byId.has(cell.id)) ordered.push(cell);
  }

  return {
    ...graph,
    cells: ordered.map((cell, index) => (cell.order === index ? cell : { ...cell, order: index })),
  };
}
