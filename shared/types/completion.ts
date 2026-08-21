/**
 * "Complete the map" — CONTRACT.
 *
 * A proposal from the model for how to extend the graph. The permissions are
 * enforced by this shape, not by asking politely:
 *
 *   MAY   create a concept, draw a relationship, retype or redescribe an
 *         existing relationship, put a concept in a group.
 *   MAY NOT rename a concept, delete a concept, delete a relationship,
 *         remove a concept from a group.
 *
 * There is no operation here that expresses the second list. That is the
 * point. A prompt saying "do not delete anything" is a request the model can
 * misread; a schema with no delete operation is a guarantee it cannot. The
 * validator then re-checks the rest — that a "new" concept really is new, that
 * every endpoint exists — because the model works in labels and cannot know
 * what the graph already holds.
 */

import type { NodeKind, RelationKind } from './graph';

/** The hierarchy level a reviewed connection scan is constrained to. */
export type ConnectionScope =
  | 'all'
  | 'node-node'
  | 'node-subnode'
  | 'subnode-subnode'
  | 'group-node'
  | 'group-subnode'
  | 'group-group';

export const CONNECTION_SCOPES: readonly ConnectionScope[] = [
  'all',
  'node-node',
  'node-subnode',
  'subnode-subnode',
  'group-node',
  'group-subnode',
  'group-group',
] as const;

// ---------------------------------------------------------------------------
// What the model is shown
// ---------------------------------------------------------------------------

/**
 * The graph as the model sees it: labels, not ids.
 *
 * Ids are an implementation detail the model has no way to reason about, and
 * showing them invites a proposal that references one which no longer exists.
 * Labels are what the author typed, what the canvas displays, and what a
 * proposal comes back in — so they are the only currency here.
 */
export interface MapNode {
  label: string;
  kind: NodeKind;
  /** What the author wrote about it on the line that named it. */
  note?: string;
  /** Label of the group it sits in, if any. */
  group?: string;
  /** Labels listed beneath it in its cell. */
  subConcepts?: string[];
}

export interface MapEdge {
  source: string;
  target: string;
  relation: RelationKind;
  note?: string;
}

export interface MapSnapshot {
  name: string;
  nodes: MapNode[];
  edges: MapEdge[];
}

/**
 * A facet proposed beneath a new concept.
 *
 * Distinct from a ProposedNode: this becomes a later `[[link]]` inside the new
 * concept's cell, not a concept of its own. The core derives it back out as a
 * sub-concept, exactly as if the author had typed the cell by hand.
 */
export interface ProposedSubConcept {
  label: string;
  note?: string;
}

/** A concept the graph does not have yet. */
export interface ProposedNode {
  label: string;
  kind: NodeKind;
  /** Why it belongs, in the model's words. Shown in review. */
  note?: string;
  /** Label of a group to place it in. Must already exist. */
  group?: string;
  /**
   * Facets to write beneath it, when the concept arrives with parts.
   *
   * Optional, and usually absent: a proposal that invents five sub-concepts for
   * every new node buries the author in structure they never asked for. It earns
   * its place when the parts are genuinely given — a folder with subdirectories,
   * or an answer that distinguishes facets of one idea.
   */
  subConcepts?: ProposedSubConcept[];
}

/** A relationship to draw between two concepts, by label. */
export interface ProposedEdge {
  source: string;
  target: string;
  /** Required when `source` is a nested subnode; identifies its existing owner. */
  sourceParent?: string;
  /** Required when `target` is a nested subnode; identifies its existing owner. */
  targetParent?: string;
  relation: RelationKind;
  /** What the relationship actually is. */
  note?: string;
}

/**
 * A change to a relationship that already exists.
 *
 * Identified by its endpoints rather than an id, since the model never sees
 * ids. Retyping and redescribing are allowed; removing is not, so there is no
 * field here that could ask for it.
 */
export interface ProposedEdgeChange {
  source: string;
  target: string;
  sourceParent?: string;
  targetParent?: string;
  /** The relation it should become. */
  relation: RelationKind;
  note?: string;
  /** Why the current relation is wrong. Shown in review. */
  reason?: string;
}

/** Putting an existing concept into an existing group. */
export interface ProposedGrouping {
  node: string;
  group: string;
}

export interface MapCompletion {
  newNodes: ProposedNode[];
  newEdges: ProposedEdge[];
  edgeChanges: ProposedEdgeChange[];
  groupAdditions: ProposedGrouping[];
  /** One paragraph on what the model thinks the map was missing. */
  rationale?: string;
}

export const EMPTY_COMPLETION: MapCompletion = {
  newNodes: [],
  newEdges: [],
  edgeChanges: [],
  groupAdditions: [],
};

/** Why one proposed change was dropped. Surfaced so nothing fails silently. */
export interface RejectedChange {
  kind: 'node' | 'edge' | 'edge-change' | 'grouping';
  subject: string;
  reason: string;
}

export interface ValidatedCompletion {
  accepted: MapCompletion;
  rejected: RejectedChange[];
}

/** How many changes one invocation may propose, so a review stays reviewable. */
export const MAX_PROPOSED_CHANGES = 60;
