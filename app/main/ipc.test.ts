/**
 * IPC surface tests.
 *
 * Channel completeness is already a compile-time guarantee — `IpcHandlers` is a
 * mapped type over IpcInvokeMap, so a missing channel fails tsc. This asserts
 * it at runtime as well, which is what catches the day someone reaches for a
 * cast to make a build go green.
 *
 * `electron` is mocked because these tests run in plain node: outside an
 * Electron process the real module resolves to a path string, not an API.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
}));

const { buildHandlers } = await import('./ipc');
const { GraphService } = await import('./graph-service');
const { FileVaultStorage } = await import('./vault');
const { ClaudeBridge } = await import('./claude/bridge');

/** Mirrors IpcInvokeMap. Kept literal on purpose: a hand-written list is the
 *  only thing that can disagree with the type, which is what makes it a test. */
const EXPECTED_CHANNELS = [
  'vault:list',
  'vault:create',
  'vault:open',
  'vault:save',
  'vault:delete',
  'vault:rename',
  'cell:upsert',
  'cell:remove',
  'cell:reorder',
  'graph:add-node',
  'graph:set-node-label',
  'graph:set-node-group',
  'graph:remove-node',
  'graph:add-edge',
  'graph:remove-edge',
  'graph:set-edge-note',
  'graph:set-node-note',
  'graph:snapshot',
  'graph:replace',
  'graph:set-name',
  'layout:configure',
  'layout:tick',
  'layout:settle',
  'layout:pin',
  'layout:unpin',
  'layout:reset',
  'layout:node-order',
  'graph:compute-metrics',
  'graph:components',
  'graph:shortest-path',
  'graph:backlinks',
  'graph:search',
  'export:yaml',
  'import:yaml',
  'import:document',
  'import:folder',
  'image:attach',
  'image:read',
  'claude:invoke',
  'claude:cancel',
  'claude:active',
  'claude:health',
  'llm:providers',
  'llm:select',
] as const;

function makeContext() {
  const graphs = new GraphService(['/nonexistent/braindump.node']);
  const bridge = new ClaudeBridge(
    {
      binaryPath: '/usr/local/bin/claude',
      model: 'sonnet',
      timeoutMs: 1_000,
      knowledgeDir: '/tmp/none',
      vaultDir: '/tmp/none',
    },
    () => undefined,
  );
  return {
    vaults: new FileVaultStorage('/tmp/braindump-test-vaults'),
    graphs,
    bridge,
    getWindow: () => null,
    markDirty: vi.fn(),
    onVaultOpened: vi.fn(),
  };
}

describe('buildHandlers', () => {
  it('implements every channel in IpcInvokeMap and nothing else', () => {
    const handlers = buildHandlers(makeContext());

    expect(Object.keys(handlers).sort()).toEqual([...EXPECTED_CHANNELS].sort());
  });

  it('exposes a callable function for each channel', () => {
    const handlers = buildHandlers(makeContext()) as Record<string, unknown>;

    for (const channel of EXPECTED_CHANNELS) {
      expect(typeof handlers[channel]).toBe('function');
    }
  });
});

describe('payload validation', () => {
  it('rejects a vault id that is not a string', async () => {
    const handlers = buildHandlers(makeContext());

    await expect(async () =>
      handlers['vault:open']({ id: 42 as unknown as string }),
    ).rejects.toThrow(/"id" must be a non-empty string/);
  });

  it('rejects an unknown node kind', () => {
    const handlers = buildHandlers(makeContext());

    expect(() => handlers['graph:add-node']({ label: 'X', kind: 'bogus' as never })).toThrow(
      /"kind" must be one of/,
    );
  });

  it('rejects an unknown relation kind', () => {
    const handlers = buildHandlers(makeContext());

    expect(() =>
      handlers['graph:add-edge']({
        sourceId: 'a',
        targetId: 'b',
        relation: 'vibes' as never,
      }),
    ).toThrow(/"relation" must be one of/);
  });

  it('rejects a non-finite layout parameter', () => {
    const handlers = buildHandlers(makeContext());

    expect(() => handlers['layout:configure']({ gravity: Number.NaN })).toThrow(
      /"gravity" must be a finite number/,
    );
  });

  it('accepts a layout seed of zero', () => {
    const handlers = buildHandlers(makeContext());

    // Degraded core, so it throws for that reason — not for the seed.
    expect(() => handlers['layout:reset']({ seed: 0 })).toThrow(/native core was not found/);
  });

  it('rejects a claude:invoke payload with an unknown action', async () => {
    const handlers = buildHandlers(makeContext());

    await expect(async () =>
      handlers['claude:invoke']({
        requestId: 'r1',
        kind: 'cell',
        action: 'jailbreak' as never,
        cellId: 'c1',
        cellMarkdown: 'text',
      }),
    ).rejects.toThrow(/not a known cell action/);
  });

  it('rejects a claude:invoke payload with no requestId', async () => {
    const handlers = buildHandlers(makeContext());

    await expect(async () =>
      handlers['claude:invoke']({ kind: 'chat', message: 'hi' } as never),
    ).rejects.toThrow(/"requestId" must be a non-empty string/);
  });

  it('rejects an unknown local LLM selection', () => {
    const handlers = buildHandlers(makeContext());

    expect(() => handlers['llm:select']({ provider: 'ollama' as never })).toThrow(
      /must be auto, claude, or codex/,
    );
  });
});
