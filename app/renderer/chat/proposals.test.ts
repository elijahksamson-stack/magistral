/**
 * The review list and its selection rules.
 *
 * The interesting behaviour is dependency handling: a relationship between two
 * proposed concepts cannot be applied without them, so the checkbox has to say
 * so rather than letting the author queue something that will fail.
 */

import { describe, expect, it } from 'vitest';

import {
  allKeys,
  countByKind,
  edgeKey,
  listProposals,
  nodeKey,
  toggleSelection,
} from './proposals';
import type { MapCompletion } from '../../../shared/types/completion';

const EMPTY: MapCompletion = { newNodes: [], newEdges: [], edgeChanges: [], groupAdditions: [] };

const CHAIN: MapCompletion = {
  ...EMPTY,
  newNodes: [
    { label: 'Interconnect Queue', kind: 'concept', note: 'The wait to energise.' },
    { label: 'Capacity Ceiling', kind: 'concept' },
  ],
  newEdges: [
    { source: 'Interconnect Queue', target: 'Capacity Ceiling', relation: 'causes' },
    { source: 'Capacity Ceiling', target: 'EUV', relation: 'affects' },
  ],
  edgeChanges: [{ source: 'ASML', target: 'EUV', relation: 'depends_on', reason: 'too vague' }],
  groupAdditions: [{ node: 'Interconnect Queue', group: 'Supply' }],
};

describe('listing a proposal', () => {
  it('reads each change as a sentence rather than as a data structure', () => {
    const items = listProposals(CHAIN);
    const titles = items.map((item) => item.title);

    expect(titles).toContain('Interconnect Queue causes Capacity Ceiling');
    expect(titles).toContain('ASML depends on EUV');
  });

  it('carries the model’s reasoning through to the row', () => {
    const [first] = listProposals(CHAIN);
    expect(first?.note).toBe('The wait to energise.');
  });

  it('surfaces the reason a retype was proposed', () => {
    const retype = listProposals(CHAIN).find((item) => item.kind === 'edge-change');
    expect(retype?.note).toBe('too vague');
  });

  it('keys items by label, not by position', () => {
    // Position-based keys would reshuffle React state the moment the list is
    // filtered, and check the wrong row.
    const items = listProposals(CHAIN);
    expect(items[0]?.key).toBe(nodeKey('Interconnect Queue'));
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it('records only dependencies this run actually creates', () => {
    const items = listProposals(CHAIN);
    const internal = items.find((item) => item.key === edgeKey('Interconnect Queue', 'Capacity Ceiling'));
    const external = items.find((item) => item.key === edgeKey('Capacity Ceiling', 'EUV'));

    expect(internal?.requires).toEqual([nodeKey('Interconnect Queue'), nodeKey('Capacity Ceiling')]);
    // EUV already exists, so it is not a dependency of this proposal.
    expect(external?.requires).toEqual([nodeKey('Capacity Ceiling')]);
  });

  it('shows the existing parents for a nested connection', () => {
    const items = listProposals({
      ...EMPTY,
      newEdges: [{
        source: 'Power demand',
        sourceParent: 'Semis',
        target: 'Financing constraint',
        targetParent: 'Capex',
        relation: 'affects',
      }],
    });

    expect(items[0]?.title).toContain('Semis › Power demand');
    expect(items[0]?.title).toContain('Capex › Financing constraint');
    expect(items[0]?.detail).toMatch(/existing nested endpoints/i);
  });

  it('hides stale promotion artifacts for children that already exist', () => {
    const items = listProposals(
      {
        ...EMPTY,
        newNodes: [{ label: 'Power demand', kind: 'concept' }],
        newEdges: [{ source: 'Power demand', target: 'EUV', relation: 'affects' }],
      },
      new Set(['power demand']),
    );

    expect(items.map((item) => item.kind)).toEqual(['edge']);
    expect(items[0]?.requires).toEqual([]);
  });
});

describe('selection', () => {
  it('starts with everything checked', () => {
    const items = listProposals(CHAIN);
    expect(allKeys(items).size).toBe(items.length);
  });

  it('unchecking a concept unchecks the relationships that need it', () => {
    const items = listProposals(CHAIN);
    const next = toggleSelection(items, allKeys(items), nodeKey('Capacity Ceiling'));

    expect(next.has(nodeKey('Capacity Ceiling'))).toBe(false);
    expect(next.has(edgeKey('Interconnect Queue', 'Capacity Ceiling'))).toBe(false);
    expect(next.has(edgeKey('Capacity Ceiling', 'EUV'))).toBe(false);
    // Changes that never depended on it are untouched.
    expect(next.has(nodeKey('Interconnect Queue'))).toBe(true);
  });

  it('checking a relationship checks the concepts it needs', () => {
    const items = listProposals(CHAIN);
    const next = toggleSelection(items, new Set(), edgeKey('Interconnect Queue', 'Capacity Ceiling'));

    expect(next.has(nodeKey('Interconnect Queue'))).toBe(true);
    expect(next.has(nodeKey('Capacity Ceiling'))).toBe(true);
  });

  it('counts what is selected, by kind', () => {
    const items = listProposals(CHAIN);
    expect(countByKind(items, allKeys(items))).toEqual({
      nodes: 2,
      edges: 2,
      changes: 1,
      groupings: 1,
    });
    expect(countByKind(items, new Set())).toEqual({
      nodes: 0,
      edges: 0,
      changes: 0,
      groupings: 0,
    });
  });

  it('ignores a toggle for a key that is not in the list', () => {
    const items = listProposals(CHAIN);
    expect(toggleSelection(items, allKeys(items), 'node:nonsense').size).toBe(items.length);
  });

  it('never mutates the set it was given', () => {
    const items = listProposals(CHAIN);
    const before = allKeys(items);
    const size = before.size;
    toggleSelection(items, before, nodeKey('Capacity Ceiling'));
    expect(before.size).toBe(size);
  });
});
