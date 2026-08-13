/**
 * The graph, projected into what "Complete the map" needs to see.
 *
 * Two jobs, deliberately in one place so they cannot disagree: build the
 * snapshot the proposal is VALIDATED against, and render the text the model is
 * SHOWN. If those two ever drifted, the model would be reasoning about one
 * graph and being judged against another — every rejection would look
 * arbitrary from the outside.
 *
 * Ids are dropped on the way in. The model only ever sees labels, so a
 * proposal only ever comes back in labels, and there is no id in flight that
 * could go stale between the snapshot and the apply.
 */

import type { MapEdge, MapNode, MapSnapshot } from '../../../shared/types/completion';
import type { KnowledgeGraph } from '../../../shared/types/graph';

/**
 * How much of the map to show.
 *
 * A large graph would otherwise crowd out the corpus and the instruction. The
 * cut is by centrality, so what survives is the part of the map with the most
 * connective tissue — which is where a missing concept is most visible.
 */
export const MAX_MAP_NODES = 250;
export const MAX_MAP_EDGES = 400;

/** Notes are context, not content. Enough to convey intent, not to dominate. */
const MAX_NOTE_CHARS = 200;

function trimNote(note: string | undefined): string | undefined {
  const text = note?.trim();
  if (!text) return undefined;
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}…` : text;
}

/**
 * Project the core's graph into a label-keyed map.
 *
 * Truncation is by centrality rather than by insertion order: showing the
 * first 250 nodes a vault happens to hold would hand the model an arbitrary
 * slice, and it would propose connections to concepts it simply was not shown.
 */
export function buildMapSnapshot(graph: KnowledgeGraph): MapSnapshot {
  const ranked = [...graph.nodes].sort((a, b) => b.centrality - a.centrality);
  const kept = ranked.slice(0, MAX_MAP_NODES);
  const keptIds = new Set(kept.map((node) => node.id));

  const labelById = new Map(graph.nodes.map((node) => [node.id, node.label]));

  const nodes: MapNode[] = kept.map((node) => {
    const groupLabel = node.groupId ? labelById.get(node.groupId) : undefined;
    const subConcepts = (node.subConcepts ?? [])
      .map((sub) => (typeof sub === 'string' ? sub : sub.label))
      .filter((label) => label.trim().length > 0);

    return {
      label: node.label,
      kind: node.kind,
      ...(trimNote(node.note) ? { note: trimNote(node.note) } : {}),
      ...(groupLabel ? { group: groupLabel } : {}),
      ...(subConcepts.length > 0 ? { subConcepts } : {}),
    };
  });

  // An edge whose endpoint was cut is not shown: a relationship to a concept
  // the model cannot see reads as a dangling reference and invites a proposal
  // to "add" the node that is actually already there.
  const edges: MapEdge[] = graph.edges
    .filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target))
    .slice(0, MAX_MAP_EDGES)
    .map((edge) => {
      const source = labelById.get(edge.source) ?? '';
      const target = labelById.get(edge.target) ?? '';
      return {
        source,
        target,
        relation: edge.relation,
        ...(trimNote(edge.note) ? { note: trimNote(edge.note) } : {}),
      };
    })
    .filter((edge) => edge.source.length > 0 && edge.target.length > 0);

  return { name: graph.name, nodes, edges };
}

function renderNode(node: MapNode): string {
  const parts = [`- ${node.label} (${node.kind}`];
  parts.push(node.group ? `, in group "${node.group}")` : ')');
  if (node.note) parts.push(` — ${node.note}`);
  if (node.subConcepts?.length) parts.push(` [subnodes: ${node.subConcepts.join('; ')}]`);
  return parts.join('');
}

function renderEdge(edge: MapEdge): string {
  const line = `- ${edge.source} --[${edge.relation}]--> ${edge.target}`;
  return edge.note ? `${line} — ${edge.note}` : line;
}

/**
 * The map as prose the model reads.
 *
 * Written out rather than handed over as JSON: the reply must be JSON, and a
 * prompt that is itself JSON reliably produces replies that echo the input
 * shape back instead of answering in the output shape.
 */
export function renderMap(map: MapSnapshot): string {
  const groups = map.nodes.filter((node) => node.kind === 'group');
  const concepts = map.nodes.filter((node) => node.kind !== 'group');

  const lines = [`Map: "${map.name}" — ${concepts.length} concepts, ${map.edges.length} relationships.`];

  lines.push('', 'CONCEPTS THAT ALREADY EXIST (do not propose these as new):');
  lines.push(concepts.length > 0 ? concepts.map(renderNode).join('\n') : '- (none yet)');

  if (groups.length > 0) {
    lines.push('', 'GROUPS (containers, and valid semantic edge endpoints when warranted):');
    lines.push(groups.map((group) => `- ${group.label}`).join('\n'));
  }

  const parentsWithSubnodes = concepts.filter((node) => node.subConcepts?.length);
  if (parentsWithSubnodes.length > 0) {
    lines.push(
      '',
      'SUBNODES / FACETS (existing nested endpoints; keep them under the named parent):',
    );
    lines.push(
      parentsWithSubnodes
        .map((node) => `- under ${node.label}: ${(node.subConcepts ?? []).join('; ')}`)
        .join('\n'),
    );
  }

  lines.push('', 'RELATIONSHIPS THAT ALREADY EXIST:');
  lines.push(map.edges.length > 0 ? map.edges.map(renderEdge).join('\n') : '- (none yet)');

  return lines.join('\n');
}
