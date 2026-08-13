import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, SCHEMA_VERSION, type Cell, type GraphNode, type KnowledgeGraph } from '../../shared/types/graph';
import { ensureNodeCellCoverage, firstCellConcept } from './graph-cell-coverage';

const TIME = '2026-08-08T22:30:00.000Z';

function cell(id: string, markdown: string, order = 0): Cell {
  return { id, order, markdown, createdAt: TIME, updatedAt: TIME };
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    label: 'Capital Cycle',
    normalizedLabel: 'capital cycle',
    kind: 'concept',
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 0,
    centrality: 0,
    cluster: 0,
    ...overrides,
  };
}

function graph(nodes: GraphNode[], cells: Cell[] = []): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'v1',
    name: 'Coverage',
    createdAt: TIME,
    updatedAt: TIME,
    cells,
    nodes,
    edges: [],
    view: DEFAULT_VIEW,
  };
}

describe('firstCellConcept', () => {
  it('matches aliases and ignores links inside fenced code', () => {
    const markdown = '```md\n[[Not this]]\n```\nText [[Capital Cycle|the cycle]]';

    expect(firstCellConcept(markdown)).toBe('capital cycle');
  });
});

describe('ensureNodeCellCoverage', () => {
  it('turns a canvas-only content node into a full editable cell', () => {
    const input = graph([
      node({
        note: 'CENTRAL QUESTION\nDoes capex compound?\nSee [[unsafe link]].',
        subConcepts: [{ label: 'Reinvestment Rate', note: 'The useful detail.' }],
      }),
    ]);

    const repair = ensureNodeCellCoverage(input, () => TIME);

    expect(repair.addedCellCount).toBe(1);
    expect(repair.repairedNodeIds).toEqual(['n1']);
    expect(repair.graph.nodes[0]?.cellIds).toEqual(['cell-for-n1']);
    expect(repair.graph.cells[0]?.markdown).toContain('[[Capital Cycle]]');
    expect(repair.graph.cells[0]?.markdown).toContain('CENTRAL QUESTION\nDoes capex compound?');
    expect(repair.graph.cells[0]?.markdown).toContain('See unsafe link.');
    expect(repair.graph.cells[0]?.markdown).toContain(
      '- [[Reinvestment Rate]] — The useful detail.',
    );
  });

  it('reuses an authored cell when its node forgot the reverse reference', () => {
    const input = graph([node()], [cell('written', '## Thesis\n[[Capital Cycle]] matters')]);

    const repair = ensureNodeCellCoverage(input, () => TIME);

    expect(repair.addedCellCount).toBe(0);
    expect(repair.graph.nodes[0]?.cellIds).toEqual(['written']);
    expect(repair.repairedNodeIds).toEqual(['n1']);
  });

  it('removes dangling references and adds a dedicated canonical cell', () => {
    const input = graph(
      [node({ cellIds: ['missing', 'other'] })],
      [cell('other', '[[Different concept]]')],
    );

    const repair = ensureNodeCellCoverage(input, () => TIME);

    expect(repair.removedDanglingCellRefs).toBe(1);
    expect(repair.graph.nodes[0]?.cellIds).toEqual(['other', 'cell-for-n1']);
    expect(repair.graph.cells).toHaveLength(2);
  });

  it('repairs every content node while leaving structural groups cell-free', () => {
    const input = graph([
      node(),
      node({ id: 'n2', label: 'Second', normalizedLabel: 'second', kind: 'claim' }),
      node({ id: 'g1', label: 'Macro', normalizedLabel: 'macro', kind: 'group' }),
    ]);

    const repair = ensureNodeCellCoverage(input, () => TIME);

    expect(repair.graph.cells.map((entry) => entry.id)).toEqual(['cell-for-n1', 'cell-for-n2']);
    expect(repair.graph.nodes.find((entry) => entry.id === 'g1')?.cellIds).toEqual([]);
  });

  it('keeps a materialized subnode underneath its parent instead of creating a cell', () => {
    const input = graph([
      node({ subConcepts: [{ label: 'Power demand' }] }),
      node({ id: 'nested', label: 'Power demand', normalizedLabel: 'power demand' }),
    ], [cell('parent-cell', '[[Capital Cycle]]\n- [[Power demand]]')]);

    const repair = ensureNodeCellCoverage(input, () => TIME);

    expect(repair.graph.nodes.find((entry) => entry.id === 'nested')?.cellIds).toEqual([]);
    expect(repair.graph.cells.some((entry) => entry.markdown === '[[Power demand]]')).toBe(false);
  });

  it('is idempotent and never duplicates its generated cells', () => {
    const first = ensureNodeCellCoverage(graph([node()]), () => TIME);
    const second = ensureNodeCellCoverage(first.graph, () => TIME);

    expect(second.changed).toBe(false);
    expect(second.addedCellCount).toBe(0);
    expect(second.graph).toBe(first.graph);
  });

  it('uses a collision-safe id without overwriting an existing cell', () => {
    const input = graph([node()], [cell('cell-for-n1', 'A draft with no concept')]);

    const repair = ensureNodeCellCoverage(input, () => TIME);

    expect(repair.graph.cells.map((entry) => entry.id)).toEqual([
      'cell-for-n1',
      'cell-for-n1-2',
    ]);
    expect(repair.graph.nodes[0]?.cellIds).toEqual(['cell-for-n1-2']);
  });
});
