/**
 * The flat knowledge map.
 *
 * The property under test throughout is that every fact appears exactly once:
 * one record per node, one per surviving edge, one per distinct piece of prose.
 * The previous nested export could not promise that — a concept reachable by
 * many paths was re-expanded once per path, which is what exhausted the
 * renderer heap on a real vault.
 */

import { describe, expect, it } from 'vitest';

import { buildKnowledgeMap, MAP_FORMAT_VERSION } from '../outline';
import type {
  Cell,
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  SubConcept,
} from '../../../../shared/types/graph';

const AT = '2026-08-06T16:20:00.000Z';

function node(id: string, label: string, cellIds: string[] = [], extra: Partial<GraphNode> = {}) {
  return {
    id,
    label,
    normalizedLabel: label.toLowerCase(),
    kind: 'concept' as const,
    cellIds,
    x: 0,
    y: 0,
    pinned: false,
    degree: 0,
    centrality: 0,
    cluster: 0,
    ...extra,
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  extra: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    id,
    source,
    target,
    relation: 'affects',
    weight: 1,
    directed: true,
    ...extra,
  };
}

function cell(id: string, markdown: string): Cell {
  return { id, order: 0, markdown, createdAt: AT, updatedAt: AT };
}

function graphOf(partial: Partial<KnowledgeGraph>): KnowledgeGraph {
  return {
    schemaVersion: 1,
    id: 'g1',
    name: 'Test',
    createdAt: AT,
    updatedAt: AT,
    cells: [],
    nodes: [],
    edges: [],
    view: {
      zoom: 1,
      panX: 0,
      panY: 0,
      layout: {
        kind: 'force',
        params: {
          repulsion: 6000,
          attraction: 0.05,
          gravity: 0.02,
          damping: 0.85,
          theta: 0.5,
          linkDistance: 120,
        },
      },
    },
    ...partial,
  } as KnowledgeGraph;
}

describe('buildKnowledgeMap', () => {
  it('stamps the format version and the name it was given', () => {
    const map = buildKnowledgeMap(graphOf({ name: 'Power Markets' }), AT);

    expect(map.formatVersion).toBe(MAP_FORMAT_VERSION);
    expect(map.name).toBe('Power Markets');
    expect(map.exportedAt).toBe(AT);
  });

  it('serializes every node exactly once, keyed by node id', () => {
    const map = buildKnowledgeMap(
      graphOf({ nodes: [node('n1', 'Alpha'), node('n2', 'Beta'), node('n3', 'Gamma')] }),
      AT,
    );

    expect(Object.keys(map.nodes).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(map.nodes.n1).toEqual({ name: 'Alpha', kind: 'concept' });
    expect(map.nodeCount).toBe(3);
  });

  it('serializes every valid edge exactly once, keyed by edge id', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Alpha'), node('n2', 'Beta')],
        edges: [edge('e1', 'n1', 'n2'), edge('e2', 'n2', 'n1', { relation: 'supports' })],
      }),
      AT,
    );

    expect(Object.keys(map.relationships).sort()).toEqual(['e1', 'e2']);
    expect(map.relationshipCount).toBe(2);
  });

  it('names relationship endpoints by id and never embeds a node', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Alpha'), node('n2', 'Beta')],
        edges: [edge('e1', 'n1', 'n2', { relation: 'causes', directed: false, weight: 3 })],
      }),
      AT,
    );

    expect(map.relationships.e1).toEqual({
      from: 'n1',
      to: 'n2',
      relation: 'causes',
      directed: false,
      weight: 3,
    });
    // The endpoints are strings, not objects — nothing to recurse into.
    expect(typeof map.relationships.e1?.from).toBe('string');
    expect(JSON.stringify(map.relationships)).not.toContain('"name"');
  });

  it('exports a cycle like any other pair, with no back-reference marker', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'A'), node('n2', 'B')],
        edges: [edge('e1', 'n1', 'n2'), edge('e2', 'n2', 'n1')],
      }),
      AT,
    );

    expect(Object.keys(map.nodes)).toHaveLength(2);
    expect(Object.keys(map.relationships)).toHaveLength(2);
    expect(JSON.stringify(map)).not.toContain('seen');
  });

  it('keeps disconnected nodes and nodes reachable only inside a cycle', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Lonely'), node('n2', 'CycleA'), node('n3', 'CycleB')],
        edges: [edge('e1', 'n2', 'n3'), edge('e2', 'n3', 'n2')],
      }),
      AT,
    );

    expect(Object.keys(map.nodes).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(map.nodeCount).toBe(3);
  });

  it('stays linear in the size of a dense graph', () => {
    // Every node points at every other: the number of simple paths grows
    // factorially, so the old nested export exploded here. A flat document
    // cannot: it is one record per node plus one per edge, whatever the shape.
    const SIZE = 12;
    const nodes = Array.from({ length: SIZE }, (_, index) => node(`n${index}`, `N${index}`));
    const edges = nodes.flatMap((from, i) =>
      nodes.filter((_, j) => i !== j).map((to, j) => edge(`e${i}-${j}`, from.id, to.id)),
    );

    const map = buildKnowledgeMap(graphOf({ nodes, edges }), AT);

    expect(Object.keys(map.nodes)).toHaveLength(SIZE);
    expect(Object.keys(map.relationships)).toHaveLength(SIZE * (SIZE - 1));
    expect(map.nodeCount).toBe(SIZE);
    expect(map.relationshipCount).toBe(SIZE * (SIZE - 1));
  });

  it('drops a relationship whose endpoint is not an exported node', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Alpha')],
        edges: [edge('e1', 'n1', 'n404'), edge('e2', 'n404', 'n1'), edge('e3', 'n1', 'n1')],
      }),
      AT,
    );

    expect(Object.keys(map.relationships)).toEqual(['e3']);
    // The count reports what was written, not what the graph held.
    expect(map.relationshipCount).toBe(1);
  });
});

describe('notes', () => {
  it('stores an explicit node note once and references it by id', () => {
    const map = buildKnowledgeMap(
      graphOf({ nodes: [node('n1', 'Moat', [], { note: 'A durable cost advantage.' })] }),
      AT,
    );

    const noteId = map.nodes.n1?.note;
    expect(noteId).toBe('note-n1');
    expect(map.notes[noteId as string]).toEqual({
      owner: 'n1',
      body: 'A durable cost advantage.',
    });
    expect(Object.keys(map.notes)).toHaveLength(1);
  });

  it('derives a description from cells when the node carries no note', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Moat', ['c1'])],
        cells: [cell('c1', '[[Moat]] widens as scale grows.')],
      }),
      AT,
    );

    expect(map.notes[map.nodes.n1?.note as string]?.body).toBe('widens as scale grows.');
  });

  it('omits the note reference and the record when there is no prose', () => {
    const map = buildKnowledgeMap(
      graphOf({ nodes: [node('n1', 'Bare', [], { note: '   ' })] }),
      AT,
    );

    expect(map.nodes.n1).not.toHaveProperty('note');
    expect(map.notes).toEqual({});
  });

  it('shares one note record when a node repeats the same sub-concept prose', () => {
    const subConcepts: SubConcept[] = [
      { label: 'First', note: 'Both facets came off one line.' },
      { label: 'Second', note: 'Both facets came off one line.' },
      { label: 'Third', note: 'A different line.' },
    ];
    const map = buildKnowledgeMap(
      graphOf({ nodes: [node('n1', 'Owner', [], { subConcepts })] }),
      AT,
    );

    const facets = map.nodes.n1?.subConcepts ?? [];
    expect(facets.map((facet) => facet.name)).toEqual(['First', 'Second', 'Third']);
    expect(facets[0]?.note).toBe(facets[1]?.note);
    expect(facets[2]?.note).not.toBe(facets[0]?.note);
    // Two distinct bodies -> two records, not three.
    expect(Object.keys(map.notes)).toHaveLength(2);
    expect(map.notes[facets[0]?.note as string]?.owner).toBe('n1');
  });

  it('does not share a note body across different owners', () => {
    const shared: SubConcept[] = [{ label: 'Facet', note: 'Same words, different owner.' }];
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [
          node('n1', 'Alpha', [], { subConcepts: shared }),
          node('n2', 'Beta', [], { subConcepts: shared }),
        ],
      }),
      AT,
    );

    const first = map.nodes.n1?.subConcepts?.[0]?.note as string;
    const second = map.nodes.n2?.subConcepts?.[0]?.note as string;
    expect(first).not.toBe(second);
    expect(map.notes[first]?.owner).toBe('n1');
    expect(map.notes[second]?.owner).toBe('n2');
  });

  it('keeps a sub-concept with no prose, without inventing a note', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Owner', [], { subConcepts: [{ label: 'Bare' }, { label: 'Blank', note: '  ' }] })],
      }),
      AT,
    );

    expect(map.nodes.n1?.subConcepts).toEqual([{ name: 'Bare' }, { name: 'Blank' }]);
    expect(map.notes).toEqual({});
  });

  it('puts an edge note in relationshipNotes and references it by id', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Alpha'), node('n2', 'Beta')],
        edges: [edge('e1', 'n1', 'n2', { note: 'How and why.' })],
      }),
      AT,
    );

    const noteId = map.relationships.e1?.note;
    expect(noteId).toBe('relationship-note-e1');
    expect(map.relationshipNotes[noteId as string]).toEqual({
      relationship: 'e1',
      body: 'How and why.',
    });
  });

  it('omits an empty edge note entirely', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n1', 'Alpha'), node('n2', 'Beta')],
        edges: [edge('e1', 'n1', 'n2', { note: '  ' }), edge('e2', 'n2', 'n1')],
      }),
      AT,
    );

    expect(map.relationships.e1).not.toHaveProperty('note');
    expect(map.relationships.e2).not.toHaveProperty('note');
    expect(map.relationshipNotes).toEqual({});
  });
});

describe('groups', () => {
  it('references a group by id, and the group is itself an exported node', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [
          node('n1', 'Member', [], { groupId: 'g9' }),
          node('g9', 'Example Group', [], { kind: 'group' }),
        ],
      }),
      AT,
    );

    expect(map.nodes.n1?.group).toBe('g9');
    expect(map.nodes.g9).toEqual({ name: 'Example Group', kind: 'group' });
  });

  it('drops a group reference that points at nothing', () => {
    const map = buildKnowledgeMap(
      graphOf({ nodes: [node('n1', 'Orphan', [], { groupId: 'gone' })] }),
      AT,
    );

    expect(map.nodes.n1).not.toHaveProperty('group');
  });

  it('keeps a real edge to the group alongside membership', () => {
    // Membership and `part_of` are different facts; neither replaces the other.
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [
          node('n1', 'Member', [], { groupId: 'g9' }),
          node('g9', 'Example Group', [], { kind: 'group' }),
        ],
        edges: [edge('e1', 'n1', 'g9', { relation: 'part_of' })],
      }),
      AT,
    );

    expect(map.nodes.n1?.group).toBe('g9');
    expect(map.relationships.e1?.relation).toBe('part_of');
  });
});

describe('determinism and noise', () => {
  it('serializes identically for the same graph and timestamp', () => {
    const build = () =>
      buildKnowledgeMap(
        graphOf({
          nodes: [node('n2', 'Beta'), node('n1', 'Alpha'), node('n3', 'Alpha')],
          edges: [edge('e2', 'n2', 'n1'), edge('e1', 'n1', 'n2')],
        }),
        AT,
      );

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('orders nodes by name then id, and relationships by endpoints then id', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [node('n3', 'Beta'), node('n2', 'Alpha'), node('n1', 'Alpha')],
        edges: [edge('e2', 'n2', 'n3'), edge('e1', 'n1', 'n2'), edge('e3', 'n1', 'n3')],
      }),
      AT,
    );

    // Alpha/n1, Alpha/n2 (name tie broken by id), then Beta/n3.
    expect(Object.keys(map.nodes)).toEqual(['n1', 'n2', 'n3']);
    expect(Object.keys(map.relationships)).toEqual(['e1', 'e3', 'e2']);
  });

  it('carries no layout, rendering or computed state', () => {
    const map = buildKnowledgeMap(
      graphOf({
        nodes: [
          node('n1', 'Alpha', [], {
            x: 12.5,
            y: -3.25,
            cluster: 4,
            centrality: 0.9,
            degree: 7,
            pinned: true,
            color: '#ff0000',
          }),
        ],
        edges: [],
      }),
      AT,
    );

    const text = JSON.stringify(map);
    for (const noise of [
      'x',
      'y',
      'pinned',
      'cluster',
      'centrality',
      'degree',
      'color',
      'normalizedLabel',
      'damping',
      'repulsion',
      'theta',
      'zoom',
      'cellIds',
      'claudeSessionId',
    ]) {
      expect(Object.keys(map.nodes.n1 ?? {})).not.toContain(noise);
    }
    expect(text).not.toContain('normalizedLabel');
    expect(text).not.toContain('12.5');
    expect(text).not.toContain('#ff0000');
  });
});
