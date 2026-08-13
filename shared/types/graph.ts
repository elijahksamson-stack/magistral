/**
 * BrainDump canonical graph model — CONTRACT.
 *
 * This file is the single source of truth for the shape of a knowledge graph.
 * It is mirrored exactly by:
 *   - shared/schema/graph.schema.json  (validation)
 *   - core/include/braindump/graph.hpp (C++ struct layout)
 *   - core/src/serialize.cpp           (canonical JSON writer)
 *
 * Any change here is a breaking change to the .json export format and MUST
 * bump SCHEMA_VERSION and ship a migration.
 */

export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** What a node represents. Drives glyph + default colour in the graph pane. */
export type NodeKind =
  | 'concept' // an abstract idea: "binding constraint"
  | 'entity' // a real thing: a company, person, place
  | 'claim' // an assertion that could be true or false
  | 'question' // an open unknown the author wants to resolve
  | 'source' // a citation, document, or reference
  | 'metric' // a measurable quantity
  /**
   * A container, not a claim. Encloses other nodes on the canvas so the author
   * can say "these belong together" without asserting a relation between every
   * pair. The only kind not created by writing a [[wikilink]].
   */
  | 'group';

export const NODE_KINDS: readonly NodeKind[] = [
  'concept',
  'entity',
  'claim',
  'question',
  'source',
  'metric',
  'group',
] as const;

/** How two nodes relate. Drives edge styling and graph algorithms. */
export type RelationKind =
  | 'relates_to' // untyped association (default for [[wikilinks]])
  | 'causes'
  | 'part_of'
  | 'contradicts'
  | 'supports'
  | 'depends_on'
  | 'instance_of'
  | 'mentions' // a cell mentioned this node
  | 'affects' // influences without necessarily causing outright
  | 'affected_by'; // the inverse, so the claim can be stated from either side

export const RELATION_KINDS: readonly RelationKind[] = [
  'relates_to',
  'causes',
  'part_of',
  'contradicts',
  'supports',
  'depends_on',
  'instance_of',
  'mentions',
  'affects',
  'affected_by',
] as const;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** One editable block in the Editor pane. Each cell carries its own ✦ button. */
export interface Cell {
  id: string;
  /** Position in the document. Contiguous, 0-based, no gaps. */
  order: number;
  markdown: string;
  /**
   * Claude CLI session id for this cell, so follow-up ✦ actions resume rather
   * than restart. Absent until the first ✦ invocation completes.
   */
  claudeSessionId?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface GraphNode {
  id: string;
  /** Display text, as authored. */
  label: string;
  /**
   * Lowercased, whitespace-collapsed, punctuation-stripped form of `label`.
   * This is the dedup key — two nodes with the same normalizedLabel are the
   * same node and MUST be merged by the C++ core.
   */
  normalizedLabel: string;
  kind: NodeKind;
  /** Cells that reference this node. Drives editor<->graph selection sync. */
  cellIds: string[];
  x: number;
  y: number;
  /** When true, the layout must not move this node. */
  pinned: boolean;
  /** Computed by the core. Number of incident edges. */
  degree: number;
  /** Computed by the core. PageRank, normalized 0..1. Drives node radius. */
  centrality: number;
  /** Computed by the core. Louvain community id. Drives node colour. */
  cluster: number;
  /** Author override. When set, wins over the cluster-derived colour. */
  color?: string;
  note?: string;
  /**
   * The cell's [[links]] after the first one.
   *
   * ONE CELL PRODUCES ONE NODE: the first link names it, and everything after
   * is detail recorded here and revealed when the reader clicks the node.
   * Labels rather than node ids — these are facets of this concept, not
   * concepts in their own right.
   *
   * Absent on nodes written before sub-concepts existed, and on any cell with
   * a single link.
   */
  subConcepts?: SubConcept[];
  /**
   * The group node this one sits inside, or absent.
   *
   * Membership lives on the MEMBER rather than as a list on the group, so
   * "a node belongs to at most one group" is structural rather than a rule
   * every writer has to remember.
   */
  groupId?: string;
}

/**
 * A facet of a concept: a later [[link]] in the same cell, with the line it
 * appeared on.
 *
 * The note is what makes an export worth reading. A bare list of labels says
 * what was mentioned; the note says what the author claimed about it.
 */
export interface SubConcept {
  label: string;
  /** Absent when the line carried nothing beyond the link itself. */
  note?: string;
}

export interface GraphEdge {
  id: string;
  /** GraphNode.id */
  source: string;
  /** GraphNode.id */
  target: string;
  relation: RelationKind;
  /** Strength, > 0. Repeated assertions of the same relation increment this. */
  weight: number;
  directed: boolean;
  /**
   * The author's description of what this relationship actually is.
   *
   * The relation kind says "affects"; only prose can say how, under what
   * conditions, and how sure the author is. Capped at MAX_EDGE_NOTE_LENGTH.
   */
  note?: string;
}

/** Ceiling on an edge's description. Mirrors kMaxEdgeNoteLength in the core. */
export const MAX_EDGE_NOTE_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Layout + view
// ---------------------------------------------------------------------------

export interface LayoutParams {
  /** Coulomb repulsion coefficient between all node pairs. */
  repulsion: number;
  /** Hooke attraction coefficient along edges. */
  attraction: number;
  /** Pull toward origin, keeps disconnected components on screen. */
  gravity: number;
  /** Velocity decay per tick, 0..1. */
  damping: number;
  /** Barnes-Hut opening angle. Lower = more accurate, slower. 0.5 is standard. */
  theta: number;
  /** Rest length of an edge at weight 1. */
  linkDistance: number;
}

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  repulsion: 6000,
  attraction: 0.05,
  gravity: 0.02,
  damping: 0.85,
  theta: 0.5,
  linkDistance: 120,
};

export interface LayoutConfig {
  kind: 'force';
  params: LayoutParams;
}

export interface GraphView {
  zoom: number;
  panX: number;
  panY: number;
  layout: LayoutConfig;
}

export const DEFAULT_VIEW: GraphView = {
  zoom: 1,
  panX: 0,
  panY: 0,
  layout: { kind: 'force', params: DEFAULT_LAYOUT_PARAMS },
};

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** The complete .json export payload. */
export interface KnowledgeGraph {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cells: Cell[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  view: GraphView;
}

// ---------------------------------------------------------------------------
// Extraction — the payload the core's mergeExtraction accepts.
//
// The ✦ Extract Concepts action that produced it is gone; "Complete the map"
// replaced it. The type stays because the core API does.
// ---------------------------------------------------------------------------

/**
 * Claude returns labels, not ids — it cannot know our ids. The C++ core
 * resolves labels to existing nodes via normalizedLabel, creating only what is
 * genuinely new. This is why extraction is idempotent: running it twice on the
 * same cell adds nothing the second time.
 */
export interface ExtractionNode {
  label: string;
  kind: NodeKind;
  note?: string;
}

export interface ExtractionEdge {
  /** Label of the source node, matched by normalizedLabel. */
  source: string;
  /** Label of the target node, matched by normalizedLabel. */
  target: string;
  relation: RelationKind;
  weight?: number;
}

export interface ExtractionResult {
  nodes: ExtractionNode[];
  edges: ExtractionEdge[];
}

/** What the core reports back after merging an ExtractionResult. */
export interface MergeReport {
  nodesAdded: number;
  nodesMerged: number;
  edgesAdded: number;
  edgesMerged: number;
  /** Ids of every node touched, so the UI can flash them. */
  affectedNodeIds: string[];
}

/** What the core reports after re-parsing a cell's [[wikilinks]]. */
export interface LinkSyncReport {
  /** Nodes newly created by a bracketed link. */
  createdNodeIds: string[];
  /** Nodes that lost their last reference from this cell. */
  orphanedNodeIds: string[];
  /** Nodes this cell now references. */
  linkedNodeIds: string[];
}

export interface SearchHit {
  nodeId: string;
  label: string;
  /** 0..1 relevance. */
  score: number;
}
