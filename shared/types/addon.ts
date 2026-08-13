/**
 * Native C++ addon surface — CONTRACT.
 *
 * Implemented by: bindings/napi/addon.cpp   (agent 2)
 *                 over core/                (agent 1)
 * Consumed by:    app/main/, app/renderer/graph/
 *
 * DESIGN NOTE — why positions come back as a Float64Array and ids do not:
 * The layout ticks at 60fps. Marshalling N id strings across the N-API boundary
 * every frame would dominate the frame budget and defeat the point of writing
 * the layout in C++ at all. So node identity is fetched ONCE via nodeOrder(),
 * cached by the renderer, and re-fetched only when topologyVersion changes.
 * Each tick then returns a flat [x0,y0,x1,y1,...] buffer aligned to that order.
 */

import type {
  ExtractionResult,
  KnowledgeGraph,
  LayoutParams,
  LinkSyncReport,
  MergeReport,
  NodeKind,
  RelationKind,
  SearchHit,
} from './graph';

/** One frame of the force simulation. */
export interface LayoutFrame {
  /**
   * Flat [x0, y0, x1, y1, ...] aligned to the most recent nodeOrder().
   * Length is always nodeCount() * 2.
   */
  positions: Float64Array;
  /** Total kinetic energy. Monotonically decreasing as the layout settles. */
  energy: number;
  /** True once energy falls below the convergence threshold. */
  converged: boolean;
  /** Ticks actually executed this call. */
  iterations: number;
}

export interface NativeGraph {
  // -- lifecycle ------------------------------------------------------------

  /** Canonical, deterministic JSON. Byte-identical for identical graphs. */
  toJSON(pretty?: boolean): string;

  /**
   * Rename the graph.
   *
   * The core owns the name, so renaming only the vault file on disk is
   * immediately undone by the next snapshot — and then written back over the
   * file on the next save. Renaming has to start here.
   */
  setName(name: string): void;

  // -- topology -------------------------------------------------------------

  /**
   * Increments on every structural change (node/edge add or remove).
   * The renderer re-reads nodeOrder() only when this changes.
   */
  topologyVersion(): number;
  /** Stable node ordering. Index i here maps to positions[i*2], positions[i*2+1]. */
  nodeOrder(): string[];
  nodeCount(): number;
  edgeCount(): number;

  /** Returns the id of the new OR existing node (dedup by normalized label). */
  addNode(label: string, kind: NodeKind): string;
  removeNode(id: string): boolean;
  addEdge(
    sourceId: string,
    targetId: string,
    relation: RelationKind,
    weight?: number,
  ): string;
  removeEdge(id: string): boolean;
  /** Describe what a relationship actually is. Clipped, never rejected. */
  setEdgeNote(edgeId: string, note: string): void;
  /**
   * Describe what a concept is. Clipped, never rejected.
   *
   * Cell-derived nodes take their note from the [[wikilink]] line. This is for
   * the ones no cell wrote: groups, and concepts accepted from a proposal.
   */
  setNodeNote(nodeId: string, note: string): void;

  // -- grouping -------------------------------------------------------------

  /** Rename a node. Throws if the new label collides with another node. */
  setNodeLabel(nodeId: string, label: string): void;
  /** Put a node in a group, or pass an empty groupId to take it out. */
  setNodeGroup(nodeId: string, groupId: string): void;
  /** Ids of the nodes inside a group. */
  groupMembers(groupId: string): string[];

  // -- authoring ------------------------------------------------------------

  /**
   * Re-parse a cell's [[wikilinks]] and reconcile the graph to match.
   * This is the ONLY automatic node-creation path — it fires on explicit
   * bracketed text the author typed, never on inference.
   */
  syncCell(cellId: string, markdown: string): LinkSyncReport;
  removeCell(cellId: string): LinkSyncReport;

  /**
   * Merge a Claude extraction. Labels are resolved to existing nodes by
   * normalized label, so this is idempotent — running it twice on unchanged
   * text is a no-op.
   */
  mergeExtraction(cellId: string, result: ExtractionResult): MergeReport;

  // -- layout ---------------------------------------------------------------

  layoutConfigure(params: Partial<LayoutParams>): void;
  /** Advance the simulation. Default 1 iteration. */
  layoutTick(iterations?: number): LayoutFrame;
  /** Run to convergence or maxIterations, whichever comes first. */
  layoutSettle(maxIterations?: number): LayoutFrame;
  /** Freeze a node at a position (user drag). */
  pinNode(id: string, x: number, y: number): void;
  unpinNode(id: string): void;
  /** Scatter nodes and reset velocities. */
  layoutReset(seed?: number): void;

  // -- analysis -------------------------------------------------------------

  /** Recompute degree, PageRank centrality, and Louvain clusters. */
  computeMetrics(): void;
  /** Connected components, each an array of node ids. */
  components(): string[][];
  /** Empty array when unreachable. */
  shortestPath(fromId: string, toId: string): string[];
  /** Nodes that reference this one. */
  backlinks(nodeId: string): string[];
  search(query: string, limit?: number): SearchHit[];
}

export interface BrainDumpCoreAddon {
  /** Create an empty graph. */
  createGraph(name: string): NativeGraph;
  /** Parse a graph from canonical JSON. Throws on schema mismatch. */
  graphFromJSON(json: string): NativeGraph;
  /** Semver of the compiled core, for diagnostics. */
  version(): string;
  /** Schema version the core reads and writes. Must equal SCHEMA_VERSION. */
  schemaVersion(): number;
}

/**
 * Plain-object snapshot for the renderer. The native handle lives in the main
 * process; the renderer receives structured clones over IPC.
 */
export type GraphSnapshot = KnowledgeGraph;
