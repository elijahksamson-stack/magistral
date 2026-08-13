/**
 * ChatPane, with the renderer's shared contract and `window.braindump` mocked.
 *
 * `app/renderer/shared/store.tsx` and `useClaude.ts` are authored by another
 * agent against the contract in the brief; they are mocked here so this pane is
 * verified independently of them.
 *
 * Rendered with react-dom/server — no DOM environment is installed — so the pane
 * is driven by advancing the mocked run snapshot and re-rendering, which is
 * exactly the sequence a real stream produces.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeUsage } from '../../../shared/types/claude';
import {
  DEFAULT_VIEW,
  SCHEMA_VERSION,
  type GraphNode,
  type KnowledgeGraph,
} from '../../../shared/types/graph';
import type { ChatTurn, ClaudeRunSnapshot } from './chatState';

const USAGE: ClaudeUsage = {
  inputTokens: 900,
  outputTokens: 250,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  notionalCostUsd: 0.05,
};

const mocks = vi.hoisted(() => ({
  store: {
    graph: null as KnowledgeGraph | null,
    loading: false,
    error: null as string | null,
    selectedCellId: null as string | null,
    selectedNodeId: null as string | null,
    setSelectedNodeId: vi.fn(),
    setSelectedCellId: vi.fn(),
    addCell: vi.fn(),
    upsertCell: vi.fn(),
    removeCell: vi.fn(),
    reorderCells: vi.fn(),
    refreshSnapshot: vi.fn(),
    mergeExtraction: vi.fn(),
  },
  claude: {
    runs: {} as Record<string, ClaudeRunSnapshot>,
    invoke: vi.fn(),
    cancel: vi.fn(),
  },
  turnStore: {
    turns: [] as readonly ChatTurn[],
    addTurn: vi.fn(),
  },
}));

vi.mock('../shared/store', () => ({ useGraphStore: () => mocks.store }));
vi.mock('../shared/useClaude', () => ({ useClaude: () => mocks.claude }));
vi.mock('./useChatTurns', () => ({ useChatTurns: () => mocks.turnStore }));

import ChatPane from './ChatPane';

const TURN: ChatTurn = {
  id: 'req-1',
  prompt: 'what binds?',
  askedAt: '2026-08-06T12:00:00.000Z',
};

function node(label: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `node-${label.toLowerCase().replace(/\s+/g, '-')}`,
    label,
    normalizedLabel: label.toLowerCase(),
    kind: 'concept',
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 2,
    centrality: 0.5,
    cluster: 0,
    ...overrides,
  };
}

function graphOf(nodes: GraphNode[]): KnowledgeGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'graph-1',
    name: 'AI capex',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    cells: [],
    nodes,
    edges: [],
    view: DEFAULT_VIEW,
  };
}

function run(overrides: Partial<ClaudeRunSnapshot>): ClaudeRunSnapshot {
  return {
    requestId: 'req-1',
    streaming: false,
    text: '',
    error: null,
    usage: null,
    packs: [],
    ...overrides,
  };
}

const render = () => renderToStaticMarkup(<ChatPane />);

/** Advance the stream one snapshot and re-render, as the bridge would. */
function streamTo(text: string, isFinal: boolean): string {
  mocks.claude.runs = {
    'req-1': run({ text, streaming: !isFinal, ...(isFinal ? { usage: USAGE } : {}) }),
  };
  return render();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.graph = null;
  mocks.store.loading = false;
  mocks.store.error = null;
  mocks.store.selectedCellId = null;
  mocks.claude.runs = {};
  mocks.turnStore.turns = [];
  (globalThis as { window?: unknown }).window = {
    braindump: {
      invoke: vi.fn(),
      on: vi.fn(() => vi.fn()),
      platform: 'darwin',
      appVersion: '0.1.0',
    },
  };
});

describe('empty state', () => {
  it('explains what the pane does, including the corpus and the subscription', () => {
    const html = render();

    expect(html).toContain('Think out loud against the graph');
    expect(html).toContain('references are attached automatically');
    expect(html).toContain('local CLI selected above');
    expect(html).not.toContain('Knowledge injected');
  });

  it('tells the user to open a vault when none is open', () => {
    const html = render();

    expect(html).toContain('No vault open');
    expect(html).toContain('Open a vault to start a conversation');
  });

  it('enables the composer once a graph is open', () => {
    mocks.store.graph = graphOf([node('HBM supply')]);
    const html = render();

    expect(html).toContain('AI capex');
    expect(html).toContain('0 cells · 0 mapped · 0 unlinked · 0 relationships');
    expect(html).not.toContain('Open a vault to start a conversation');
  });
});

describe('streamed transcript', () => {
  beforeEach(() => {
    mocks.store.graph = graphOf([node('HBM supply')]);
    mocks.turnStore.turns = [TURN];
  });

  it('renders deltas in order as the run advances', () => {
    const first = streamTo('The', false);
    const second = streamTo('The binding', false);
    const third = streamTo('The binding constraint moves.', true);

    expect(first).toContain('>The<');
    expect(second).toContain('The binding');
    expect(third).toContain('The binding constraint moves.');
    expect(first).toContain('data-status="streaming"');
    expect(second).toContain('data-status="streaming"');
    expect(third).toContain('data-status="complete"');
  });

  it('always shows the prompt alongside the answer', () => {
    const html = streamTo('answering', false);
    expect(html).toContain('what binds?');
  });

  it('keeps knowledge-routing details out of the transcript', () => {
    mocks.claude.runs = {
      'req-1': run({
        text: 'answer',
        usage: USAGE,
        packs: ['mindset/thinking-in-systems', 'sector/technology/semiconductors#2'],
      }),
    };

    const html = render();

    expect(html).not.toContain('Knowledge injected');
    expect(html).not.toContain('mindset/thinking-in-systems');
    expect(html).not.toContain('sector/technology/semiconductors#2');
  });

  it('makes graph node labels in the answer clickable', () => {
    const html = streamTo('HBM supply binds.', true);
    expect(html).toContain('data-node-label="HBM supply"');
  });

  it('reports tokens without presenting a price', () => {
    const html = streamTo('done', true);

    expect(html).toContain('900 in');
    expect(html).not.toContain('$');
    expect(html).not.toContain('0.05');
  });
});

describe('cancelling a turn', () => {
  beforeEach(() => {
    mocks.store.graph = graphOf([node('HBM supply')]);
    mocks.turnStore.turns = [TURN];
  });

  it('offers Stop while streaming and Send when settled', () => {
    const streaming = streamTo('partial', false);
    const settled = streamTo('partial', true);

    expect(streaming).toContain('>Stop</button>');
    expect(streaming).toContain('Streaming — Stop ends this turn');
    expect(settled).toContain('>Send</button>');
    expect(settled).not.toContain('>Stop</button>');
  });

  it('offers only Send for a transcript restored from a previous session', () => {
    // No runs: the process that answered these turns is gone, and one never
    // arrives. The composer must read Send, not Stop for a turn nobody asked.
    mocks.turnStore.turns = [{ ...TURN, finishedStatus: 'interrupted' }];
    mocks.claude.runs = {};

    const html = render();

    expect(html).toContain('>Send</button>');
    expect(html).not.toContain('>Stop</button>');
    expect(html).not.toContain('Streaming — Stop ends this turn');
  });

  it('shows a cancelled turn as stopped rather than as a short answer', () => {
    // The shape a cancel leaves: streaming ended, partial text, no usage.
    mocks.claude.runs = { 'req-1': run({ text: 'HBM sup' }) };

    const html = render();

    expect(html).toContain('data-status="interrupted"');
    expect(html).toContain('Stopped before finishing');
    expect(html).toContain('HBM sup');
    expect(html).toContain('>Send</button>');
  });
});

describe('errors', () => {
  it('surfaces a store error rather than rendering an empty pane', () => {
    mocks.store.error = 'Vault could not be opened';
    const html = render();

    expect(html).toContain('Vault could not be opened');
    expect(html).toContain('role="alert"');
  });

  it('surfaces a failed turn from the bridge', () => {
    mocks.store.graph = graphOf([node('HBM supply')]);
    mocks.turnStore.turns = [TURN];
    mocks.claude.runs = { 'req-1': run({ error: 'claude is not authenticated' }) };

    expect(render()).toContain('claude is not authenticated');
  });

  it('shows a loading state while the vault opens', () => {
    mocks.store.loading = true;
    expect(render()).toContain('Loading graph…');
  });
});
