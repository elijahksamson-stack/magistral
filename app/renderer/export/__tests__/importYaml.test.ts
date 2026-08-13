import { describe, expect, test } from 'vitest';
import { planImport, vaultNameFromFile, YamlImportError } from '../importYaml';
import { buildKnowledgeMap } from '../outline';
import { serializeMapYaml } from '../exportYaml';
import type { KnowledgeGraph } from '../../../../shared/types/graph';

const MAP = [
  'formatVersion: 1',
  'name: economy',
  'exportedAt: 2026-08-12T16:53:39.294Z',
  'nodeCount: 3',
  'relationshipCount: 1',
  'nodes:',
  '  n34:',
  '    name: AI Economy',
  '    kind: group',
  '  n139:',
  '    name: AI Capacity',
  '    kind: concept',
  '    group: n34',
  '    note: note-n139',
  '    subConcepts:',
  '      - name: Installed Compute',
  '        note: context-note-1',
  '      - name: Returns Loop',
  '  n111:',
  '    name: Mineral Prices',
  '    kind: concept',
  'notes:',
  '  note-n139:',
  '    owner: n139',
  '    body: Compute becomes productive only when workloads pay for it.',
  '  context-note-1:',
  '    owner: n139',
  '    body: What the installed base actually returns.',
  'relationships:',
  '  e62:',
  '    from: n111',
  '    to: n139',
  '    relation: affects',
  '    directed: true',
  '    weight: 1',
  '    note: relationship-note-e62',
  'relationshipNotes:',
  '  relationship-note-e62:',
  '    relationship: e62',
  '    body: Rising input costs raise the capital needed for the same buildout.',
].join('\n');

describe('planImport', () => {
  test('writes one cell per concept, with its description beneath its heading', () => {
    const plan = planImport(MAP);
    const cell = plan.cells.find((entry) => entry.label === 'Mineral Prices');

    expect(cell?.markdown).toBe('## [[Mineral Prices]]');
  });

  test('nests sub-concepts as sections inside their parent cell', () => {
    const plan = planImport(MAP);
    const cell = plan.cells.find((entry) => entry.label === 'AI Capacity');

    expect(cell?.markdown).toBe(
      [
        '## [[AI Capacity]]',
        '',
        'Compute becomes productive only when workloads pay for it.',
        '',
        '## [[Installed Compute]]',
        '',
        'What the installed base actually returns.',
        '',
        '## [[Returns Loop]]',
      ].join('\n'),
    );
  });

  /*
   * A group is a container the author arranged, not something a cell asserts.
   * Writing a cell for it would put an empty page in the Editor and a duplicate
   * concept on the map.
   */
  test('does not write a cell for a group, but keeps the membership', () => {
    const plan = planImport(MAP);

    expect(plan.cells.map((cell) => cell.label)).not.toContain('AI Economy');
    expect(plan.groups.get('AI Capacity')).toBe('AI Economy');
  });

  test('resolves relationships to labels, carrying the relation and its note', () => {
    const plan = planImport(MAP);

    expect(plan.edges).toEqual([
      {
        fromLabel: 'Mineral Prices',
        toLabel: 'AI Capacity',
        relation: 'affects',
        note: 'Rising input costs raise the capital needed for the same buildout.',
      },
    ]);
  });

  test('reports an edge whose endpoint the file never defined, and imports the rest', () => {
    // Inserted as the last entry of `relationships`, not appended to the file,
    // which would have landed it inside `relationshipNotes` instead.
    const broken = MAP.replace(
      'relationshipNotes:',
      ['  e99:', '    from: n111', '    to: nMISSING', '    relation: affects', 'relationshipNotes:'].join('\n'),
    );
    const plan = planImport(broken);

    expect(plan.skipped).toEqual(['e99']);
    expect(plan.edges).toHaveLength(1);
  });

  test('an unrecognised relation degrades to the untyped default', () => {
    const odd = MAP.replace('relation: affects', 'relation: tastes_like');

    expect(planImport(odd).edges[0]?.relation).toBe('relates_to');
  });

  test('a dangling note key yields no prose rather than the key itself', () => {
    const dangling = MAP.replace('note: note-n139', 'note: note-that-is-absent');
    const plan = planImport(dangling);
    const cell = plan.cells.find((entry) => entry.label === 'AI Capacity');

    expect(cell?.markdown).not.toContain('note-that-is-absent');
    expect(cell?.markdown.startsWith('## [[AI Capacity]]')).toBe(true);
  });

  test('refuses something that is not a knowledge map', () => {
    expect(() => planImport('just: a string')).toThrow(YamlImportError);
    expect(() => planImport('nodes: {}')).toThrow(/no concepts/i);
  });
});

/* The round trip is the point: what the exporter writes, the importer reads. */
describe('round trip through the exporter', () => {
  const AT = '2026-08-12T00:00:00.000Z';
  const graph: KnowledgeGraph = {
    schemaVersion: 1,
    id: 'g1',
    name: 'pairings',
    createdAt: AT,
    updatedAt: AT,
    view: {
      zoom: 1,
      panX: 0,
      panY: 0,
      layout: {
        kind: 'force',
        params: {
          repulsion: 6000,
          attraction: 0.05,
          damping: 0.85,
          gravity: 0.02,
          theta: 0.8,
          linkDistance: 120,
        },
      },
    },
    cells: [],
    edges: [
      {
        id: 'e1',
        source: 'a',
        target: 'b',
        relation: 'supports',
        weight: 1,
        directed: true,
        note: 'Acid cuts fat.',
      },
    ],
    nodes: [
      {
        id: 'a',
        label: 'Champagne',
        normalizedLabel: 'champagne',
        kind: 'concept',
        cellIds: [],
        x: 0,
        y: 0,
        pinned: false,
        degree: 1,
        centrality: 1,
        cluster: 0,
        note: 'Acid and bubbles.',
        subConcepts: [{ label: 'Brut', note: 'Bone dry.' }],
      },
      {
        id: 'b',
        label: 'Fried Starters',
        normalizedLabel: 'fried starters',
        kind: 'concept',
        cellIds: [],
        x: 1,
        y: 1,
        pinned: false,
        degree: 1,
        centrality: 0.5,
        cluster: 0,
      },
    ],
  };

  test('exported YAML imports back to the same concepts and relationships', () => {
    const yaml = serializeMapYaml(buildKnowledgeMap(graph, '2026-08-12T00:00:00.000Z'));
    const plan = planImport(yaml);

    expect(plan.cells.map((cell) => cell.label).sort()).toEqual(['Champagne', 'Fried Starters']);
    expect(plan.edges).toEqual([
      {
        fromLabel: 'Champagne',
        toLabel: 'Fried Starters',
        relation: 'supports',
        note: 'Acid cuts fat.',
      },
    ]);
    expect(plan.cells.find((cell) => cell.label === 'Champagne')?.markdown).toContain('## [[Brut]]');
  });
});

describe('vaultNameFromFile', () => {
  test('names the vault after the file', () => {
    expect(vaultNameFromFile('economy.yaml')).toBe('economy');
    expect(vaultNameFromFile('cuisines & pairings.yml')).toBe('cuisines & pairings');
  });

  test('falls back when the filename is only a suffix', () => {
    expect(vaultNameFromFile('.yaml')).toBe('Imported map');
  });
});
