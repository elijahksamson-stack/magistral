import { describe, expect, it } from 'vitest';

import { makeEdge, makeNode } from './fixtures';
import {
  buildConnectionEndpoints,
  connectionScopeInstruction,
  countTopLevelNodes,
  edgesForConnectionScope,
} from '../connectionTypes';

function scene() {
  return [
    makeNode('alpha', {
      label: 'Alpha',
      subConcepts: [{ label: 'Alpha facet' }, { label: 'Shared constraint' }],
    }),
    makeNode('beta', {
      label: 'Beta',
      subConcepts: [{ label: 'Beta facet' }, { label: 'Shared constraint' }],
    }),
    makeNode('alpha-facet', { label: 'Alpha facet' }),
    makeNode('beta-facet', { label: 'Beta facet' }),
    makeNode('group', { label: 'Regime', kind: 'group' }),
  ];
}

describe('connection endpoint hierarchy', () => {
  it('keeps promoted facets classified as subnodes and records their parents', () => {
    const endpoints = buildConnectionEndpoints(scene());
    const alphaFacet = endpoints.find((endpoint) => endpoint.id === 'alpha-facet');

    expect(alphaFacet).toMatchObject({ kind: 'subnode', parentIds: ['alpha'] });
  });

  it('does not count materialized nested endpoints as new top-level nodes', () => {
    expect(countTopLevelNodes(scene())).toBe(3);
  });

  it('offers unresolved subnodes from every parent to the manual linker', () => {
    const shared = buildConnectionEndpoints(scene()).find(
      (endpoint) => endpoint.label === 'Shared constraint',
    );

    expect(shared).toMatchObject({ kind: 'subnode', isVirtual: true });
    expect(shared?.parentIds).toEqual(['alpha', 'beta']);
  });
});

describe('connection-level views', () => {
  it('shows cross-parent subnode-to-subnode edges without requiring sibling parents', () => {
    const endpoints = buildConnectionEndpoints(scene());
    const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint] as const));
    const edges = [
      makeEdge('sub-sub', 'alpha-facet', 'beta-facet'),
      makeEdge('node-node', 'alpha', 'beta'),
      makeEdge('group-sub', 'group', 'alpha-facet'),
    ];

    expect(edgesForConnectionScope(edges, byId, 'subnode-subnode').map((edge) => edge.id))
      .toEqual(['sub-sub']);
    expect(edgesForConnectionScope(edges, byId, 'node-node').map((edge) => edge.id))
      .toEqual(['node-node']);
    expect(edgesForConnectionScope(edges, byId, 'group-subnode').map((edge) => edge.id))
      .toEqual(['group-sub']);
  });

  it('tells discovery to compare subnodes across different parents', () => {
    expect(connectionScopeInstruction('subnode-subnode')).toMatch(/different parents/i);
    expect(connectionScopeInstruction('subnode-subnode')).toMatch(/never limit.*siblings/i);
  });
});
