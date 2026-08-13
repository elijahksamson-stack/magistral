/**
 * A proposal, flattened into the list the author actually reads.
 *
 * The validated completion arrives in four arrays by operation type, which is
 * the right shape to apply and the wrong shape to review: nobody wants to read
 * four sections and work out which edge belongs to which new concept. This
 * turns it into one ordered list where a concept is immediately followed by the
 * relationships that depend on it.
 *
 * Every item carries a stable key. Selection is per item — accepting a
 * proposal wholesale is the common case, but the whole point of a review is
 * being able to take four of six.
 */

import { normalizeLabel } from '../../../shared/labels';
import type { MapCompletion } from '../../../shared/types/completion';
import type { NodeKind, RelationKind } from '../../../shared/types/graph';
import { relationSentence } from '../shared/relations';

export type ProposalKind = 'node' | 'edge' | 'edge-change' | 'grouping';

export interface ProposalItem {
  /** Stable across re-renders and independent of list position. */
  readonly key: string;
  readonly kind: ProposalKind;
  /** The change in one line, e.g. "EUV affects Semis". */
  readonly title: string;
  /** What kind of thing it is, e.g. "new concept" or "was: relates to". */
  readonly detail: string;
  /** The model's reasoning. Absent when it did not give one. */
  readonly note?: string;
  /**
   * Keys this item cannot be applied without.
   *
   * An edge between two proposed concepts is meaningless if either is
   * unchecked, and applying it would fail at the graph. Recorded here so the
   * UI can uncheck dependents rather than let the author queue a change that
   * cannot land.
   */
  readonly requires: readonly string[];
}

export function nodeKey(label: string): string {
  return `node:${normalizeLabel(label)}`;
}

export function edgeKey(
  source: string,
  target: string,
  sourceParent?: string,
  targetParent?: string,
): string {
  return `edge:${normalizeLabel(sourceParent ?? '')}>${normalizeLabel(source)}|${normalizeLabel(targetParent ?? '')}>${normalizeLabel(target)}`;
}

export function edgeChangeKey(
  source: string,
  target: string,
  sourceParent?: string,
  targetParent?: string,
): string {
  return `edge-change:${normalizeLabel(sourceParent ?? '')}>${normalizeLabel(source)}|${normalizeLabel(targetParent ?? '')}>${normalizeLabel(target)}`;
}

export function groupingKey(node: string, group: string): string {
  return `grouping:${normalizeLabel(node)}|${normalizeLabel(group)}`;
}

const NODE_KIND_LABEL: Record<NodeKind, string> = {
  concept: 'new concept',
  entity: 'new entity',
  claim: 'new claim',
  question: 'new question',
  source: 'new source',
  metric: 'new metric',
  group: 'new group',
};

/**
 * Flatten a completion into review order.
 *
 * Concepts first, then the relationships between them, then retypes, then
 * grouping. That is the order the changes are applied in, and showing them in
 * a different order than they happen invites the author to expect otherwise.
 */
export function listProposals(
  completion: MapCompletion,
  existingSubnodeLabels: ReadonlySet<string> = new Set(),
): ProposalItem[] {
  const realNewNodes = completion.newNodes.filter(
    (node) => !existingSubnodeLabels.has(normalizeLabel(node.label)),
  );
  const proposedLabels = new Set(realNewNodes.map((node) => normalizeLabel(node.label)));

  /** An endpoint depends on a proposed concept only if this run creates it. */
  const dependenciesFor = (...labels: string[]): string[] =>
    labels.filter((label) => proposedLabels.has(normalizeLabel(label))).map(nodeKey);

  const nodes: ProposalItem[] = realNewNodes.map((node) => {
    const detail = node.group
      ? `${NODE_KIND_LABEL[node.kind]}, in "${node.group}"`
      : NODE_KIND_LABEL[node.kind];
    return {
      key: nodeKey(node.label),
      kind: 'node',
      title: node.label,
      detail,
      ...(node.note ? { note: node.note } : {}),
      requires: [],
    };
  });

  const edges: ProposalItem[] = completion.newEdges.map((edge) => ({
    key: edgeKey(edge.source, edge.target, edge.sourceParent, edge.targetParent),
    kind: 'edge',
    title: relationSentence(
      edge.sourceParent ? `${edge.sourceParent} › ${edge.source}` : edge.source,
      edge.relation,
      edge.targetParent ? `${edge.targetParent} › ${edge.target}` : edge.target,
    ),
    detail: edge.sourceParent || edge.targetParent
      ? 'new relationship between existing nested endpoints'
      : 'new relationship',
    ...(edge.note ? { note: edge.note } : {}),
    requires: dependenciesFor(edge.source, edge.target),
  }));

  const changes: ProposalItem[] = completion.edgeChanges.map((change) => ({
    key: edgeChangeKey(
      change.source,
      change.target,
      change.sourceParent,
      change.targetParent,
    ),
    kind: 'edge-change',
    title: relationSentence(change.source, change.relation, change.target),
    detail: 'retypes an existing relationship',
    ...(change.reason || change.note ? { note: change.reason ?? change.note } : {}),
    requires: [],
  }));

  const groupings: ProposalItem[] = completion.groupAdditions.map((grouping) => ({
    key: groupingKey(grouping.node, grouping.group),
    kind: 'grouping',
    title: `${grouping.node} → ${grouping.group}`,
    detail: 'moves into a group',
    requires: dependenciesFor(grouping.node),
  }));

  return [...nodes, ...edges, ...changes, ...groupings];
}

/** Every key, for the "select all" default. */
export function allKeys(items: readonly ProposalItem[]): Set<string> {
  return new Set(items.map((item) => item.key));
}

/**
 * Apply a checkbox toggle, honouring dependencies in both directions.
 *
 * Unchecking a concept unchecks the relationships that need it; checking a
 * relationship checks the concepts it needs. Either way the selection stays
 * one that can actually be applied, so the author never gets a failure report
 * for something the UI could have told them up front.
 */
export function toggleSelection(
  items: readonly ProposalItem[],
  selected: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(selected);
  const item = items.find((candidate) => candidate.key === key);
  if (!item) return next;

  if (next.has(key)) {
    next.delete(key);
    for (const dependent of items) {
      if (dependent.requires.includes(key)) next.delete(dependent.key);
    }
    return next;
  }

  next.add(key);
  for (const required of item.requires) next.add(required);
  return next;
}

export function countByKind(items: readonly ProposalItem[], selected: ReadonlySet<string>): {
  nodes: number;
  edges: number;
  changes: number;
  groupings: number;
} {
  const taken = items.filter((item) => selected.has(item.key));
  return {
    nodes: taken.filter((item) => item.kind === 'node').length,
    edges: taken.filter((item) => item.kind === 'edge').length,
    changes: taken.filter((item) => item.kind === 'edge-change').length,
    groupings: taken.filter((item) => item.kind === 'grouping').length,
  };
}

export type { RelationKind };
