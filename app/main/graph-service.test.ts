import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, SCHEMA_VERSION, type Cell, type KnowledgeGraph } from '../../shared/types/graph';
import { GraphService, applyCellOrder } from './graph-service';

function cell(id: string, order: number): Cell {
  return {
    id,
    order,
    markdown: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function graph(cells: Cell[]): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'v',
    name: 'Test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cells,
    nodes: [],
    edges: [],
    view: DEFAULT_VIEW,
  };
}

describe('applyCellOrder', () => {
  it('reorders and renumbers to match the requested order', () => {
    const result = applyCellOrder(graph([cell('a', 0), cell('b', 1), cell('c', 2)]), ['c', 'a', 'b']);

    expect(result.cells.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    expect(result.cells.map((entry) => entry.order)).toEqual([0, 1, 2]);
  });

  it('appends cells the order does not mention', () => {
    const result = applyCellOrder(graph([cell('a', 0), cell('b', 1), cell('c', 2)]), ['c']);

    expect(result.cells.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('ignores ids that no longer exist', () => {
    const result = applyCellOrder(graph([cell('a', 0)]), ['ghost', 'a']);

    expect(result.cells.map((entry) => entry.id)).toEqual(['a']);
  });

  it('does not mutate the input document', () => {
    const original = graph([cell('a', 0), cell('b', 1)]);

    applyCellOrder(original, ['b', 'a']);

    expect(original.cells.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(original.cells[0]?.order).toBe(0);
  });

  it('returns the graph untouched for an empty order', () => {
    const original = graph([cell('a', 0)]);

    expect(applyCellOrder(original, [])).toBe(original);
  });
});

/*
 * Descriptions are PERSISTED and restored verbatim by graphFromJSON, so a
 * change to how a [[link]] earns its description would otherwise reach only the
 * cells an author happens to retype next — invisible on a vault they already
 * wrote. Opening re-derives them.
 *
 * Needs the compiled addon. Skipped rather than failed where it is absent, so a
 * checkout that has not run `npm run build:native` still gets a green suite.
 */
describe('opening a vault re-derives its descriptions', () => {
  const service = new GraphService([resolve(process.cwd(), 'build/Release/braindump.node')]);
  const itWithCore = service.isReady() ? it : it.skip;

  itWithCore('replaces a stale whole-paragraph note with per-link descriptions', () => {
    // A vault written under the old rule, where a note was the whole LINE its
    // link sat on: all three concepts carried the same paragraph.
    const stale = graph([
      {
        id: 'c1',
        order: 0,
        markdown:
          '[[Sports]]\n\n[[Basketball]] scores by shot distance. [[Volleyball]] keeps its rotations constant.',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    service.openFromJSON(stale);

    const sports = service.snapshot().nodes.find((node) => node.label === 'Sports');
    const facets = new Map(
      (sports?.subConcepts ?? []).map((sub) => [sub.label, sub.note ?? ''] as const),
    );

    expect(facets.get('Basketball')).toBe('scores by shot distance.');
    expect(facets.get('Volleyball')).toBe('keeps its rotations constant.');
    // The reported bug in one assertion: Basketball must not describe volleyball.
    expect(facets.get('Basketball')).not.toContain('rotations');
  });
});

describe('GraphService in degraded mode', () => {
  const service = new GraphService(['/definitely/not/a/real/braindump.node']);

  it('reports not ready with an actionable reason', () => {
    const status = service.status();

    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/native core was not found/);
    expect(status.reason).toMatch(/npm run build:native/);
  });

  it('throws that reason rather than crashing on a read', () => {
    expect(() => service.snapshot()).toThrow(/native core was not found/);
  });

  it('throws that reason rather than crashing on a write', () => {
    expect(() => service.addNode('X', 'concept')).toThrow(/native core was not found/);
  });

  it('reports no open graph', () => {
    expect(service.hasOpenGraph()).toBe(false);
    expect(service.isReady()).toBe(false);
  });
});
