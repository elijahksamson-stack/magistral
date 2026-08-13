/**
 * Endpoint-level relationship classification.
 *
 * GraphNode.kind describes meaning (claim, metric, entity...). This module
 * describes hierarchy: a concept is a subnode when any authored parent names
 * it as a sub-concept, even after that facet has been materialized for an edge.
 */

import { normalizeLabel } from '../../../shared/labels';
import {
  CONNECTION_SCOPES,
  type ConnectionScope,
} from '../../../shared/types/completion';
import type { GraphEdge, GraphNode } from '../../../shared/types/graph';
import { virtualSubNodeId } from './expansion';

export type ConnectionEndpointKind = 'group' | 'node' | 'subnode';

export type { ConnectionScope } from '../../../shared/types/completion';

export { CONNECTION_SCOPES } from '../../../shared/types/completion';

export const CONNECTION_SCOPE_LABELS: Record<ConnectionScope, string> = {
  all: 'All levels',
  'node-node': 'Node ↔ Node',
  'node-subnode': 'Node ↔ Subnode',
  'subnode-subnode': 'Subnode ↔ Subnode',
  'group-node': 'Group ↔ Node',
  'group-subnode': 'Group ↔ Subnode',
  'group-group': 'Group ↔ Group',
};

export interface ConnectionEndpoint {
  readonly id: string;
  readonly label: string;
  readonly kind: ConnectionEndpointKind;
  readonly parentIds: readonly string[];
  readonly parentLabels: readonly string[];
  readonly note?: string;
  readonly isVirtual: boolean;
}

interface FacetRecord {
  label: string;
  note?: string;
  parentIds: string[];
  parentLabels: string[];
}

const KIND_ORDER: Record<ConnectionEndpointKind, number> = {
  group: 0,
  node: 1,
  subnode: 2,
};

/** Every persisted node and every authored, view-only subnode in the map. */
export function buildConnectionEndpoints(nodes: readonly GraphNode[]): ConnectionEndpoint[] {
  const nodeByLabel = new Map<string, GraphNode>();
  for (const node of nodes) {
    const key = normalizeLabel(node.label);
    if (key && !nodeByLabel.has(key)) nodeByLabel.set(key, node);
  }

  const facets = new Map<string, FacetRecord>();
  for (const parent of nodes) {
    if (parent.kind === 'group') continue;
    for (const subnode of parent.subConcepts ?? []) {
      const key = normalizeLabel(subnode.label);
      if (!key || key === normalizeLabel(parent.label)) continue;
      const current = facets.get(key);
      if (current) {
        if (!current.parentIds.includes(parent.id)) {
          current.parentIds.push(parent.id);
          current.parentLabels.push(parent.label);
        }
      } else {
        facets.set(key, {
          label: subnode.label.trim(),
          ...(subnode.note?.trim() ? { note: subnode.note.trim() } : {}),
          parentIds: [parent.id],
          parentLabels: [parent.label],
        });
      }
    }
  }

  const endpoints: ConnectionEndpoint[] = nodes.map((node) => {
    const facet = facets.get(normalizeLabel(node.label));
    const kind: ConnectionEndpointKind =
      node.kind === 'group' ? 'group' : facet ? 'subnode' : 'node';
    return {
      id: node.id,
      label: node.label,
      kind,
      parentIds: facet?.parentIds ?? [],
      parentLabels: facet?.parentLabels ?? [],
      ...((node.note ?? facet?.note) ? { note: node.note ?? facet?.note } : {}),
      isVirtual: false,
    };
  });

  for (const [key, facet] of facets) {
    if (nodeByLabel.has(key)) continue;
    endpoints.push({
      id: virtualSubNodeId(key),
      label: facet.label,
      kind: 'subnode',
      parentIds: facet.parentIds,
      parentLabels: facet.parentLabels,
      ...(facet.note ? { note: facet.note } : {}),
      isVirtual: true,
    });
  }

  return endpoints.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label),
  );
}

/** Persisted children are storage endpoints, not additional top-level nodes. */
export function countTopLevelNodes(nodes: readonly GraphNode[]): number {
  const endpointById = new Map(
    buildConnectionEndpoints(nodes).map((endpoint) => [endpoint.id, endpoint] as const),
  );
  return nodes.filter((node) => endpointById.get(node.id)?.kind !== 'subnode').length;
}

export function connectionScopeFor(
  source: ConnectionEndpointKind,
  target: ConnectionEndpointKind,
): Exclude<ConnectionScope, 'all'> {
  if (source === target) return `${source}-${target}` as Exclude<ConnectionScope, 'all'>;
  const kinds = new Set([source, target]);
  if (kinds.has('group')) return kinds.has('subnode') ? 'group-subnode' : 'group-node';
  return 'node-subnode';
}

export function matchesConnectionScope(
  scope: ConnectionScope,
  source: ConnectionEndpointKind,
  target: ConnectionEndpointKind,
): boolean {
  return scope === 'all' || connectionScopeFor(source, target) === scope;
}

export function endpointKindsForScope(
  scope: ConnectionScope,
): ReadonlySet<ConnectionEndpointKind> {
  if (scope === 'all') return new Set(['group', 'node', 'subnode']);
  return new Set(scope.split('-') as ConnectionEndpointKind[]);
}

export function edgesForConnectionScope(
  edges: readonly GraphEdge[],
  endpointById: ReadonlyMap<string, ConnectionEndpoint>,
  scope: ConnectionScope,
): GraphEdge[] {
  if (scope === 'all') return [...edges];
  return edges.filter((edge) => {
    const source = endpointById.get(edge.source)?.kind ?? 'node';
    const target = endpointById.get(edge.target)?.kind ?? 'node';
    return matchesConnectionScope(scope, source, target);
  });
}

export function connectionScopeInstruction(scope: ConnectionScope): string {
  if (scope === 'all') {
    return 'Audit every connection level and return only high-value missing cross-connections.';
  }
  const label = CONNECTION_SCOPE_LABELS[scope];
  const crossParent = scope === 'subnode-subnode'
    ? ' Compare existing subnodes across every parent node, especially different parents; never limit the search to siblings under one node. Name each existing parent explicitly and do not create or promote nodes.'
    : '';
  return `Return only missing ${label} relationships.${crossParent}`;
}
