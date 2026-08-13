/**
 * The YAML export.
 *
 * The interesting risk is escaping. Concept labels and notes are arbitrary
 * author text — colons, leading dashes, `#`, quotes, newlines — and YAML gives
 * every one of those a meaning. So the central test is a ROUND TRIP: parse the
 * export back and assert it equals what went in. A file that reads back as
 * something subtly different is worse than one that fails outright.
 */

import { parse } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildKnowledgeMap } from '../outline';
import {
  exportGraphYaml,
  isExportable,
  serializeMapYaml,
  toYamlFileName,
} from '../exportYaml';
import {
  DEFAULT_VIEW,
  SCHEMA_VERSION,
  type GraphNode,
  type KnowledgeGraph,
} from '../../../../shared/types/graph';

const AT = '2026-08-06T00:00:00.000Z';
const SAVED = { saved: true, path: '/tmp/map.yaml', bytes: 120 };

function node(id: string, label: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label,
    normalizedLabel: label.toLowerCase(),
    kind: 'concept',
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 0,
    centrality: 0,
    cluster: 0,
    ...extra,
  };
}

function graphOf(
  nodes: GraphNode[],
  edges: KnowledgeGraph['edges'] = [],
  name = 'Power Markets',
): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'g1',
    name,
    createdAt: AT,
    updatedAt: AT,
    cells: [],
    nodes,
    edges,
    view: DEFAULT_VIEW,
  };
}

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'graph:snapshot') return Promise.resolve(SNAPSHOT);
    if (channel === 'export:yaml') return Promise.resolve(SAVED);
    throw new Error(`unexpected channel ${channel}`);
  });
  vi.stubGlobal('window', { braindump: { invoke, on: () => () => {} } });
});

const SNAPSHOT = graphOf(
  [node('n1', 'EUV'), node('n2', 'ASML')],
  [{ id: 'e1', source: 'n1', target: 'n2', relation: 'affects', weight: 1, directed: true }],
);

describe('serializing', () => {
  it('writes flat node and relationship tables in readable YAML', () => {
    const text = serializeMapYaml(buildKnowledgeMap(SNAPSHOT, AT));

    expect(text).toContain('name: Power Markets');
    expect(text).toContain('formatVersion: 1');
    expect(text).toContain('relation: affects');
    // Endpoints are ids, and the node they name is listed once, elsewhere.
    expect(text).toContain('from: n1');
    expect(text).toContain('to: n2');
    // No JSON punctuation — the whole reason for the format change.
    expect(text).not.toContain('"nodes"');
  });

  it('carries no layout state', () => {
    const text = serializeMapYaml(buildKnowledgeMap(SNAPSHOT, AT));
    for (const noise of ['damping', 'repulsion', 'theta', 'cluster', 'pinned', 'zoom']) {
      expect(text).not.toContain(noise);
    }
  });

  it('round-trips labels full of YAML metacharacters', () => {
    // Each of these means something to a YAML parser unquoted.
    const hostile = graphOf([
      node('n1', 'Rates: the binding constraint'),
      node('n2', '- leading dash'),
      node('n3', '# not a comment'),
      node('n4', 'quote " and \' apostrophe'),
      node('n5', 'yes'),
      node('n6', '2026-08-06'),
    ]);

    const document = buildKnowledgeMap(hostile, AT);
    const parsed = parse(serializeMapYaml(document));

    expect(parsed).toEqual(document);
    // "yes" and a date must come back as the strings they were, not as a
    // boolean and a Date.
    const names = Object.values(parsed.nodes).map((entry) => (entry as { name: unknown }).name);
    expect(names).toContain('yes');
    expect(names).toContain('2026-08-06');
  });

  it('round-trips a multi-line description as a literal block', () => {
    const withNote = graphOf([
      node('n1', 'Heat Rate', {
        note: 'Fuel burned per unit of output.\n\nRises as a plant ages, which is why\nolder units set the clearing price.',
      }),
    ]);

    const document = buildKnowledgeMap(withNote, AT);
    const text = serializeMapYaml(document);

    expect(text).toContain('|-');
    expect(parse(text)).toEqual(document);
  });

  it('round-trips a relationship note', () => {
    const withEdgeNote = graphOf(
      [node('n1', 'EUV'), node('n2', 'ASML')],
      [
        {
          id: 'e1',
          source: 'n1',
          target: 'n2',
          relation: 'affects',
          weight: 1,
          directed: true,
          note: 'Why: the tool is the bottleneck.\nAnd it stays one.',
        },
      ],
    );

    const document = buildKnowledgeMap(withEdgeNote, AT);
    const parsed = parse(serializeMapYaml(document));

    expect(parsed).toEqual(document);
    expect(parsed.relationshipNotes['relationship-note-e1'].relationship).toBe('e1');
  });

  it('ends with a newline', () => {
    expect(serializeMapYaml(buildKnowledgeMap(SNAPSHOT, AT)).endsWith('\n')).toBe(true);
  });

  it('is byte-identical for the same graph and timestamp', () => {
    expect(serializeMapYaml(buildKnowledgeMap(SNAPSHOT, AT))).toBe(
      serializeMapYaml(buildKnowledgeMap(SNAPSHOT, AT)),
    );
  });
});

describe('exportGraphYaml', () => {
  it('reads the snapshot and hands the text to main', async () => {
    const result = await exportGraphYaml();

    expect(result).toEqual(SAVED);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['graph:snapshot', 'export:yaml']);

    const payload = invoke.mock.calls[1]?.[1] as { suggestedName: string; text: string };
    expect(payload.suggestedName).toBe('Power Markets.yaml');
    expect(payload.text).toContain('EUV');
  });

  it('honours a chosen filename', async () => {
    await exportGraphYaml({ suggestedName: 'chosen.yaml' });
    expect((invoke.mock.calls[1]?.[1] as { suggestedName: string }).suggestedName).toBe(
      'chosen.yaml',
    );
  });

  it('reports a dismissed save dialog as a result, not an error', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'graph:snapshot'
        ? Promise.resolve(SNAPSHOT)
        : Promise.resolve({ saved: false }),
    );
    await expect(exportGraphYaml()).resolves.toEqual({ saved: false });
  });

  it('refuses an empty vault rather than writing an empty file', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'graph:snapshot' ? Promise.resolve(graphOf([])) : Promise.resolve(SAVED),
    );
    await expect(exportGraphYaml()).rejects.toThrow(/nothing to export/i);
  });

  it('surfaces a write failure instead of reporting success', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'graph:snapshot') return Promise.resolve(SNAPSHOT);
      return Promise.reject(new Error('disk full'));
    });
    await expect(exportGraphYaml()).rejects.toThrow('disk full');
  });
});

describe('toYamlFileName', () => {
  it('appends the extension', () => {
    expect(toYamlFileName('Macro Notes')).toBe('Macro Notes.yaml');
  });

  it('replaces characters a filesystem will not take', () => {
    expect(toYamlFileName('a/b:c*d?')).toBe('a-b-c-d-.yaml');
  });

  it('falls back when the name is blank', () => {
    expect(toYamlFileName('   ')).toBe('magistral.yaml');
  });

  it('does not double the extension', () => {
    expect(toYamlFileName('graph.yaml')).toBe('graph.yaml');
  });
});

describe('isExportable', () => {
  it('is false for an empty vault and true once anything exists', () => {
    expect(isExportable(graphOf([]))).toBe(false);
    expect(isExportable(SNAPSHOT)).toBe(true);
  });
});
