/**
 * "Complete the map" may add, never destroy.
 *
 * The schema makes renaming and deleting inexpressible; these tests cover what
 * the schema cannot: that a "new" concept really is new, that endpoints exist,
 * and that nothing is dropped without saying so.
 */

import { describe, expect, it } from 'vitest';

import { countChanges, parseCompletion, validateCompletion } from './completion';
import {
  MAX_PROPOSED_CHANGES,
  type MapCompletion,
  type MapSnapshot,
} from '../../../shared/types/completion';

const GRAPH: MapSnapshot = {
  name: 'test',
  nodes: [
    { label: 'EUV', kind: 'concept' },
    { label: 'ASML', kind: 'entity' },
    { label: 'Semis', kind: 'concept' },
    { label: 'Power', kind: 'group' },
  ],
  edges: [{ source: 'ASML', target: 'EUV', relation: 'supports' }],
};

const EMPTY: MapCompletion = { newNodes: [], newEdges: [], edgeChanges: [], groupAdditions: [] };

const GRAPH_WITH_SUBNODES: MapSnapshot = {
  ...GRAPH,
  nodes: GRAPH.nodes.map((node) =>
    node.label === 'Semis'
      ? { ...node, subConcepts: ['Power demand', 'Financing constraint'] }
      : node.label === 'EUV'
        ? { ...node, subConcepts: ['Lithography bottleneck'] }
        : node,
  ),
};

describe('what a proposal cannot express', () => {
  it('has no way to delete or rename a concept', () => {
    // The guarantee is structural: these operations have no field to live in,
    // so a model cannot ask for them however it is prompted.
    const keys = Object.keys(EMPTY);
    expect(keys).toEqual(['newNodes', 'newEdges', 'edgeChanges', 'groupAdditions']);
    expect(keys.some((key) => /delete|remove|rename|drop/i.test(key))).toBe(false);
  });

  it('ignores delete-shaped fields a model invents', () => {
    const parsed = parseCompletion(
      JSON.stringify({ deleteNodes: ['EUV'], renameNodes: [{ from: 'EUV', to: 'X' }], newNodes: [] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.value)).not.toContain('EUV');
  });
});

describe('creating concepts', () => {
  it('accepts one the graph does not have', () => {
    const { accepted } = validateCompletion(
      { ...EMPTY, newNodes: [{ label: 'Heat Rate', kind: 'concept' }] },
      GRAPH,
    );
    expect(accepted.newNodes).toHaveLength(1);
  });

  it('REFUSES one that already exists, because that would be an edit', () => {
    const { accepted, rejected } = validateCompletion(
      { ...EMPTY, newNodes: [{ label: 'euv', kind: 'concept' }] },
      GRAPH,
    );
    expect(accepted.newNodes).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/already exists/i);
  });

  it('refuses an empty label', () => {
    const { accepted, rejected } = validateCompletion(
      { ...EMPTY, newNodes: [{ label: '   ', kind: 'concept' }] },
      GRAPH,
    );
    expect(accepted.newNodes).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it('never proposes a group — containers are the author’s to place', () => {
    const parsed = parseCompletion(
      JSON.stringify({ newNodes: [{ label: 'Sector', kind: 'group' }] }),
    );
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.value.newNodes[0]?.kind).toBe('concept');
  });

  it('adds the concept anyway when its named group does not exist, and says so', () => {
    const { accepted, rejected } = validateCompletion(
      { ...EMPTY, newNodes: [{ label: 'Heat Rate', kind: 'concept', group: 'Nowhere' }] },
      GRAPH,
    );
    expect(accepted.newNodes).toHaveLength(1);
    expect(accepted.newNodes[0]?.group).toBeUndefined();
    expect(rejected[0]?.reason).toMatch(/no group named/i);
  });
});

describe('drawing relationships', () => {
  it('accepts one between two existing concepts', () => {
    const { accepted } = validateCompletion(
      { ...EMPTY, newEdges: [{ source: 'EUV', target: 'Semis', relation: 'affects' }] },
      GRAPH,
    );
    expect(accepted.newEdges).toHaveLength(1);
  });

  it('accepts one between two concepts it is creating in the same proposal', () => {
    // A chain of new ideas plus the links between them is exactly the ask.
    const { accepted } = validateCompletion(
      {
        ...EMPTY,
        newNodes: [
          { label: 'Interconnect Queue', kind: 'concept' },
          { label: 'Capacity Ceiling', kind: 'concept' },
        ],
        newEdges: [{ source: 'Interconnect Queue', target: 'Capacity Ceiling', relation: 'causes' }],
      },
      GRAPH,
    );
    expect(accepted.newEdges).toHaveLength(1);
  });

  it('refuses one whose endpoint does not exist', () => {
    const { accepted, rejected } = validateCompletion(
      { ...EMPTY, newEdges: [{ source: 'EUV', target: 'Nonexistent', relation: 'causes' }] },
      GRAPH,
    );
    expect(accepted.newEdges).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/not in the graph/i);
  });

  it('accepts an existing subnode endpoint without proposing a new node', () => {
    const { accepted } = validateCompletion(
      {
        ...EMPTY,
        newEdges: [
          {
            source: 'EUV',
            target: 'Power demand',
            targetParent: 'Semis',
            relation: 'depends_on',
            note: 'Fab growth is bounded by available electricity.',
          },
        ],
      },
      GRAPH_WITH_SUBNODES,
      'node-subnode',
    );

    expect(accepted.newNodes).toEqual([]);
    expect(accepted.newEdges).toHaveLength(1);
    expect(accepted.newEdges[0]?.targetParent).toBe('Semis');
  });

  it('connects existing subnodes under different parents without promoting either one', () => {
    const { accepted } = validateCompletion(
      {
        ...EMPTY,
        newEdges: [
          {
            source: 'Power demand',
            sourceParent: 'Semis',
            target: 'Lithography bottleneck',
            targetParent: 'EUV',
            relation: 'affects',
          },
        ],
      },
      GRAPH_WITH_SUBNODES,
      'subnode-subnode',
    );

    expect(accepted.newNodes).toEqual([]);
    expect(accepted.newEdges).toHaveLength(1);
    expect(accepted.newEdges[0]).toMatchObject({
      sourceParent: 'Semis',
      targetParent: 'EUV',
    });
  });

  it('rejects a child that is not under the named parent', () => {
    const { accepted } = validateCompletion(
      {
        ...EMPTY,
        newEdges: [{
          source: 'Power demand',
          sourceParent: 'EUV',
          target: 'Lithography bottleneck',
          targetParent: 'EUV',
          relation: 'affects',
        }],
      },
      GRAPH_WITH_SUBNODES,
      'subnode-subnode',
    );

    expect(accepted.newNodes).toEqual([]);
    expect(accepted.newEdges).toEqual([]);
  });

  it('rejects new concepts and wrong-level edges from a scoped subnode scan', () => {
    const { accepted, rejected } = validateCompletion(
      {
        ...EMPTY,
        newNodes: [{ label: 'Invented child', kind: 'concept' }],
        newEdges: [{ source: 'EUV', target: 'Semis', relation: 'affects' }],
      },
      GRAPH_WITH_SUBNODES,
      'subnode-subnode',
    );

    expect(accepted.newNodes).toEqual([]);
    expect(accepted.newEdges).toEqual([]);
    expect(rejected.map((entry) => entry.reason).join(' ')).toMatch(/existing endpoints|not subnode-subnode/i);
  });

  it('refuses a self-link and a duplicate', () => {
    const { accepted, rejected } = validateCompletion(
      {
        ...EMPTY,
        newEdges: [
          { source: 'EUV', target: 'EUV', relation: 'causes' },
          { source: 'ASML', target: 'EUV', relation: 'causes' },
        ],
      },
      GRAPH,
    );
    expect(accepted.newEdges).toHaveLength(0);
    expect(rejected.map((r) => r.reason).join(' ')).toMatch(/itself/i);
    expect(rejected.map((r) => r.reason).join(' ')).toMatch(/already connected/i);
  });
});

describe('changing an existing relationship', () => {
  it('accepts a retype of one that exists', () => {
    const { accepted } = validateCompletion(
      { ...EMPTY, edgeChanges: [{ source: 'ASML', target: 'EUV', relation: 'causes' }] },
      GRAPH,
    );
    expect(accepted.edgeChanges).toHaveLength(1);
  });

  it('refuses a change to a relationship that does not exist', () => {
    // Otherwise a create could wear a change's clothes and skip the checks above.
    const { accepted, rejected } = validateCompletion(
      { ...EMPTY, edgeChanges: [{ source: 'EUV', target: 'Semis', relation: 'causes' }] },
      GRAPH,
    );
    expect(accepted.edgeChanges).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/no such relationship/i);
  });
});

describe('adding to groups', () => {
  it('accepts an existing concept into an existing group', () => {
    const { accepted } = validateCompletion(
      { ...EMPTY, groupAdditions: [{ node: 'EUV', group: 'Power' }] },
      GRAPH,
    );
    expect(accepted.groupAdditions).toHaveLength(1);
  });

  it('refuses a target that is not a group', () => {
    const { accepted, rejected } = validateCompletion(
      { ...EMPTY, groupAdditions: [{ node: 'EUV', group: 'Semis' }] },
      GRAPH,
    );
    expect(accepted.groupAdditions).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/not a group/i);
  });

  it('refuses to nest a group', () => {
    const { accepted, rejected } = validateCompletion(
      { ...EMPTY, groupAdditions: [{ node: 'Power', group: 'Power' }] },
      GRAPH,
    );
    expect(accepted.groupAdditions).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/inside a group/i);
  });

  it('does not turn a nested subnode into a top-level group member', () => {
    const { accepted, rejected } = validateCompletion(
      {
        ...EMPTY,
        groupAdditions: [{ node: 'Power demand', group: 'Power' }],
      },
      GRAPH_WITH_SUBNODES,
    );

    expect(accepted.newNodes).toEqual([]);
    expect(accepted.groupAdditions).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/not in the graph/i);
  });
});

/*
 * subConcepts is the field an answer uses to say "this concept arrives with
 * named parts". It is model output, so nothing here is trusted: shape, count
 * and duplication are all enforced on the way in.
 */
describe('facets proposed beneath a concept', () => {
  it('reads label and note off each facet', () => {
    const parsed = parseCompletion(
      '{"newNodes":[{"label":"Self-hosted inference","kind":"concept","subConcepts":[' +
        '{"label":"Local weights","note":"Downloaded once."},{"label":"GPU ceiling"}]}]}',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.newNodes[0]?.subConcepts).toEqual([
      { label: 'Local weights', note: 'Downloaded once.' },
      { label: 'GPU ceiling' },
    ]);
  });

  it('accepts a bare list of names, which is half of what models return', () => {
    const parsed = parseCompletion(
      '{"newNodes":[{"label":"X","kind":"concept","subConcepts":["Alpha","Beta"]}]}',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.newNodes[0]?.subConcepts).toEqual([{ label: 'Alpha' }, { label: 'Beta' }]);
  });

  it('drops duplicates and empties rather than writing them into the cell', () => {
    const parsed = parseCompletion(
      '{"newNodes":[{"label":"X","kind":"concept","subConcepts":["Alpha","alpha","  ","Beta"]}]}',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.newNodes[0]?.subConcepts).toEqual([{ label: 'Alpha' }, { label: 'Beta' }]);
  });

  it('caps a runaway list, because every facet becomes a link in the cell', () => {
    const many = Array.from({ length: 40 }, (_, index) => `"Facet ${index}"`).join(',');
    const parsed = parseCompletion(
      `{"newNodes":[{"label":"X","kind":"concept","subConcepts":[${many}]}]}`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.newNodes[0]?.subConcepts?.length).toBe(12);
  });

  it('leaves the field off entirely when the model sent nothing usable', () => {
    const parsed = parseCompletion(
      '{"newNodes":[{"label":"X","kind":"concept","subConcepts":"nope"}]}',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.newNodes[0]?.subConcepts).toBeUndefined();
  });
});

describe('parsing what the model returned', () => {
  it('reads a fenced block', () => {
    const parsed = parseCompletion('Here you go:\n```json\n{"newNodes":[{"label":"X","kind":"concept"}]}\n```');
    expect(parsed.ok && parsed.value.newNodes[0]?.label).toBe('X');
  });

  it('reads an object with prose around it', () => {
    const parsed = parseCompletion('I suggest: {"newEdges":[{"source":"a","target":"b","relation":"causes"}]} — that is all.');
    expect(parsed.ok && parsed.value.newEdges).toHaveLength(1);
  });

  it('tolerates missing arrays rather than failing the whole proposal', () => {
    const parsed = parseCompletion('{"newEdges":[{"source":"EUV","target":"Semis","relation":"affects"}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.newNodes).toEqual([]);
    expect(parsed.value.newEdges).toHaveLength(1);
  });

  it('falls back to relates_to on an unknown relation rather than dropping the edge', () => {
    const parsed = parseCompletion('{"newEdges":[{"source":"a","target":"b","relation":"invented"}]}');
    expect(parsed.ok && parsed.value.newEdges[0]?.relation).toBe('relates_to');
  });

  it('retains parent qualifiers for nested endpoints', () => {
    const parsed = parseCompletion('{"newEdges":[{"source":"A","sourceParent":"P","target":"B","targetParent":"Q","relation":"affects"}]}');
    expect(parsed.ok && parsed.value.newEdges[0]).toMatchObject({
      sourceParent: 'P',
      targetParent: 'Q',
    });
  });

  it('reports unparseable output instead of throwing', () => {
    expect(parseCompletion('no json at all').ok).toBe(false);
    expect(parseCompletion('{ broken').ok).toBe(false);
  });
});

describe('review stays reviewable', () => {
  it('caps the number of changes and says what was dropped', () => {
    const many = Array.from({ length: MAX_PROPOSED_CHANGES + 10 }, (_, i) => ({
      label: `Concept ${i}`,
      kind: 'concept' as const,
    }));
    const { accepted, rejected } = validateCompletion({ ...EMPTY, newNodes: many }, GRAPH);

    expect(countChanges(accepted)).toBeLessThanOrEqual(MAX_PROPOSED_CHANGES);
    // Silent truncation would read as "this is everything it found".
    expect(rejected.some((r) => /only the first/i.test(r.reason))).toBe(true);
  });
});
