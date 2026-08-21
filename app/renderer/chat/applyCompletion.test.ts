/**
 * Applying a proposal: the label→id resolution, the ordering, and the promise
 * that one bad change never takes the batch down with it.
 */

import { describe, expect, it, vi } from 'vitest';

import { applyCompletion, type ApplyDeps } from './applyCompletion';
import { cellMarkdownFor } from '../shared/conceptCell';
import { edgeChangeKey, edgeKey, groupingKey, nodeKey } from './proposals';
import type { MapCompletion } from '../../../shared/types/completion';
import type { GraphNode, KnowledgeGraph } from '../../../shared/types/graph';

const AT = '2026-08-06T00:00:00.000Z';

function node(id: string, label: string, kind: GraphNode['kind'] = 'concept'): GraphNode {
  return {
    id,
    label,
    normalizedLabel: label.toLowerCase(),
    kind,
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 0,
    centrality: 0,
    cluster: 0,
  };
}

const GRAPH = {
  schemaVersion: 1,
  id: 'g1',
  name: 'test',
  createdAt: AT,
  updatedAt: AT,
  cells: [],
  nodes: [node('n1', 'EUV'), node('n2', 'ASML'), node('g1', 'Supply', 'group')],
  edges: [{ id: 'e1', source: 'n2', target: 'n1', relation: 'supports', weight: 1, directed: true }],
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
} as unknown as KnowledgeGraph;

const GRAPH_WITH_SUBNODES = {
  ...GRAPH,
  nodes: GRAPH.nodes.map((entry) =>
    entry.id === 'n1'
      ? { ...entry, subConcepts: [{ label: 'Power demand' }] }
      : entry.id === 'n2'
        ? { ...entry, subConcepts: [{ label: 'Financing constraint' }] }
        : entry,
  ),
} as KnowledgeGraph;

const EMPTY: MapCompletion = { newNodes: [], newEdges: [], edgeChanges: [], groupAdditions: [] };

function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps & { calls: string[] } {
  const calls: string[] = [];
  let next = 0;
  return {
    calls,
    addNode: vi.fn(async (label: string) => {
      calls.push(`addNode:${label}`);
      next += 1;
      return `new-${next}`;
    }),
    createCell: vi.fn(async (markdown: string) => {
      calls.push(`createCell:${markdown}`);
    }),
    removeNode: vi.fn(async (nodeId: string) => {
      calls.push(`removeNode:${nodeId}`);
    }),
    setNodeGroup: vi.fn(async (nodeId: string, groupId: string) => {
      calls.push(`setNodeGroup:${nodeId}:${groupId}`);
    }),
    addEdge: vi.fn(async (source: string, target: string, relation: string) => {
      calls.push(`addEdge:${source}->${target}:${relation}`);
      next += 1;
      return `edge-${next}`;
    }),
    setEdgeNote: vi.fn(async (edgeId: string, note: string) => {
      calls.push(`setEdgeNote:${edgeId}:${note}`);
    }),
    replaceEdge: vi.fn(async (edgeId: string, source: string, target: string, relation: string) => {
      calls.push(`replaceEdge:${edgeId}:${source}->${target}:${relation}`);
      return 'edge-replaced';
    }),
    ...overrides,
  } as ApplyDeps & { calls: string[] };
}

/*
 * A concept the chat proposed with facets beneath it. Accepting one has to
 * write BOTH — a node whose sub-concepts live only in the proposal would show
 * them in review and then lose them on apply.
 */
describe('a concept accepted with subnodes', () => {
  const withFacets: MapCompletion = {
    ...EMPTY,
    newNodes: [
      {
        label: 'Self-hosted inference',
        kind: 'concept',
        note: 'Capable models running on ordinary machines.',
        subConcepts: [
          { label: 'Local model weights', note: 'Downloaded once, run offline.' },
          { label: 'Consumer GPU ceiling' },
        ],
      },
    ],
  };

  it('writes the facets into the cell, so the core derives them back', async () => {
    const applyDeps = deps();

    const report = await applyCompletion(
      withFacets,
      new Set([nodeKey('Self-hosted inference')]),
      GRAPH,
      applyDeps,
    );

    expect(report.failures).toEqual([]);
    const written = applyDeps.calls.find((call) => call.startsWith('createCell:')) ?? '';
    expect(written).toContain('[[Self-hosted inference]]');
    expect(written).toContain('Capable models running on ordinary machines.');
    expect(written).toContain('[[Local model weights]]');
    expect(written).toContain('Downloaded once, run offline.');
    // A facet with nothing said about it is still a facet.
    expect(written).toContain('[[Consumer GPU ceiling]]');
  });

  it('still writes the plain one-line cell when there are no facets', async () => {
    const applyDeps = deps();

    await applyCompletion(
      { ...EMPTY, newNodes: [{ label: 'Heat Rate', kind: 'metric', note: 'Fuel per unit.' }] },
      new Set([nodeKey('Heat Rate')]),
      GRAPH,
      applyDeps,
    );

    expect(applyDeps.calls).toContain('createCell:[[Heat Rate]] Fuel per unit.');
  });
});

describe('the cell an accepted concept becomes', () => {
  it('is what the author would have typed', () => {
    // The Editor lists CELLS. A node created without one never appears there
    // and can never be deleted, because deleting a concept means deleting the
    // text that asserts it.
    expect(cellMarkdownFor('Heat Rate', 'Fuel per unit of output.')).toBe(
      '[[Heat Rate]] Fuel per unit of output.',
    );
  });

  it('is just the link when there is no note', () => {
    expect(cellMarkdownFor('Heat Rate')).toBe('[[Heat Rate]]');
    expect(cellMarkdownFor('Heat Rate', '   ')).toBe('[[Heat Rate]]');
  });

  it('strips brackets out of the note', () => {
    // One cell is one node and everything else bracketed hangs beneath it, so
    // a stray [[...]] in the model's prose would silently become a sub-concept.
    expect(cellMarkdownFor('Heat Rate', 'Related to [[EUV]] and [[ASML]].')).toBe(
      '[[Heat Rate]] Related to EUV and ASML.',
    );
  });

  it('flattens newlines, so the note stays on the line that names the concept', () => {
    // The core takes a concept's description from the LINE its link sits on.
    // A note spread over several lines would lose everything after the first.
    expect(cellMarkdownFor('Heat Rate', 'First point.\n\nSecond point.')).toBe(
      '[[Heat Rate]] First point. Second point.',
    );
  });
});

describe('creating concepts', () => {
  it('adds the concept and keeps the reasoning that justified it', () => {
    const completion: MapCompletion = {
      ...EMPTY,
      newNodes: [{ label: 'Heat Rate', kind: 'metric', note: 'Fuel burned per unit of output.' }],
    };
    const api = deps();

    return applyCompletion(completion, new Set([nodeKey('Heat Rate')]), GRAPH, api).then(
      (report) => {
        expect(report.applied).toBe(1);
        expect(report.failures).toEqual([]);
        // A CELL, not just a node — that is what puts it in the Editor, and
        // what lets the author delete it later by deleting the text.
        expect(api.calls).toContain('createCell:[[Heat Rate]] Fuel burned per unit of output.');
      },
    );
  });

  it('skips a concept the author unchecked', async () => {
    const completion: MapCompletion = {
      ...EMPTY,
      newNodes: [{ label: 'Heat Rate', kind: 'concept' }],
    };
    const api = deps();

    const report = await applyCompletion(completion, new Set(), GRAPH, api);
    // Not applied and not a failure — declining a change is a decision.
    expect(report).toEqual({ applied: 0, failures: [] });
    expect(api.addNode).not.toHaveBeenCalled();
  });

  it('places it in a named group', async () => {
    const completion: MapCompletion = {
      ...EMPTY,
      newNodes: [{ label: 'Lithography', kind: 'concept', group: 'Supply' }],
    };
    const api = deps();

    await applyCompletion(completion, new Set([nodeKey('Lithography')]), GRAPH, api);
    expect(api.calls).toContain('setNodeGroup:new-1:g1');
  });
});

describe('drawing relationships', () => {
  it('resolves labels to the ids the graph actually holds', async () => {
    const completion: MapCompletion = {
      ...EMPTY,
      newEdges: [{ source: 'euv', target: 'ASML', relation: 'affects', note: 'why' }],
    };
    const api = deps();

    const report = await applyCompletion(completion, new Set([edgeKey('euv', 'ASML')]), GRAPH, api);
    expect(report.applied).toBe(1);
    expect(api.calls).toContain('addEdge:n1->n2:affects');
    expect(api.calls).toContain('setEdgeNote:edge-1:why');
  });

  it('resolves against a concept created earlier in the same apply', async () => {
    // Concepts are applied before the edges that reference them, so a chain of
    // new ideas plus the links between them lands in one click.
    const completion: MapCompletion = {
      ...EMPTY,
      newNodes: [{ label: 'Interconnect Queue', kind: 'concept' }],
      newEdges: [{ source: 'Interconnect Queue', target: 'EUV', relation: 'causes' }],
    };
    const api = deps();

    const report = await applyCompletion(
      completion,
      new Set([nodeKey('Interconnect Queue'), edgeKey('Interconnect Queue', 'EUV')]),
      GRAPH,
      api,
    );
    expect(report.applied).toBe(2);
    expect(api.calls).toContain('addEdge:new-1->n1:causes');
  });

  it('reports an edge whose concept the author unchecked, rather than throwing', async () => {
    const completion: MapCompletion = {
      ...EMPTY,
      newNodes: [{ label: 'Interconnect Queue', kind: 'concept' }],
      newEdges: [{ source: 'Interconnect Queue', target: 'EUV', relation: 'causes' }],
    };
    const api = deps();

    const report = await applyCompletion(
      completion,
      new Set([edgeKey('Interconnect Queue', 'EUV')]),
      GRAPH,
      api,
    );
    expect(report.applied).toBe(0);
    expect(report.failures[0]?.reason).toMatch(/Interconnect Queue.*not in the graph/);
  });

  it('materializes existing nested endpoints without creating top-level cells', async () => {
    const edge = {
      source: 'Power demand',
      sourceParent: 'EUV',
      target: 'Financing constraint',
      targetParent: 'ASML',
      relation: 'affects' as const,
      note: 'A cross-parent mechanism.',
    };
    const api = deps();

    const report = await applyCompletion(
      { ...EMPTY, newEdges: [edge] },
      new Set([edgeKey(edge.source, edge.target, edge.sourceParent, edge.targetParent)]),
      GRAPH_WITH_SUBNODES,
      api,
    );

    expect(report).toEqual({ applied: 1, failures: [] });
    expect(api.calls).toContain('addNode:Power demand');
    expect(api.calls).toContain('addNode:Financing constraint');
    expect(api.createCell).not.toHaveBeenCalled();
    expect(api.calls).toContain('addEdge:new-1->new-2:affects');
  });

  it('blocks stale promotion nodes from an already-running main process', async () => {
    const edge = {
      source: 'Power demand',
      target: 'Financing constraint',
      relation: 'affects' as const,
    };
    const api = deps();

    const report = await applyCompletion(
      {
        ...EMPTY,
        newNodes: [
          { label: 'Power demand', kind: 'concept' },
          { label: 'Financing constraint', kind: 'concept' },
        ],
        newEdges: [edge],
      },
      new Set([
        nodeKey('Power demand'),
        nodeKey('Financing constraint'),
        edgeKey(edge.source, edge.target),
      ]),
      GRAPH_WITH_SUBNODES,
      api,
      'subnode-subnode',
    );

    expect(report).toEqual({ applied: 1, failures: [] });
    expect(api.createCell).not.toHaveBeenCalled();
    expect(api.calls.filter((call) => call.startsWith('addNode:'))).toEqual([
      'addNode:Power demand',
      'addNode:Financing constraint',
    ]);
  });
});

describe('changing a relationship', () => {
  it('replaces the existing edge and moves the note onto the new one', async () => {
    // replaceEdge mints a new id, so writing the note to the old one would
    // silently lose it.
    const completion: MapCompletion = {
      ...EMPTY,
      edgeChanges: [{ source: 'ASML', target: 'EUV', relation: 'depends_on', note: 'sharper' }],
    };
    const api = deps();

    const report = await applyCompletion(
      completion,
      new Set([edgeChangeKey('ASML', 'EUV')]),
      GRAPH,
      api,
    );
    expect(report.applied).toBe(1);
    expect(api.calls).toContain('replaceEdge:e1:n2->n1:depends_on');
    expect(api.calls).toContain('setEdgeNote:edge-replaced:sharper');
  });

  it('reports a relationship that has since been deleted', async () => {
    const completion: MapCompletion = {
      ...EMPTY,
      edgeChanges: [{ source: 'EUV', target: 'ASML', relation: 'causes' }],
    };
    const api = deps();

    const report = await applyCompletion(
      completion,
      new Set([edgeChangeKey('EUV', 'ASML')]),
      GRAPH,
      api,
    );
    expect(report.applied).toBe(0);
    expect(report.failures[0]?.reason).toMatch(/no longer in the graph/);
  });
});

describe('grouping', () => {
  it('moves an existing concept into an existing group', async () => {
    const api = deps();
    const report = await applyCompletion(
      { ...EMPTY, groupAdditions: [{ node: 'EUV', group: 'Supply' }] },
      new Set([groupingKey('EUV', 'Supply')]),
      GRAPH,
      api,
    );
    expect(report.applied).toBe(1);
    expect(api.calls).toContain('setNodeGroup:n1:g1');
  });

  it('refuses a target that is not a group', async () => {
    const api = deps();
    const report = await applyCompletion(
      { ...EMPTY, groupAdditions: [{ node: 'EUV', group: 'ASML' }] },
      new Set([groupingKey('EUV', 'ASML')]),
      GRAPH,
      api,
    );
    expect(report.applied).toBe(0);
    expect(api.setNodeGroup).not.toHaveBeenCalled();
  });
});

describe('when a concept is created but its cell cannot be written', () => {
  it('takes the node back out rather than leaving one nothing can reach', async () => {
    // A concept with no cell is UNREACHABLE, not partially applied: the Editor
    // lists cells so it is absent there, and NodeDetail offers delete only for
    // groups. Keeping it strands it in the graph permanently. Not creating it
    // is strictly better than creating something the author cannot remove.
    const api = deps({
      createCell: vi.fn(async () => {
        throw new Error('Blocked IPC invoke on unknown channel: cell:upsert');
      }),
    });

    const report = await applyCompletion(
      { ...EMPTY, newNodes: [{ label: 'Heat Rate', kind: 'metric', note: 'why it matters' }] },
      new Set([nodeKey('Heat Rate')]),
      GRAPH,
      api,
    );

    expect(api.calls).toContain('removeNode:new-1');
    expect(report.applied).toBe(0);
    expect(report.failures).toEqual([
      {
        subject: 'Heat Rate',
        reason:
          'its cell could not be written, so the concept was not added: ' +
          'Blocked IPC invoke on unknown channel: cell:upsert',
      },
    ]);
  });

  it('reports an edge naming the rolled-back concept rather than pointing it at nothing', async () => {
    const api = deps({
      createCell: vi.fn(async () => {
        throw new Error('nope');
      }),
    });

    const report = await applyCompletion(
      {
        ...EMPTY,
        newNodes: [{ label: 'Heat Rate', kind: 'metric', note: 'why' }],
        newEdges: [{ source: 'Heat Rate', target: 'EUV', relation: 'affects' }],
      },
      new Set([nodeKey('Heat Rate'), edgeKey('Heat Rate', 'EUV')]),
      GRAPH,
      api,
    );

    expect(report.applied).toBe(0);
    expect(api.addEdge).not.toHaveBeenCalled();
    expect(report.failures[1]).toEqual({
      subject: 'Heat Rate → EUV',
      reason: '"Heat Rate" is not in the graph',
    });
  });

  it('keeps the concept when the rollback itself fails, and says it is stranded', async () => {
    // Rollback is a best effort. If it also fails there is nothing further to
    // try, and the author needs to be told the node is sitting there rather
    // than left to find it on the canvas with no explanation.
    const api = deps({
      createCell: vi.fn(async () => {
        throw new Error('disk full');
      }),
      removeNode: vi.fn(async () => {
        throw new Error('core refused');
      }),
    });

    const report = await applyCompletion(
      { ...EMPTY, newNodes: [{ label: 'Heat Rate', kind: 'metric' }] },
      new Set([nodeKey('Heat Rate')]),
      GRAPH,
      api,
    );

    expect(report.applied).toBe(0);
    expect(report.failures[0]?.reason).toContain('disk full');
    expect(report.failures[0]?.reason).toContain('still in the graph');
  });

  it('does not roll back a concept that already existed before the apply', async () => {
    // addNode dedups by normalized label, so an accepted concept the author
    // already had returns the EXISTING node id. Removing it on a cell failure
    // would delete work the proposal never created.
    const api = deps({
      addNode: vi.fn(async () => 'n1'),
      createCell: vi.fn(async () => {
        throw new Error('nope');
      }),
    });

    const report = await applyCompletion(
      { ...EMPTY, newNodes: [{ label: 'EUV', kind: 'concept' }] },
      new Set([nodeKey('EUV')]),
      GRAPH,
      api,
    );

    expect(api.removeNode).not.toHaveBeenCalled();
    expect(report.applied).toBe(0);
  });

  it('reports the concept as failed when the concept itself could not be created', async () => {
    const api = deps({
      addNode: vi.fn(async () => {
        throw new Error('label collides with another node');
      }),
    });

    const report = await applyCompletion(
      { ...EMPTY, newNodes: [{ label: 'Heat Rate', kind: 'metric', note: 'why' }] },
      new Set([nodeKey('Heat Rate')]),
      GRAPH,
      api,
    );

    expect(report.applied).toBe(0);
    expect(report.failures).toEqual([
      { subject: 'Heat Rate', reason: 'label collides with another node' },
    ]);
    // No cell for a concept that does not exist.
    expect(api.createCell).not.toHaveBeenCalled();
  });
});

describe('when the graph refuses a change', () => {
  it('applies the rest and names the one that failed', async () => {
    // The alternative is an author who accepted five changes, got none, and
    // has nothing on screen explaining why.
    const completion: MapCompletion = {
      ...EMPTY,
      newNodes: [
        { label: 'First', kind: 'concept' },
        { label: 'Doomed', kind: 'concept' },
        { label: 'Third', kind: 'concept' },
      ],
    };
    const api = deps({
      addNode: vi.fn(async (label: string) => {
        if (label === 'Doomed') throw new Error('label collides with another node');
        return `new-${label}`;
      }),
    });

    const report = await applyCompletion(
      completion,
      new Set([nodeKey('First'), nodeKey('Doomed'), nodeKey('Third')]),
      GRAPH,
      api,
    );

    expect(report.applied).toBe(2);
    expect(report.failures).toEqual([
      { subject: 'Doomed', reason: 'label collides with another node' },
    ]);
  });
});
