import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, SCHEMA_VERSION, type KnowledgeGraph } from '../../../shared/types/graph';
import {
  parseKnowledgeGraph,
  validateExtractionResult,
  validateKnowledgeGraph,
} from './graph-schema';

function graph(overrides: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'vault-1',
    name: 'Test',
    createdAt: now,
    updatedAt: now,
    cells: [],
    nodes: [],
    edges: [],
    view: DEFAULT_VIEW,
    ...overrides,
  };
}

describe('validateKnowledgeGraph', () => {
  it('accepts an empty graph', () => {
    expect(validateKnowledgeGraph(graph()).ok).toBe(true);
  });

  it('accepts a populated graph', () => {
    const result = validateKnowledgeGraph(
      graph({
        cells: [
          {
            id: 'c1',
            order: 0,
            markdown: '# Heading',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        nodes: [
          {
            id: 'n1',
            label: 'Capex',
            normalizedLabel: 'capex',
            kind: 'metric',
            cellIds: ['c1'],
            x: 0,
            y: 0,
            pinned: false,
            degree: 1,
            centrality: 0.5,
            cluster: 0,
            color: '#7aa2d6',
          },
          {
            id: 'n2',
            label: 'Fabs',
            normalizedLabel: 'fabs',
            kind: 'entity',
            cellIds: ['c1'],
            x: 1,
            y: 1,
            pinned: true,
            degree: 1,
            centrality: 0.5,
            cluster: 0,
          },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', relation: 'depends_on', weight: 1, directed: true },
        ],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a wrong schemaVersion', () => {
    const result = validateKnowledgeGraph({ ...graph(), schemaVersion: 2 });

    expect(result.ok).toBe(false);
  });

  it('rejects an unknown top-level property', () => {
    const result = validateKnowledgeGraph({ ...graph(), sneaky: true });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/unexpected property "sneaky"/);
  });

  it('rejects a node with an unknown kind', () => {
    const result = validateKnowledgeGraph(
      graph({
        nodes: [
          {
            id: 'n1',
            label: 'X',
            normalizedLabel: 'x',
            kind: 'nonsense' as never,
            cellIds: [],
            x: 0,
            y: 0,
            pinned: false,
            degree: 0,
            centrality: 0,
            cluster: 0,
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an edge with zero weight — the schema requires it to be positive', () => {
    const result = validateKnowledgeGraph(
      graph({
        edges: [{ id: 'e', source: 'a', target: 'b', relation: 'causes', weight: 0, directed: true }],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects a colour that is not a six-digit hex', () => {
    const result = validateKnowledgeGraph(
      graph({
        nodes: [
          {
            id: 'n',
            label: 'X',
            normalizedLabel: 'x',
            kind: 'concept',
            cellIds: [],
            x: 0,
            y: 0,
            pinned: false,
            degree: 0,
            centrality: 0,
            cluster: 0,
            color: 'red',
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects centrality outside 0..1', () => {
    const result = validateKnowledgeGraph(
      graph({
        nodes: [
          {
            id: 'n',
            label: 'X',
            normalizedLabel: 'x',
            kind: 'concept',
            cellIds: [],
            x: 0,
            y: 0,
            pinned: false,
            degree: 0,
            centrality: 1.5,
            cluster: 0,
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(validateKnowledgeGraph('nope').ok).toBe(false);
    expect(validateKnowledgeGraph(null).ok).toBe(false);
  });
});

describe('parseKnowledgeGraph', () => {
  it('parses valid JSON text', () => {
    const result = parseKnowledgeGraph(JSON.stringify(graph()));

    expect(result.ok).toBe(true);
  });

  it('reports malformed JSON without throwing', () => {
    const result = parseKnowledgeGraph('{"schemaVersion":');

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/not valid JSON/);
  });
});

describe('validateExtractionResult', () => {
  it('accepts nodes and edges', () => {
    const result = validateExtractionResult({
      nodes: [{ label: 'Binding constraint', kind: 'concept', note: 'the limiter' }],
      edges: [{ source: 'Binding constraint', target: 'Capex', relation: 'causes', weight: 2 }],
    });

    expect(result.ok).toBe(true);
  });

  it('accepts empty arrays', () => {
    expect(validateExtractionResult({ nodes: [], edges: [] }).ok).toBe(true);
  });

  it('rejects a missing edges array', () => {
    expect(validateExtractionResult({ nodes: [] }).ok).toBe(false);
  });

  it('rejects an unknown relation', () => {
    const result = validateExtractionResult({
      nodes: [],
      edges: [{ source: 'a', target: 'b', relation: 'vibes_with' }],
    });

    expect(result.ok).toBe(false);
  });

  it('rejects an empty label', () => {
    const result = validateExtractionResult({ nodes: [{ label: '', kind: 'concept' }], edges: [] });

    expect(result.ok).toBe(false);
  });

  it('rejects extra properties the core would silently ignore', () => {
    const result = validateExtractionResult({
      nodes: [{ label: 'X', kind: 'concept', confidence: 0.9 }],
      edges: [],
    });

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('vaults written before a schema change still open', () => {
  const base = {
    schemaVersion: 1,
    id: 'v1',
    name: 'investor',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    cells: [],
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
  };

  const withSubConcepts = (subConcepts: unknown): string =>
    JSON.stringify({
      ...base,
      nodes: [
        {
          id: 'n1',
          label: 'grid-energy prices',
          normalizedLabel: 'grid energy prices',
          kind: 'concept',
          cellIds: ['c1'],
          x: 0,
          y: 0,
          pinned: false,
          degree: 0,
          centrality: 0,
          cluster: 0,
          subConcepts,
        },
      ],
    });

  it('reads subConcepts written as bare strings', () => {
    // Shipped shape before notes existed. Tightening the schema to objects
    // locked real users out of their own vaults with
    // "expected object, received string" and nothing they could do about it.
    const result = parseKnowledgeGraph(withSubConcepts(['AI data centers', 'power market']));
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  it('reads subConcepts written as objects with notes', () => {
    const result = parseKnowledgeGraph(
      withSubConcepts([{ label: 'AI data centers', note: 'demand is doubling' }]),
    );
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  it('reads a mixture, since a vault can be half-migrated', () => {
    const result = parseKnowledgeGraph(
      withSubConcepts(['power market', { label: 'heat rate', note: 'MMBtu per MWh' }]),
    );
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  it('still rejects a sub-concept that is neither', () => {
    expect(parseKnowledgeGraph(withSubConcepts([42])).ok).toBe(false);
    expect(parseKnowledgeGraph(withSubConcepts([{ note: 'no label' }])).ok).toBe(false);
  });
});
