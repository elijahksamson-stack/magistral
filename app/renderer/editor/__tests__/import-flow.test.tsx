// @vitest-environment jsdom
/**
 * Reproduces the reported bug: only the first document import ever runs.
 *
 * Drives the real EditorPane against a fake bridge, so the flow under test is
 * the one that shipped — pick a file, create a cell, hand the cell the text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeGraph } from '../../../../shared/types/graph';
import type {
  ClaudeInvokeRequest,
  CliProviderSelection,
} from '../../../../shared/types/claude';

const AT = '2026-08-06T00:00:00.000Z';

function emptyGraph(): KnowledgeGraph {
  return {
    schemaVersion: 1,
    id: 'g1',
    name: 'Untitled',
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

/** Every claude:invoke the pane made, so we can count distillation runs. */
let invokedRuns: ClaudeInvokeRequest[];
let graph: KnowledgeGraph;
let importCount: number;

function installBridge(): void {
  graph = emptyGraph();
  invokedRuns = [];
  importCount = 0;

  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'import:document': {
        importCount += 1;
        return {
          document: {
            name: `doc-${importCount}.txt`,
            text: `Contents of document ${importCount}.`,
            isTruncated: false,
          },
        };
      }
      case 'cell:upsert': {
        const { cellId, markdown } = payload as { cellId: string; markdown: string };
        const existing = graph.cells.find((cell) => cell.id === cellId);
        graph = {
          ...graph,
          cells: existing
            ? graph.cells.map((cell) => (cell.id === cellId ? { ...cell, markdown } : cell))
            : [
                ...graph.cells,
                { id: cellId, order: graph.cells.length, markdown, createdAt: AT, updatedAt: AT },
              ],
        };
        return { createdNodeIds: [], orphanedNodeIds: [], linkedNodeIds: [] };
      }
      case 'cell:reorder':
        return { ok: true };
      case 'graph:snapshot':
        return graph;
      case 'claude:invoke':
        invokedRuns.push(payload as ClaudeInvokeRequest);
        return { accepted: true };
      case 'claude:cancel':
        return { cancelled: true };
      case 'vault:list':
        return [];
      default:
        return {};
    }
  });

  Object.defineProperty(window, 'braindump', {
    configurable: true,
    value: {
      invoke,
      on: () => () => {},
      platform: 'darwin' as NodeJS.Platform,
      appVersion: '0.1.0',
    },
  });
}

/** Renders the pane inside the store provider it depends on. */
async function renderPane(
  llmAvailable = true,
  providerSelection: CliProviderSelection | null = null,
) {
  const { GraphStoreProvider } = await import('../../shared/store');
  const EditorPane = (await import('../EditorPane')).default;
  return render(
    <GraphStoreProvider>
      <EditorPane llmAvailable={llmAvailable} providerSelection={providerSelection} />
    </GraphStoreProvider>,
  );
}

beforeEach(() => {
  installBridge();
});

describe('importing documents', () => {
  it('keeps the provider inside one naturally wrapping guidance sentence', async () => {
    await renderPane(true, 'claude');

    const sentence = await screen.findByText(/next to any cell/i);
    expect(sentence.tagName).toBe('SPAN');
    expect(sentence).toHaveTextContent(
      'Next to any cell — enhance, continue, critique, or distill. Answering with Claude through its subscription.',
    );
  });

  it('removes AI writing controls when no local CLI is usable', async () => {
    await renderPane(false);

    // queryAll, not query: there are two import buttons now — document and
    // folder — and queryByRole throws on more than one match rather than
    // reporting the absence this asserts.
    expect(screen.queryAllByRole('button', { name: /import/i })).toHaveLength(0);
    expect(screen.queryByText(/next to any cell/i)).toBeNull();
  });

  it('distils the first imported document', async () => {
    const user = userEvent.setup();
    await renderPane();

    await user.click(await screen.findByRole('button', { name: /import & distil a document/i }));

    await waitFor(() => {
      const runs = invokedRuns.filter(
        (run) => run.kind === 'cell' && run.action === 'distill-import',
      );
      expect(runs).toHaveLength(1);
    });
  });

  it('distils a SECOND imported document into its own cell', async () => {
    const user = userEvent.setup();
    await renderPane();

    const importButton = await screen.findByRole('button', { name: /import & distil a document/i });

    await user.click(importButton);
    await waitFor(() => expect(invokedRuns).toHaveLength(1));

    await user.click(importButton);

    await waitFor(() => {
      const runs = invokedRuns.filter(
        (run) => run.kind === 'cell' && run.action === 'distill-import',
      );
      expect(runs).toHaveLength(2);
    });

    // Each import must land in a cell of its own — one document per cell.
    const runs = invokedRuns.filter(
      (run): run is Extract<ClaudeInvokeRequest, { kind: 'cell' }> => run.kind === 'cell',
    );
    expect(new Set(runs.map((run) => run.cellId)).size).toBe(2);
    expect(runs[0]?.sourceDocument?.name).toBe('doc-1.txt');
    expect(runs[1]?.sourceDocument?.name).toBe('doc-2.txt');
  });
});
