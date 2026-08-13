/**
 * Parsing and validating a "Complete the map" proposal.
 *
 * The schema already makes renaming and deleting inexpressible. This layer
 * enforces the rest, which the schema cannot: that a "new" concept really is
 * new, that every endpoint exists, that a group is a group. The model works in
 * labels and has no way to know what the graph already holds, so every one of
 * these is a mistake it can make in good faith.
 *
 * Nothing is dropped silently. Everything refused comes back in `rejected`
 * with a reason, because a proposal that quietly shrinks between what the
 * model wrote and what the author sees is worse than one that is openly wrong.
 */

import { normalizeLabel } from '../../../shared/labels';
import {
  MAX_PROPOSED_CHANGES,
  type ConnectionScope,
  type MapCompletion,
  type MapSnapshot,
  type RejectedChange,
  type ValidatedCompletion,
} from '../../../shared/types/completion';
import {
  NODE_KINDS,
  RELATION_KINDS,
  type NodeKind,
  type RelationKind,
} from '../../../shared/types/graph';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNodeKind(value: unknown): NodeKind {
  const kind = asString(value) as NodeKind;
  // A group is a container the author places deliberately; the model proposes
  // concepts, not containers.
  return NODE_KINDS.includes(kind) && kind !== 'group' ? kind : 'concept';
}

function asRelation(value: unknown): RelationKind | null {
  const relation = asString(value) as RelationKind;
  return RELATION_KINDS.includes(relation) ? relation : null;
}

/**
 * Pull a MapCompletion out of whatever the model returned.
 *
 * Tolerant of a markdown fence and of missing arrays: a proposal with only new
 * edges is perfectly valid, and failing the whole thing because `newNodes` was
 * omitted would throw away good work over a formatting detail.
 */
export function parseCompletion(text: string): { ok: true; value: MapCompletion } | { ok: false; reason: string } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();

  // The model sometimes prefaces JSON with a sentence; take the outermost object.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { ok: false, reason: 'no JSON object was found in the reply' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : 'unparseable JSON' };
  }

  const source = asRecord(parsed);
  const list = (key: string): unknown[] =>
    Array.isArray(source[key]) ? (source[key] as unknown[]) : [];

  return {
    ok: true,
    value: {
      newNodes: list('newNodes').map((entry) => {
        const record = asRecord(entry);
        const node = {
          label: asString(record.label),
          kind: asNodeKind(record.kind),
        } as MapCompletion['newNodes'][number];
        const note = asString(record.note);
        if (note) node.note = note;
        const group = asString(record.group);
        if (group) node.group = group;
        return node;
      }),
      newEdges: list('newEdges').map((entry) => {
        const record = asRecord(entry);
        return {
          source: asString(record.source),
          target: asString(record.target),
          ...(asString(record.sourceParent)
            ? { sourceParent: asString(record.sourceParent) }
            : {}),
          ...(asString(record.targetParent)
            ? { targetParent: asString(record.targetParent) }
            : {}),
          relation: asRelation(record.relation) ?? 'relates_to',
          ...(asString(record.note) ? { note: asString(record.note) } : {}),
        };
      }),
      edgeChanges: list('edgeChanges').map((entry) => {
        const record = asRecord(entry);
        return {
          source: asString(record.source),
          target: asString(record.target),
          ...(asString(record.sourceParent)
            ? { sourceParent: asString(record.sourceParent) }
            : {}),
          ...(asString(record.targetParent)
            ? { targetParent: asString(record.targetParent) }
            : {}),
          relation: asRelation(record.relation) ?? 'relates_to',
          ...(asString(record.note) ? { note: asString(record.note) } : {}),
          ...(asString(record.reason) ? { reason: asString(record.reason) } : {}),
        };
      }),
      groupAdditions: list('groupAdditions').map((entry) => {
        const record = asRecord(entry);
        return { node: asString(record.node), group: asString(record.group) };
      }),
      ...(asString(source.rationale) ? { rationale: asString(source.rationale) } : {}),
    },
  };
}

interface MapIndex {
  /** normalized label -> node */
  byLabel: Map<string, { label: string; kind: NodeKind }>;
  /** Facets remain qualified by their authored parent; they are never free-standing. */
  facetsByLabel: Map<string, Array<{ label: string; parentLabel: string }>>;
  /** normalized "source|target" pairs that already have an edge. */
  edgePairs: Set<string>;
}

function indexMap(map: MapSnapshot): MapIndex {
  const byLabel = new Map<string, { label: string; kind: NodeKind }>();
  const facetsByLabel = new Map<string, Array<{ label: string; parentLabel: string }>>();
  for (const node of map.nodes) {
    byLabel.set(normalizeLabel(node.label), { label: node.label, kind: node.kind });
    for (const label of node.subConcepts ?? []) {
      const key = normalizeLabel(label);
      if (!key) continue;
      const facets = facetsByLabel.get(key) ?? [];
      if (!facets.some((facet) => normalizeLabel(facet.parentLabel) === normalizeLabel(node.label))) {
        facets.push({ label, parentLabel: node.label });
        facetsByLabel.set(key, facets);
      }
    }
  }

  const edgePairs = new Set<string>();
  for (const edge of map.edges) {
    edgePairs.add(`${normalizeLabel(edge.source)}|${normalizeLabel(edge.target)}`);
  }
  return { byLabel, facetsByLabel, edgePairs };
}

type EndpointLevel = 'group' | 'node' | 'subnode';

interface ResolvedEndpoint {
  readonly label: string;
  readonly level: EndpointLevel;
  readonly parent?: string;
}

function resolveEndpoint(
  index: MapIndex,
  admitted: ReadonlyMap<string, { label: string; kind: NodeKind }>,
  label: string,
  requestedParent?: string,
): ResolvedEndpoint | null {
  const key = normalizeLabel(label);
  if (requestedParent) {
    const parentKey = normalizeLabel(requestedParent);
    const facet = (index.facetsByLabel.get(key) ?? []).find(
      (candidate) => normalizeLabel(candidate.parentLabel) === parentKey,
    );
    return facet
      ? { label: facet.label, level: 'subnode', parent: facet.parentLabel }
      : null;
  }

  const node = admitted.get(key);
  if (node) return { label: node.label, level: node.kind === 'group' ? 'group' : 'node' };

  const facets = index.facetsByLabel.get(key) ?? [];
  if (facets.length !== 1) return null;
  const facet = facets[0] as { label: string; parentLabel: string };
  return { label: facet.label, level: 'subnode', parent: facet.parentLabel };
}

function scopeForEndpoints(source: EndpointLevel, target: EndpointLevel): Exclude<ConnectionScope, 'all'> {
  if (source === target) return `${source}-${target}` as Exclude<ConnectionScope, 'all'>;
  const levels = new Set([source, target]);
  if (levels.has('group')) return levels.has('subnode') ? 'group-subnode' : 'group-node';
  return 'node-subnode';
}

function matchesScope(
  scope: ConnectionScope,
  source: ResolvedEndpoint,
  target: ResolvedEndpoint,
): boolean {
  return scope === 'all' || scopeForEndpoints(source.level, target.level) === scope;
}

/**
 * Check a proposal against the map it will be applied to.
 *
 * The order matters: new concepts are admitted first, so a relationship
 * between two of them validates. A model that proposes a chain of new ideas
 * and the links between them is doing exactly what was asked.
 */
export function validateCompletion(
  completion: MapCompletion,
  map: MapSnapshot,
  scope: ConnectionScope = 'all',
): ValidatedCompletion {
  const index = indexMap(map);
  const rejected: RejectedChange[] = [];

  const total =
    completion.newNodes.length +
    completion.newEdges.length +
    completion.edgeChanges.length +
    completion.groupAdditions.length;
  const budget = { left: MAX_PROPOSED_CHANGES };
  if (total > MAX_PROPOSED_CHANGES) {
    rejected.push({
      kind: 'node',
      subject: `${total} changes proposed`,
      reason: `only the first ${MAX_PROPOSED_CHANGES} are shown — a review has to stay reviewable`,
    });
  }
  const take = (): boolean => budget.left-- > 0;

  // -- new concepts ---------------------------------------------------------

  const admitted = new Map(index.byLabel);
  const newNodes: MapCompletion['newNodes'] = [];

  for (const node of completion.newNodes) {
    if (!take()) break;
    const key = normalizeLabel(node.label);

    if (key.length === 0) {
      rejected.push({ kind: 'node', subject: node.label, reason: 'the label is empty' });
      continue;
    }
    if (scope !== 'all') {
      rejected.push({
        kind: 'node',
        subject: node.label,
        reason: `a ${scope} scan may only connect existing endpoints`,
      });
      continue;
    }
    if (index.facetsByLabel.has(key)) {
      const parents = (index.facetsByLabel.get(key) ?? []).map((facet) => facet.parentLabel);
      rejected.push({
        kind: 'node',
        subject: node.label,
        reason: `this already exists as a subnode under ${parents.join(' / ')} — it must remain nested`,
      });
      continue;
    }
    if (admitted.has(key)) {
      // Creating a concept that exists would be an EDIT of that concept, which
      // is the one thing this action must never do.
      rejected.push({
        kind: 'node',
        subject: node.label,
        reason: 'a concept with this name already exists — it may not be changed',
      });
      continue;
    }
    if (node.group) {
      const group = index.byLabel.get(normalizeLabel(node.group));
      if (!group || group.kind !== 'group') {
        rejected.push({
          kind: 'node',
          subject: node.label,
          reason: `no group named "${node.group}" — the concept was added without one`,
        });
        const { group: _dropped, ...withoutGroup } = node;
        admitted.set(key, { label: node.label, kind: node.kind });
        newNodes.push(withoutGroup);
        continue;
      }
    }
    admitted.set(key, { label: node.label, kind: node.kind });
    newNodes.push(node);
  }

  // -- new relationships ----------------------------------------------------

  const newEdges: MapCompletion['newEdges'] = [];
  const seenPairs = new Set(index.edgePairs);

  for (const edge of completion.newEdges) {
    if (!take()) break;
    const source = normalizeLabel(edge.source);
    const target = normalizeLabel(edge.target);
    const subject = `${edge.source} → ${edge.target}`;

    const sourceEndpoint = resolveEndpoint(index, admitted, edge.source, edge.sourceParent);
    const targetEndpoint = resolveEndpoint(index, admitted, edge.target, edge.targetParent);
    if (!sourceEndpoint || !targetEndpoint) {
      const missing = !sourceEndpoint ? edge.source : edge.target;
      rejected.push({
        kind: 'edge',
        subject,
        reason: `"${missing}" is not in the graph as an unambiguous existing endpoint; name its parent when it is a subnode`,
      });
      continue;
    }
    if (source === target) {
      rejected.push({ kind: 'edge', subject, reason: 'a concept cannot relate to itself' });
      continue;
    }
    if (seenPairs.has(`${source}|${target}`)) {
      rejected.push({ kind: 'edge', subject, reason: 'these are already connected' });
      continue;
    }
    if (!matchesScope(scope, sourceEndpoint, targetEndpoint)) {
      rejected.push({
        kind: 'edge',
        subject,
        reason: `this is ${scopeForEndpoints(sourceEndpoint.level, targetEndpoint.level)}, not ${scope}`,
      });
      continue;
    }
    seenPairs.add(`${source}|${target}`);
    newEdges.push({
      ...edge,
      source: sourceEndpoint.label,
      target: targetEndpoint.label,
      ...(sourceEndpoint.parent ? { sourceParent: sourceEndpoint.parent } : {}),
      ...(targetEndpoint.parent ? { targetParent: targetEndpoint.parent } : {}),
    });
  }

  // -- retyped relationships ------------------------------------------------

  const edgeChanges: MapCompletion['edgeChanges'] = [];

  for (const change of completion.edgeChanges) {
    if (!take()) break;
    const source = normalizeLabel(change.source);
    const target = normalizeLabel(change.target);
    const subject = `${change.source} → ${change.target}`;
    const sourceEndpoint = resolveEndpoint(index, admitted, change.source, change.sourceParent);
    const targetEndpoint = resolveEndpoint(index, admitted, change.target, change.targetParent);

    if (!sourceEndpoint || !targetEndpoint || !matchesScope(scope, sourceEndpoint, targetEndpoint)) {
      rejected.push({ kind: 'edge-change', subject, reason: `this relationship is outside the ${scope} scan` });
      continue;
    }

    // Only an edge that ALREADY exists can be changed. Otherwise this is a
    // create wearing a change's clothes, and it would bypass the duplicate
    // check above.
    if (!index.edgePairs.has(`${source}|${target}`)) {
      rejected.push({ kind: 'edge-change', subject, reason: 'no such relationship to change' });
      continue;
    }
    edgeChanges.push({
      ...change,
      ...(sourceEndpoint.parent ? { sourceParent: sourceEndpoint.parent } : {}),
      ...(targetEndpoint.parent ? { targetParent: targetEndpoint.parent } : {}),
    });
  }

  // -- group membership -----------------------------------------------------

  const groupAdditions: MapCompletion['groupAdditions'] = [];

  for (const grouping of completion.groupAdditions) {
    if (!take()) break;
    const subject = `${grouping.node} → ${grouping.group}`;
    const group = index.byLabel.get(normalizeLabel(grouping.group));

    if (scope !== 'all') {
      rejected.push({ kind: 'grouping', subject, reason: `group membership is outside a ${scope} scan` });
      continue;
    }

    const nodeKey = normalizeLabel(grouping.node);
    if (!admitted.has(nodeKey)) {
      rejected.push({ kind: 'grouping', subject, reason: `"${grouping.node}" is not in the graph` });
      continue;
    }
    if (!group || group.kind !== 'group') {
      rejected.push({ kind: 'grouping', subject, reason: `"${grouping.group}" is not a group` });
      continue;
    }
    const node = admitted.get(nodeKey);
    if (!node) continue;
    if (node.kind === 'group') {
      rejected.push({ kind: 'grouping', subject, reason: 'a group cannot go inside a group' });
      continue;
    }
    groupAdditions.push(grouping);
  }

  return {
    accepted: {
      newNodes,
      newEdges,
      edgeChanges,
      groupAdditions,
      ...(completion.rationale ? { rationale: completion.rationale } : {}),
    },
    rejected,
  };
}

/** Total changes in a proposal, for the review header. */
export function countChanges(completion: MapCompletion): number {
  return (
    completion.newNodes.length +
    completion.newEdges.length +
    completion.edgeChanges.length +
    completion.groupAdditions.length
  );
}
