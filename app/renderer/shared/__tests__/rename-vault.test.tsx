// @vitest-environment jsdom
/**
 * Renaming a vault from the picker.
 *
 * The trap: the core only holds the OPEN graph. Renaming the open one has to
 * tell the core too, or `refreshSnapshot` restores the old name and the next
 * save writes it straight back over the file — the bug that made naming a
 * graph appear to do nothing.
 *
 * Renaming a CLOSED one must NOT touch the core, or it would rename whichever
 * graph happens to be open instead of the one that was clicked.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VaultMenu from '../VaultMenu';
import { GraphStoreProvider, useGraphStore } from '../store';
import type { KnowledgeGraph } from '../../../../shared/types/graph';
import type { VaultSummary } from '../../../../shared/types/ipc';

const VAULTS: VaultSummary[] = [
  {
    id: 'v1',
    name: 'Power Markets',
    path: '/v1',
    nodeCount: 12,
    cellCount: 4,
    updatedAt: '2026-08-06T00:00:00.000Z',
  },
  {
    id: 'v2',
    name: 'Semis',
    path: '/v2',
    nodeCount: 30,
    cellCount: 9,
    updatedAt: '2026-08-06T00:00:00.000Z',
  },
];

function renderMenu() {
  const onRename = vi.fn();
  const onDelete = vi.fn();
  render(
    <VaultMenu
      vaults={VAULTS}
      activeVaultId="v1"
      isDirty={false}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onRename={onRename}
      onDelete={onDelete}
    />,
  );
  // The list only exists once the picker is open.
  act(() => {
    screen.getByRole('button', { expanded: false }).click();
  });
  return { onRename, onDelete };
}

describe('the rename control', () => {
  it('is offered for every graph, open or not', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: 'Rename Power Markets' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename Semis' })).toBeTruthy();
  });

  it('names the graph it will rename, so two "Untitled" rows are tellable apart', () => {
    const { onRename } = renderMenu();
    act(() => {
      screen.getByRole('button', { name: 'Rename Semis' }).click();
    });

    // The closed one, not the open one.
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'v2', name: 'Semis' }));
  });

  it('closes the picker so the dialog is not behind it', () => {
    renderMenu();
    act(() => {
      screen.getByRole('button', { name: 'Rename Semis' }).click();
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not delete anything', () => {
    const { onDelete } = renderMenu();
    act(() => {
      screen.getByRole('button', { name: 'Rename Semis' }).click();
    });
    expect(onDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The store half: renaming the open vault vs a closed one
// ---------------------------------------------------------------------------

const AT = '2026-08-06T00:00:00.000Z';

/** Stands in for the C++ core, which only ever holds the OPEN graph. */
let coreName: string;
/** Stands in for each vault file on disk. */
let savedNames: Record<string, string>;

function coreSnapshot(): KnowledgeGraph {
  return {
    schemaVersion: 1,
    id: 'v1',
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
  coreName = 'Power Markets';
  savedNames = { v1: 'Power Markets', v2: 'Semis' };

  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'vault:list':
        return Object.entries(savedNames).map(([id, name]) => ({
          id,
          name,
          path: `/tmp/${id}`,
          nodeCount: 0,
          cellCount: 0,
          updatedAt: AT,
        }));
      case 'vault:open':
      case 'graph:snapshot':
        return coreSnapshot();
      case 'graph:set-name':
        coreName = (payload as { name: string }).name;
        return { ok: true };
      case 'vault:rename': {
        const { id, name } = payload as { id: string; name: string };
        savedNames[id] = name;
        return { id, name, path: `/tmp/${id}`, nodeCount: 0, cellCount: 0, updatedAt: AT };
      }
      default:
        return {};
    }
  });

  Object.defineProperty(window, 'braindump', {
    configurable: true,
    value: { invoke, on: () => () => {}, platform: 'darwin', appVersion: '0.1.0' },
  });
});

function Probe({ onReady }: { onReady: (store: ReturnType<typeof useGraphStore>) => void }) {
  const store = useGraphStore();
  onReady(store);
  return <span data-testid="name">{store.graph?.name ?? '—'}</span>;
}

async function mountStore(): Promise<ReturnType<typeof useGraphStore>> {
  let store: ReturnType<typeof useGraphStore> | null = null;
  render(
    <GraphStoreProvider>
      <Probe onReady={(value) => (store = value)} />
    </GraphStoreProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('name')).toHaveTextContent('Power Markets'));
  return store!;
}

describe('renaming through the store', () => {
  it('renames the OPEN vault in the core as well as on disk', async () => {
    const store = await mountStore();

    await act(async () => {
      await store.renameVault('Grid Constraints', 'v1');
    });

    // Both, or refreshSnapshot restores the old name and the next save writes
    // it back over the file.
    expect(coreName).toBe('Grid Constraints');
    expect(savedNames.v1).toBe('Grid Constraints');
  });

  it('renames a CLOSED vault without touching the open graph', async () => {
    const store = await mountStore();

    await act(async () => {
      await store.renameVault('Semiconductors', 'v2');
    });

    expect(savedNames.v2).toBe('Semiconductors');
    // The bug this guards: setting the core name here would rename whichever
    // graph is open — "Power Markets" — instead of the one that was clicked.
    expect(coreName).toBe('Power Markets');
    expect(savedNames.v1).toBe('Power Markets');
  });

  it('defaults to the open vault when no id is given', async () => {
    const store = await mountStore();

    await act(async () => {
      await store.renameVault('Renamed');
    });

    expect(coreName).toBe('Renamed');
    expect(savedNames.v1).toBe('Renamed');
  });

  it('ignores a blank name rather than writing an unnamed vault', async () => {
    const store = await mountStore();

    await act(async () => {
      await store.renameVault('   ', 'v2');
    });

    expect(savedNames.v2).toBe('Semis');
  });
});
