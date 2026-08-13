import { describe, expect, it } from 'vitest';

import type { GraphNode, KnowledgeGraph } from '../../../../shared/types/graph';
import {
  buildEntityPresentations,
  graphStatus,
  shortGraphName,
} from '../entityPresentation';

const node = (id: string, label: string, cellIds: string[] = []): GraphNode => ({
  id,
  label,
  normalizedLabel: label.toLocaleLowerCase(),
  kind: 'concept',
  cellIds,
  x: 0,
  y: 0,
  pinned: false,
  degree: 0,
  centrality: 0,
  cluster: 0,
});

describe('entity presentation', () => {
  it('keeps canonical prose while giving long graph labels a meaningful short name', () => {
    const canonical = 'AI Capacity Utilization and Unit Economics';
    const short = shortGraphName(canonical);

    expect(short).toContain('AI Capacity');
    expect(short).toContain('Unit Economics');
    expect(short).not.toContain('…');
  });

  it('projects relationship and selection state once for every surface', () => {
    const nodes = [node('a', 'Capacity'), node('b', 'Financing')];
    const presentations = buildEntityPresentations(
      nodes,
      [{ id: 'e', source: 'a', target: 'b', relation: 'depends_on', weight: 1, directed: true }],
      'a',
      'b',
    );

    expect(presentations.get('a')).toMatchObject({ relationshipCount: 1, selectionState: 'selected' });
    expect(presentations.get('b')).toMatchObject({ relationshipCount: 1, selectionState: 'hovered' });
  });

  it('reports mapping in authored-cell terms rather than raw node count', () => {
    const graph = {
      cells: [{ id: 'c1' }, { id: 'c2' }],
      nodes: [node('a', 'Capacity', ['c1'])],
      edges: [],
    } as unknown as KnowledgeGraph;

    expect(graphStatus(graph)).toEqual({ cells: 2, mapped: 1, unlinked: 1, relationships: 0 });
  });
});
