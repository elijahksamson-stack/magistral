// @vitest-environment jsdom
/**
 * Naming a graph must still be named after the save that follows.
 *
 * Reproduces the reported sequence: the name appeared in the editor header and
 * the status bar (both read the core) but the vault picker kept showing
 * "Untitled" (it reads the saved summaries). renameVault worked; the save
 * chained onto it wrote a graph captured at render time — still "Untitled" —
 * straight back over the rename.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeGraph } from '../../../../shared/types/graph';
import { GraphStoreProvider, useGraphStore } from '../store';

const AT = '2026-08-06T00:00:00.000Z';
const VAULT_ID = 'v1';

/** Stands in for the C++ core: authoritative, and renamed by graph:set-name. */
let coreName: string;
/** Stands in for what was written to disk. */
let savedName: string | null;

function coreSnapshot(): KnowledgeGraph {
  return {
    schemaVersion: 1,
    id: VAULT_ID,
    name: coreName,
    createdAt: AT,
    updatedAt: AT,
    cells: [],
    nodes: [],
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
  } as KnowledgeGraph;
}

beforeEach(() => {
  coreName = 'Untitled';
  savedName = null;

  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'vault:list':
        return [
          {
            id: VAULT_ID,
            name: savedName ?? 'Untitled',
            path: '/tmp/v1',
            nodeCount: 0,
            cellCount: 0,
            updatedAt: AT,
          },
        ];
      case 'vault:open':
        return coreSnapshot();
      case 'graph:snapshot':
        return coreSnapshot();
      case 'graph:set-name':
        coreName = (payload as { name: string }).name;
        return { ok: true };
      case 'vault:rename':
        savedName = (payload as { name: string }).name;
        return { id: VAULT_ID, name: savedName, path: '/tmp/v1', nodeCount: 0, cellCount: 0, updatedAt: AT };
      case 'vault:save':
        // Disk takes whatever the save was handed. If that is a stale graph,
        // the rename is lost — which is the bug.
        savedName = ((payload as { graph: KnowledgeGraph }).graph).name;
        return { savedAt: AT };
      default:
        return {};
    }
  });

  Object.defineProperty(window, 'braindump', {
    configurable: true,
    value: { invoke, on: () => () => {}, platform: 'darwin', appVersion: '0.1.0' },
  });
});

/** Exposes the store so the test can drive it the way App.tsx does. */
function Probe({ onReady }: { onReady: (store: ReturnType<typeof useGraphStore>) => void }) {
  const store = useGraphStore();
  onReady(store);
  return <span data-testid="name">{store.graph?.name ?? '—'}</span>;
}

describe('naming then saving', () => {
  it('keeps the new name on disk after the save that follows the rename', async () => {
    let store: ReturnType<typeof useGraphStore> | null = null;

    render(
      <GraphStoreProvider>
        <Probe onReady={(value) => (store = value)} />
      </GraphStoreProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Untitled'));

    // Exactly what App.tsx does when the name prompt is confirmed.
    await act(async () => {
      await store!.renameVault('Power Markets');
      await store!.saveVault();
    });

    expect(coreName).toBe('Power Markets');
    // The assertion that failed before: the save must not resurrect "Untitled".
    expect(savedName).toBe('Power Markets');
  });

  it('sets the name in the core before touching the vault', async () => {
    let store: ReturnType<typeof useGraphStore> | null = null;

    render(
      <GraphStoreProvider>
        <Probe onReady={(value) => (store = value)} />
      </GraphStoreProvider>,
    );
    /*
     * Wait for the LOADED name, not merely for the element.
     *
     * The probe renders a placeholder before the vault opens, so waiting on
     * presence alone let the rename run while activeVaultId was still null —
     * where renameVault returns early and the core is never told. That made
     * this test fail about one run in five, depending on how vitest happened to
     * schedule the file.
     */
    await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Untitled'));

    await act(async () => {
      await store!.renameVault('Power Markets');
    });

    expect(coreName).toBe('Power Markets');
    expect(savedName).toBe('Power Markets');
  });
});
