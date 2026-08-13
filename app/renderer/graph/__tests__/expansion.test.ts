import { describe, expect, it } from 'vitest';

import {
  MAX_EXPANDED,
  exposedSubNodeIds,
  resolveExpansion,
  toggleExpanded,
  virtualSubNodeId,
} from '../expansion';
import { makeNode } from './fixtures';

/** Two concepts naming a mix of real and unresolved sub-concepts. */
function scene() {
  return [
    makeNode('capex', {
      label: 'AI capex',
      subConcepts: [{ label: 'Financing structures' }, { label: 'Power demand' }],
    }),
    makeNode('rates', {
      label: 'Rates',
      subConcepts: [{ label: 'Power demand' }, { label: 'Never linked' }],
    }),
    makeNode('financing', { label: 'Financing structures' }),
    makeNode('power', { label: 'Power demand' }),
    makeNode('idle', { label: 'Something else' }),
  ];
}

describe('toggleExpanded', () => {
  it('expands a concept that was closed', () => {
    expect(toggleExpanded([], 'capex')).toEqual(['capex']);
  });

  it('closes one that was already open', () => {
    expect(toggleExpanded(['capex', 'rates'], 'capex')).toEqual(['rates']);
  });

  it('keeps the primary and replaces the comparison on a third click', () => {
    expect(toggleExpanded(['a', 'b'], 'c')).toEqual(['a', 'c']);
    expect(toggleExpanded(['a', 'b'], 'c')).toHaveLength(MAX_EXPANDED);
  });

  it('does not mutate the array it was handed', () => {
    const before = ['a', 'b'];
    toggleExpanded(before, 'c');
    expect(before).toEqual(['a', 'b']);
  });
});

describe('resolveExpansion', () => {
  it('exposes a concept and the sub-concepts it names', () => {
    const { exposedIds } = resolveExpansion(scene(), ['capex']);

    expect([...exposedIds].sort()).toEqual(['capex', 'financing', 'power']);
  });

  it('leaves everything else out, so the rest can grey', () => {
    const { exposedIds } = resolveExpansion(scene(), ['capex']);

    expect(exposedIds.has('idle')).toBe(false);
    expect(exposedIds.has('rates')).toBe(false);
  });

  it('creates a view-only node for a sub-concept with no real node', () => {
    const { exposedIds, virtualNodes, virtualNodeById } = resolveExpansion(scene(), ['rates']);
    const virtualId = virtualSubNodeId('never linked');

    expect(exposedIds.has(virtualId)).toBe(true);
    expect(virtualNodes.map((node) => node.label)).toEqual(['Never linked']);
    expect(virtualNodeById.get(virtualId)?.parentIds).toEqual(['rates']);
  });

  it('shares a sub-concept named by both expanded concepts', () => {
    const { exposedIds } = resolveExpansion(scene(), ['capex', 'rates']);

    expect(exposedIds.has('power')).toBe(true);
    expect([...exposedIds].sort()).toEqual([
      'capex',
      'financing',
      'power',
      'rates',
      virtualSubNodeId('never linked'),
    ]);
  });

  it('draws one shared view-only node when two parents name the same facet', () => {
    const nodes = [
      makeNode('a', { label: 'Alpha', x: 0, subConcepts: [{ label: 'Shared' }] }),
      makeNode('b', { label: 'Beta', x: 100, subConcepts: [{ label: 'shared' }] }),
    ];

    const expansion = resolveExpansion(nodes, ['a', 'b']);

    expect(expansion.virtualNodes).toHaveLength(1);
    expect(expansion.virtualNodes[0]?.x).toBe(50);
    expect(expansion.links).toEqual([
      { sourceId: 'a', targetId: virtualSubNodeId('shared') },
      { sourceId: 'b', targetId: virtualSubNodeId('shared') },
    ]);
  });

  it('places a view-only facet around its live parent position', () => {
    const nodes = [
      makeNode('a', { label: 'Alpha', subConcepts: [{ label: 'Facet' }] }),
    ];

    const expansion = resolveExpansion(nodes, ['a'], {
      positionOf: () => ({ x: 200, y: 300 }),
    });

    expect(expansion.virtualNodes[0]).toMatchObject({ x: 200, y: 236 });
  });

  it('resolves labels regardless of casing or spacing', () => {
    const nodes = [
      makeNode('a', { label: 'Alpha', subConcepts: [{ label: '  BETA  ' }] }),
      makeNode('b', { label: 'beta' }),
    ];

    expect(resolveExpansion(nodes, ['a']).exposedIds.has('b')).toBe(true);
  });

  it('drops an id whose node has since been deleted', () => {
    expect(resolveExpansion(scene(), ['gone']).expandedIds).toEqual([]);
  });

  it('is empty when nothing is expanded', () => {
    expect(resolveExpansion(scene(), []).exposedIds.size).toBe(0);
  });
});

describe('exposedSubNodeIds', () => {
  it('keeps the order the author wrote them in', () => {
    expect(exposedSubNodeIds(scene(), 'capex')).toEqual(['financing', 'power']);
  });

  it('never reports a concept as its own sub-concept', () => {
    const nodes = [makeNode('a', { label: 'Alpha', subConcepts: [{ label: 'Alpha' }] })];
    expect(exposedSubNodeIds(nodes, 'a')).toEqual([]);
  });

  it('de-duplicates a label named twice', () => {
    const nodes = [
      makeNode('a', { label: 'Alpha', subConcepts: [{ label: 'Beta' }, { label: 'beta' }] }),
      makeNode('b', { label: 'Beta' }),
    ];
    expect(exposedSubNodeIds(nodes, 'a')).toEqual(['b']);
  });

  it('returns nothing for a concept with no sub-concepts', () => {
    expect(exposedSubNodeIds(scene(), 'idle')).toEqual([]);
  });
});
