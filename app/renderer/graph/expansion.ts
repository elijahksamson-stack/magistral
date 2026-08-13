/**
 * The two-neighbourhood expansion shown when concepts are clicked.
 *
 * Sub-concepts are facets in the canonical graph, not necessarily standalone
 * GraphNodes. This module therefore resolves facets that already have a real
 * node and creates stable, view-only nodes for the rest. Drawing an edge makes
 * the endpoint addressable while its authored parent remains authoritative.
 */

import { normalizeLabel } from '../../../shared/labels';
import type { GraphNode, SubConcept } from '../../../shared/types/graph';
import type { Point } from './viewport';

export const MAX_EXPANDED = 2;

const VIRTUAL_ID_PREFIX = 'view:sub-concept:';
const SUBNODE_RING_SIZE = 8;
const SUBNODE_ORBIT_WORLD = 64;
const SUBNODE_RING_GAP_WORLD = 42;

export interface ExpansionLink {
  readonly sourceId: string;
  readonly targetId: string;
}

export interface VirtualSubNode {
  readonly node: GraphNode;
  readonly parentIds: readonly string[];
}

export interface Expansion {
  /** Expanded concepts, primary first and optional comparison second. */
  readonly expandedIds: readonly string[];
  /** Expanded concepts plus every resolved or view-only sub-concept. */
  readonly exposedIds: ReadonlySet<string>;
  /** Facets which do not yet have a persisted GraphNode. */
  readonly virtualNodes: readonly GraphNode[];
  readonly virtualNodeById: ReadonlyMap<string, VirtualSubNode>;
  /** Visual parent-to-facet ties. These are not authored graph edges. */
  readonly links: readonly ExpansionLink[];
}

export const NO_EXPANSION: Expansion = {
  expandedIds: [],
  exposedIds: new Set(),
  virtualNodes: [],
  virtualNodeById: new Map(),
  links: [],
};

interface FacetOwner {
  readonly parent: GraphNode;
  readonly slot: number;
  readonly total: number;
}

interface PendingFacet {
  readonly key: string;
  readonly subConcept: SubConcept;
  readonly owners: FacetOwner[];
}

export interface ExpansionOptions {
  /** Live layout position. Snapshot x/y is used when omitted. */
  readonly positionOf?: (node: GraphNode) => Point;
}

/** Label -> node id, normalized so casing and spacing cannot split a match. */
export function buildLabelIndex(nodes: readonly GraphNode[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    const key = normalizeLabel(node.label);
    if (key && !index.has(key)) index.set(key, node.id);
  }
  return index;
}

/** Stable across parents so a shared unresolved facet is drawn only once. */
export function virtualSubNodeId(normalizedLabel: string): string {
  return `${VIRTUAL_ID_PREFIX}${encodeURIComponent(normalizedLabel)}`;
}

export function isVirtualSubNodeId(nodeId: string): boolean {
  return nodeId.startsWith(VIRTUAL_ID_PREFIX);
}

/**
 * Keep one primary concept and, at most, one comparison concept.
 *
 * Once both slots are occupied, another click replaces the comparison while
 * the primary stays anchored. Clicking an open concept closes that slot.
 */
export function toggleExpanded(expandedIds: readonly string[], nodeId: string): string[] {
  if (expandedIds.includes(nodeId)) return expandedIds.filter((id) => id !== nodeId);
  if (expandedIds.length < MAX_EXPANDED) return [...expandedIds, nodeId];
  return [expandedIds[0] as string, nodeId];
}

function pointOf(node: GraphNode, options: ExpansionOptions): Point {
  return options.positionOf?.(node) ?? { x: node.x, y: node.y };
}

function orbitalPosition(owner: FacetOwner, options: ExpansionOptions): Point {
  const centre = pointOf(owner.parent, options);
  const ring = Math.floor(owner.slot / SUBNODE_RING_SIZE);
  const ringStart = ring * SUBNODE_RING_SIZE;
  const slots = Math.min(SUBNODE_RING_SIZE, Math.max(1, owner.total - ringStart));
  const slot = owner.slot - ringStart;
  const angle = -Math.PI / 2 + (slot / slots) * Math.PI * 2;
  const radius = SUBNODE_ORBIT_WORLD + ring * SUBNODE_RING_GAP_WORLD;
  return {
    x: centre.x + Math.cos(angle) * radius,
    y: centre.y + Math.sin(angle) * radius,
  };
}

function virtualPosition(owners: readonly FacetOwner[], options: ExpansionOptions): Point {
  if (owners.length === 1 && owners[0]) return orbitalPosition(owners[0], options);

  const points = owners.map((owner) => pointOf(owner.parent, options));
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function makeVirtualNode(facet: PendingFacet, options: ExpansionOptions): GraphNode {
  const owner = facet.owners[0] as FacetOwner;
  const position = virtualPosition(facet.owners, options);
  return {
    id: virtualSubNodeId(facet.key),
    label: facet.subConcept.label,
    normalizedLabel: facet.key,
    kind: 'concept',
    cellIds: [],
    x: position.x,
    y: position.y,
    pinned: false,
    degree: facet.owners.length,
    centrality: 0,
    cluster: owner.parent.cluster,
    ...(owner.parent.color ? { color: owner.parent.color } : {}),
    ...(facet.subConcept.note ? { note: facet.subConcept.note } : {}),
  };
}

/** Resolve real facets and synthesize view-only nodes for unresolved ones. */
export function resolveExpansion(
  nodes: readonly GraphNode[],
  expandedIds: readonly string[],
  options: ExpansionOptions = {},
): Expansion {
  if (expandedIds.length === 0) return NO_EXPANSION;

  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const kept = expandedIds.filter((id) => byId.has(id)).slice(0, MAX_EXPANDED);
  if (kept.length === 0) return NO_EXPANSION;

  const labelIndex = buildLabelIndex(nodes);
  const exposedIds = new Set<string>(kept);
  const links: ExpansionLink[] = [];
  const pendingByLabel = new Map<string, PendingFacet>();

  for (const parentId of kept) {
    const parent = byId.get(parentId) as GraphNode;
    const subConcepts = parent.subConcepts ?? [];
    for (const [slot, subConcept] of subConcepts.entries()) {
      const key = normalizeLabel(subConcept.label);
      if (!key || key === normalizeLabel(parent.label)) continue;

      const realId = labelIndex.get(key);
      if (realId) {
        exposedIds.add(realId);
        links.push({ sourceId: parentId, targetId: realId });
        continue;
      }

      const owner = { parent, slot, total: subConcepts.length };
      const pending = pendingByLabel.get(key);
      if (pending) pending.owners.push(owner);
      else pendingByLabel.set(key, { key, subConcept, owners: [owner] });
    }
  }

  const virtualNodes = [...pendingByLabel.values()].map((facet) => makeVirtualNode(facet, options));
  const virtualNodeById = new Map<string, VirtualSubNode>();
  for (const node of virtualNodes) {
    const facet = pendingByLabel.get(node.normalizedLabel) as PendingFacet;
    const parentIds = facet.owners.map((owner) => owner.parent.id);
    exposedIds.add(node.id);
    virtualNodeById.set(node.id, { node, parentIds });
    for (const parentId of parentIds) links.push({ sourceId: parentId, targetId: node.id });
  }

  return { expandedIds: kept, exposedIds, virtualNodes, virtualNodeById, links };
}

/** Real GraphNode ids exposed by one parent, in authored order. */
export function exposedSubNodeIds(nodes: readonly GraphNode[], parentId: string): string[] {
  const parent = nodes.find((node) => node.id === parentId);
  if (!parent?.subConcepts?.length) return [];

  const labelIndex = buildLabelIndex(nodes);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const sub of parent.subConcepts) {
    const resolved = labelIndex.get(normalizeLabel(sub.label));
    if (!resolved || resolved === parentId || seen.has(resolved)) continue;
    seen.add(resolved);
    ids.push(resolved);
  }
  return ids;
}
