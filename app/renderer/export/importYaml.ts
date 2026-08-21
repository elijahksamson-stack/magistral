/**
 * Reading an exported knowledge map back into a vault.
 *
 * The exporter used to state that the YAML was not re-importable and the vault
 * on disk was the round-trip artefact. That is no longer true, and this is the
 * other half: a map that can be exported, sent to someone, and opened.
 *
 * It rebuilds CELLS rather than a graph. The document lists nodes, but a node
 * in this app is a consequence — of a `[[wikilink]]` an author typed — and
 * fabricating nodes directly would produce a map with no prose behind it, whose
 * concepts vanish the moment anything re-syncs. Writing the cells instead means
 * the core derives exactly the nodes it would have derived had the author typed
 * the document by hand, and the Editor has something to show.
 *
 * Sub-concepts become `## [[Facet]]` sections inside their parent's cell, which
 * is the same shape `linkSpan.ts` reads descriptions out of: each link owns the
 * text up to the next one.
 *
 * Pure: parsing and planning only. The caller performs the IPC.
 */

import { parse } from 'yaml';

import { RELATION_KINDS, type RelationKind } from '../../../shared/types/graph';
import { fetchSnapshot, invoke } from '../graph/ipcClient';

/** One cell to write, and the concept it asserts. */
export interface PlannedCell {
  readonly label: string;
  readonly markdown: string;
}

/** One relationship to add, by concept LABEL — ids belong to the file, not us. */
export interface PlannedEdge {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly relation: RelationKind;
  readonly note: string;
}

export interface ImportPlan {
  /** The map's own name, used when the filename gives nothing better. */
  readonly name: string;
  readonly cells: readonly PlannedCell[];
  readonly edges: readonly PlannedEdge[];
  /** Concept label -> the label of the group it belongs in. */
  readonly groups: ReadonlyMap<string, string>;
  /**
   * Relationships naming an endpoint no node in the file defines. Reported
   * rather than thrown: one broken reference should not cost the author the
   * other four hundred that were fine.
   */
  readonly skipped: readonly string[];
}

export class YamlImportError extends Error {}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new YamlImportError(`${what} is missing or not a mapping.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tableOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Notes live in their own table and are referenced by key, so a description has
 * to be resolved through it. A dangling key yields empty prose rather than the
 * key text itself, which would otherwise be written into the author's cell.
 */
function noteResolver(table: Record<string, unknown>): (key: unknown) => string {
  return (key: unknown): string => {
    if (typeof key !== 'string') return '';
    const entry = table[key];
    if (typeof entry !== 'object' || entry === null) return '';
    return asString((entry as Record<string, unknown>).body).trim();
  };
}

/** `## [[Label]]` and its prose — the section shape the app reads and writes. */
function section(label: string, body: string): string {
  const prose = body.trim();
  return prose.length > 0 ? `## [[${label}]]\n\n${prose}` : `## [[${label}]]`;
}

/**
 * Turn an exported map into the cells and relationships that reproduce it.
 *
 * Throws only when the document is not a knowledge map at all. Everything
 * recoverable — a missing note, an edge to a node never defined, an unknown
 * relation kind — degrades rather than failing, because a partial import the
 * author can inspect beats a refusal they cannot.
 */
export function planImport(yamlText: string): ImportPlan {
  let parsed: unknown;
  try {
    parsed = parse(yamlText);
  } catch (cause: unknown) {
    throw new YamlImportError(
      `That file is not valid YAML — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const doc = asRecord(parsed, 'The file');
  const nodes = asRecord(doc.nodes, 'Its "nodes" section');
  const resolveNote = noteResolver(tableOf(doc.notes));
  const resolveEdgeNote = noteResolver(tableOf(doc.relationshipNotes));

  const labelById = new Map<string, string>();
  const groupIdByLabel = new Map<string, string>();
  const cells: PlannedCell[] = [];

  for (const [id, raw] of Object.entries(nodes)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const node = raw as Record<string, unknown>;
    const label = asString(node.name).trim();
    if (label.length === 0) continue;

    labelById.set(id, label);
    const groupId = asString(node.group).trim();
    if (groupId.length > 0) groupIdByLabel.set(label, groupId);

    /*
     * A group is a container the author arranged, not something a cell
     * asserts — writing a cell for it would put an empty page in the Editor
     * and a duplicate concept on the map.
     */
    if (asString(node.kind) === 'group') continue;

    const parts = [section(label, resolveNote(node.note))];
    const subConcepts = Array.isArray(node.subConcepts) ? node.subConcepts : [];
    for (const sub of subConcepts) {
      if (typeof sub !== 'object' || sub === null) continue;
      const facet = sub as Record<string, unknown>;
      const facetLabel = asString(facet.name).trim();
      if (facetLabel.length === 0) continue;
      parts.push(section(facetLabel, resolveNote(facet.note)));
    }
    cells.push({ label, markdown: parts.join('\n\n') });
  }

  const edges: PlannedEdge[] = [];
  const skipped: string[] = [];
  for (const [id, raw] of Object.entries(tableOf(doc.relationships))) {
    if (typeof raw !== 'object' || raw === null) continue;
    const edge = raw as Record<string, unknown>;
    const fromLabel = labelById.get(asString(edge.from));
    const toLabel = labelById.get(asString(edge.to));
    if (!fromLabel || !toLabel) {
      skipped.push(id);
      continue;
    }

    const relation = asString(edge.relation) as RelationKind;
    edges.push({
      fromLabel,
      toLabel,
      // An unrecognised relation becomes the untyped default rather than
      // failing the import: the connection is the fact worth keeping.
      relation: RELATION_KINDS.includes(relation) ? relation : 'relates_to',
      note: resolveEdgeNote(edge.note),
    });
  }

  const groups = new Map<string, string>();
  for (const [label, groupId] of groupIdByLabel) {
    const groupLabel = labelById.get(groupId);
    if (groupLabel) groups.set(label, groupLabel);
  }

  if (cells.length === 0) {
    throw new YamlImportError('That file has no concepts in it.');
  }

  return { name: asString(doc.name).trim(), cells, edges, groups, skipped };
}

/** The vault name a file lands under: its own filename, less the suffix. */
export function vaultNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '').trim();
  return base.length > 0 ? base : 'Imported map';
}

export interface ImportReport {
  readonly id: string;
  readonly name: string;
  readonly cells: number;
  readonly edges: number;
}

/**
 * Write a plan into a brand-new vault.
 *
 * Cells first, so the core derives the concepts from the links exactly as it
 * would from typing; then relationships, resolved against the ids the core
 * chose rather than the ids the file used. Creating the vault first means a
 * name clash is refused before anything is written, so a failed import leaves
 * no half-built vault behind.
 */
export async function applyImportPlan(name: string, plan: ImportPlan): Promise<ImportReport> {
  const created = await invoke('vault:create', { name });
  await invoke('vault:open', { id: created.id });

  for (const [index, cell] of plan.cells.entries()) {
    await invoke('cell:upsert', { cellId: `import-${index}`, markdown: cell.markdown });
  }

  const snapshot = await fetchSnapshot();
  const idByLabel = new Map(
    snapshot.nodes.map((node) => [node.label.trim().toLocaleLowerCase(), node.id] as const),
  );

  // Groups are containers the core never infers, so membership is restored
  // explicitly — the group node itself is created here rather than by a cell.
  const groupIdByLabel = new Map<string, string>();
  for (const groupLabel of new Set(plan.groups.values())) {
    const { nodeId } = await invoke('graph:add-node', { label: groupLabel, kind: 'group' });
    groupIdByLabel.set(groupLabel.trim().toLocaleLowerCase(), nodeId);
  }
  for (const [memberLabel, groupLabel] of plan.groups) {
    const nodeId = idByLabel.get(memberLabel.trim().toLocaleLowerCase());
    const groupId = groupIdByLabel.get(groupLabel.trim().toLocaleLowerCase());
    if (nodeId && groupId) await invoke('graph:set-node-group', { nodeId, groupId });
  }

  let edges = 0;
  for (const edge of plan.edges) {
    const from = idByLabel.get(edge.fromLabel.trim().toLocaleLowerCase());
    const to = idByLabel.get(edge.toLabel.trim().toLocaleLowerCase());
    if (!from || !to) continue;

    const { edgeId } = await invoke('graph:add-edge', {
      sourceId: from,
      targetId: to,
      relation: edge.relation,
      weight: 1,
    });
    if (edge.note) await invoke('graph:set-edge-note', { edgeId, note: edge.note });
    edges += 1;
  }

  await invoke('graph:compute-metrics', undefined);
  await invoke('vault:save', { id: created.id, graph: await fetchSnapshot() });
  return { id: created.id, name: created.name, cells: plan.cells.length, edges };
}
