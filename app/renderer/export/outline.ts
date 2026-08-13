/**
 * The knowledge-only projection of a graph, as a flat normalized document.
 *
 * The canonical export (shared/schema/graph.schema.json) exists to round-trip a
 * vault, so it carries everything needed to reconstruct one — node coordinates,
 * pin flags, cluster ids, zoom, and the layout's repulsion/damping/theta. That
 * is the right content for a save file and the wrong content for a human or an
 * LLM reading the graph: `"damping": 0.85` says nothing about what the author
 * thinks, and it buries the part that does.
 *
 * This projection keeps only meaning, and states each fact exactly once. It
 * used to nest concepts into a tree, which forced two bad choices on any graph
 * that is not one: either re-expand a concept once per path that reaches it, or
 * emit a placeholder and make the reader hunt for the real entry. The first is
 * what shipped, and the number of simple paths through a cross-linked graph
 * grows factorially — a 45-node, 175-edge vault produced 6.1M expansions and
 * exhausted the renderer heap on export.
 *
 * So there is no traversal here at all. Nodes and relationships are two flat
 * tables keyed by the ids the core already assigns, relationships name their
 * endpoints by id, and prose lives in its own tables keyed by a note id. A
 * cycle is not a special case because nothing recurses; cost is O(nodes +
 * edges) whatever the shape. Nothing here is reversible, by design — the vault
 * file on disk is what round-trips a graph.
 */

import type {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  NodeKind,
  RelationKind,
} from '../../../shared/types/graph';
import { describeConcept } from './describe';

/**
 * Bumped when the shape below changes in a way a reader would notice. Distinct
 * from the vault's SCHEMA_VERSION: this document is an export, not a save file,
 * and the two version on entirely different schedules.
 */
export const MAP_FORMAT_VERSION = 1;

/** A facet of a concept. Its `note` is a key into `notes`, not the prose. */
export interface MapSubConcept {
  name: string;
  note?: string;
}

export interface MapNode {
  name: string;
  kind: NodeKind;
  /** The group node this one sits in, by id. Absent when it is in none. */
  group?: string;
  /** Key into `notes`. Absent when the author never described this concept. */
  note?: string;
  subConcepts?: MapSubConcept[];
}

export interface MapRelationship {
  /** Source node id. Never an embedded node — endpoints are references. */
  from: string;
  /** Target node id. */
  to: string;
  relation: RelationKind;
  directed: boolean;
  weight: number;
  /** Key into `relationshipNotes`. Absent when the edge carries no prose. */
  note?: string;
}

/** Prose about a node or one of its sub-concepts, stored once. */
export interface MapNote {
  /** The node id this prose belongs to. */
  owner: string;
  body: string;
}

/** Prose about a relationship, stored once. */
export interface MapRelationshipNote {
  /** The relationship id this prose belongs to. */
  relationship: string;
  body: string;
}

export interface KnowledgeMapDocument {
  formatVersion: number;
  name: string;
  exportedAt: string;
  /** Number of records in `nodes`. */
  nodeCount: number;
  /** Number of records in `relationships` — edges with a missing endpoint are
   * dropped, so this is not always `graph.edges.length`. */
  relationshipCount: number;
  nodes: Record<string, MapNode>;
  notes: Record<string, MapNote>;
  relationships: Record<string, MapRelationship>;
  relationshipNotes: Record<string, MapRelationshipNote>;
}

// ---------------------------------------------------------------------------
// Ordering
//
// The same graph and timestamp must produce byte-identical output, so every
// table is built in a defined order. Ids are compared as plain strings rather
// than through `localeCompare`, whose result depends on the host locale.
// ---------------------------------------------------------------------------

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function byNameThenId(left: GraphNode, right: GraphNode): number {
  return left.label.localeCompare(right.label) || compareIds(left.id, right.id);
}

function byEndpointsThenId(left: GraphEdge, right: GraphEdge): number {
  return (
    compareIds(left.source, right.source) ||
    compareIds(left.relation, right.relation) ||
    compareIds(left.target, right.target) ||
    compareIds(left.id, right.id)
  );
}

// ---------------------------------------------------------------------------
// Note ids
// ---------------------------------------------------------------------------

/** The description the author wrote about the node itself. */
function noteIdForNode(nodeId: string): string {
  return `note-${nodeId}`;
}

function noteIdForRelationship(edgeId: string): string {
  return `relationship-note-${edgeId}`;
}

/**
 * Collects prose into `notes`, one record per distinct body per owner.
 *
 * A concept whose sub-concepts repeat the same line — common when one sentence
 * introduces several facets at once — gets that line stored once and referenced
 * from each facet.
 */
class NoteTable {
  readonly records: Record<string, MapNote> = {};
  /** owner -> trimmed body -> note id, so a repeat resolves to the first id. */
  private readonly idsByOwner = new Map<string, Map<string, string>>();
  private contextCount = 0;

  /** Returns the note id, or undefined when there is nothing to store. */
  add(owner: string, body: string, preferredId?: string): string | undefined {
    const trimmed = body.trim();
    if (trimmed.length === 0) return undefined;

    let byBody = this.idsByOwner.get(owner);
    if (!byBody) {
      byBody = new Map<string, string>();
      this.idsByOwner.set(owner, byBody);
    }

    const existing = byBody.get(trimmed);
    if (existing !== undefined) return existing;

    // Counter rather than a hash: ids are read by people, and the caller walks
    // nodes in sorted order, so the numbering is stable for a given graph.
    const id = preferredId ?? `context-note-${(this.contextCount += 1)}`;
    byBody.set(trimmed, id);
    this.records[id] = { owner, body: trimmed };
    return id;
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export function buildKnowledgeMap(
  graph: KnowledgeGraph,
  exportedAt: string,
): KnowledgeMapDocument {
  const markdownByCellId = new Map(graph.cells.map((cell) => [cell.id, cell.markdown] as const));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  const nodes: Record<string, MapNode> = {};
  const noteTable = new NoteTable();

  for (const node of [...graph.nodes].sort(byNameThenId)) {
    const entry: MapNode = { name: node.label, kind: node.kind };

    // By id, not by name: a group is a node, and names are not identity.
    // Dropped when it points at a group that is not in this export, so every
    // reference in the document resolves.
    if (node.groupId && nodeIds.has(node.groupId)) entry.group = node.groupId;

    const description = noteTable.add(
      node.id,
      describeConcept(node, markdownByCellId),
      noteIdForNode(node.id),
    );
    if (description !== undefined) entry.note = description;

    // Sub-concepts are facets of this node, not nodes in their own right, so
    // they stay nested here. Only their prose is lifted out.
    const subConcepts = (node.subConcepts ?? []).map((sub) => {
      const facet: MapSubConcept = { name: sub.label };
      const noteId = noteTable.add(node.id, sub.note ?? '');
      if (noteId !== undefined) facet.note = noteId;
      return facet;
    });
    if (subConcepts.length > 0) entry.subConcepts = subConcepts;

    nodes[node.id] = entry;
  }

  const relationships: Record<string, MapRelationship> = {};
  const relationshipNotes: Record<string, MapRelationshipNote> = {};

  const connected = graph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );

  for (const edge of [...connected].sort(byEndpointsThenId)) {
    const entry: MapRelationship = {
      from: edge.source,
      to: edge.target,
      relation: edge.relation,
      directed: edge.directed,
      weight: edge.weight,
    };

    const body = edge.note?.trim() ?? '';
    if (body.length > 0) {
      const noteId = noteIdForRelationship(edge.id);
      entry.note = noteId;
      relationshipNotes[noteId] = { relationship: edge.id, body };
    }

    relationships[edge.id] = entry;
  }

  return {
    formatVersion: MAP_FORMAT_VERSION,
    name: graph.name,
    exportedAt,
    nodeCount: Object.keys(nodes).length,
    relationshipCount: Object.keys(relationships).length,
    nodes,
    notes: noteTable.records,
    relationships,
    relationshipNotes,
  };
}
