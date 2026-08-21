/**
 * Every IPC channel, registered once, with types bound to IpcInvokeMap.
 *
 * `IpcHandlers` is a mapped type over the whole map, so an unimplemented
 * channel is a compile error rather than a runtime "no handler registered"
 * rejection the renderer discovers in production. That is the design.
 *
 * No handler may throw silently: `register` wraps each one, logs, and rethrows
 * a message the renderer can actually show a person.
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type {
  IpcEventChannel,
  IpcEventMap,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/types/ipc';
import type { CliProviderSelection } from '../../shared/types/claude';
import type { ClaudeBridge } from './claude/bridge';
import { checkClaudeHealth } from './claude/health';
import { parseInvokeRequest } from './claude/request';
import { pickAndAttachImage, readImage } from './assets';
import { pickAndReadDocument, pickAndReadFolder } from './documents';
import { exportGraphYaml, importMapYaml } from './export';
import type { GraphService } from './graph-service';
import {
  optionalNonNegativeInt,
  optionalPositiveInt,
  optionalPositiveNumber,
  optionalString,
  requireFiniteNumber,
  requireNodeKind,
  requireRelationKind,
  requireString,
  requireStringArray,
  requireText,
  sanitizeLayoutParams,
} from './guards';
import { createLogger, errorMessage } from './logger';
import type { VaultStorage } from './vault';

const log = createLogger('ipc');

function requireProviderSelection(payload: unknown): CliProviderSelection {
  const provider =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).provider
      : undefined;
  if (provider === 'auto' || provider === 'claude' || provider === 'codex') return provider;
  throw new Error('llm:select: "provider" must be auto, claude, or codex');
}

export type IpcHandlers = {
  [C in IpcInvokeChannel]: (payload: IpcRequest<C>) => Promise<IpcResponse<C>> | IpcResponse<C>;
};

export interface IpcContext {
  readonly vaults: VaultStorage;
  readonly graphs: GraphService;
  readonly bridge: ClaudeBridge;
  /** The focused window, for dialogs and pushed events. */
  readonly getWindow: () => BrowserWindow | null;
  /** Called after a mutation so the shell can mark the vault dirty. */
  readonly markDirty: () => void;
  /** Called after the open vault changes identity, so the bridge can re-scope. */
  readonly onVaultOpened: (vaultId: string) => void;
}

/** Push an event to the renderer. Safe to call when no window exists. */
export function sendEvent<C extends IpcEventChannel>(
  window: BrowserWindow | null,
  channel: C,
  payload: IpcEventMap[C],
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

export function buildHandlers(ctx: IpcContext): IpcHandlers {
  const { vaults, graphs, bridge } = ctx;

  const graphName = (): string => {
    try {
      return graphs.snapshot().name;
    } catch {
      return 'magistral';
    }
  };

  return {
    // -- vault ------------------------------------------------------------
    'vault:list': () => vaults.list(),

    'vault:create': (payload) => vaults.create(requireString(payload, 'name', 'vault:create')),

    'vault:open': async (payload) => {
      const id = requireString(payload, 'id', 'vault:open');
      const graph = await vaults.open(id);
      const repair = graphs.openFromJSON(graph);
      const snapshot = graphs.snapshot();
      if (repair.changed) {
        await vaults.save(id, snapshot);
        log.info('persisted repaired node cell coverage', {
          id,
          addedCells: repair.addedCellCount,
          repairedNodes: repair.repairedNodeIds.length,
        });
      }
      ctx.onVaultOpened(id);
      return snapshot;
    },

    'vault:save': async (payload) => {
      const id = requireString(payload, 'id', 'vault:save');
      const graph = (payload as { graph: unknown }).graph;
      if (typeof graph !== 'object' || graph === null) {
        throw new Error('vault:save: "graph" must be a KnowledgeGraph object');
      }
      return vaults.save(id, payload.graph);
    },

    'vault:delete': async (payload) => ({
      deleted: await vaults.delete(requireString(payload, 'id', 'vault:delete')),
    }),

    'vault:rename': (payload) =>
      vaults.rename(
        requireString(payload, 'id', 'vault:rename'),
        requireString(payload, 'name', 'vault:rename'),
      ),

    // -- cells ------------------------------------------------------------
    'cell:upsert': (payload) => {
      const report = graphs.upsertCell(
        requireString(payload, 'cellId', 'cell:upsert'),
        requireText(payload, 'markdown', 'cell:upsert'),
      );
      ctx.markDirty();
      return report;
    },

    'cell:remove': (payload) => {
      const report = graphs.removeCell(requireString(payload, 'cellId', 'cell:remove'));
      ctx.markDirty();
      return report;
    },

    'cell:reorder': (payload) => {
      graphs.reorderCells(requireStringArray(payload, 'orderedIds', 'cell:reorder'));
      ctx.markDirty();
      return { ok: true };
    },

    // -- graph mutation ---------------------------------------------------
    'graph:add-node': (payload) => {
      const nodeId = graphs.addNode(
        requireString(payload, 'label', 'graph:add-node'),
        requireNodeKind(payload, 'kind', 'graph:add-node'),
      );
      ctx.markDirty();
      return { nodeId };
    },

    'graph:set-edge-note': (payload) => {
      graphs.setEdgeNote(
        requireString(payload, 'edgeId', 'graph:set-edge-note'),
        optionalString(payload, 'note', 'graph:set-edge-note') ?? '',
      );
      ctx.markDirty();
      return { ok: true } as const;
    },

    'graph:set-node-note': (payload) => {
      graphs.setNodeNote(
        requireString(payload, 'nodeId', 'graph:set-node-note'),
        // Empty is meaningful: it clears the description.
        optionalString(payload, 'note', 'graph:set-node-note') ?? '',
      );
      ctx.markDirty();
      return { ok: true } as const;
    },

    'graph:set-node-label': (payload) => {
      graphs.setNodeLabel(
        requireString(payload, 'nodeId', 'graph:set-node-label'),
        requireString(payload, 'label', 'graph:set-node-label'),
      );
      ctx.markDirty();
      return { ok: true } as const;
    },

    'graph:set-node-group': (payload) => {
      graphs.setNodeGroup(
        requireString(payload, 'nodeId', 'graph:set-node-group'),
        // Empty is meaningful: it removes the node from its group.
        optionalString(payload, 'groupId', 'graph:set-node-group') ?? '',
      );
      ctx.markDirty();
      return { ok: true } as const;
    },

    'graph:remove-node': (payload) => {
      const removed = graphs.removeNode(requireString(payload, 'nodeId', 'graph:remove-node'));
      ctx.markDirty();
      return { removed };
    },

    'graph:add-edge': (payload) => {
      const edgeId = graphs.addEdge(
        requireString(payload, 'sourceId', 'graph:add-edge'),
        requireString(payload, 'targetId', 'graph:add-edge'),
        requireRelationKind(payload, 'relation', 'graph:add-edge'),
        optionalPositiveNumber(payload, 'weight', 'graph:add-edge'),
      );
      ctx.markDirty();
      return { edgeId };
    },

    'graph:remove-edge': (payload) => {
      const removed = graphs.removeEdge(requireString(payload, 'edgeId', 'graph:remove-edge'));
      ctx.markDirty();
      return { removed };
    },

    'graph:snapshot': () => graphs.snapshot(),

    'graph:replace': (payload) => {
      const graph = (payload as { graph?: unknown }).graph;
      if (typeof graph !== 'object' || graph === null) {
        throw new Error('graph:replace: "graph" must be a KnowledgeGraph object');
      }
      graphs.openFromJSON(payload.graph);
      ctx.markDirty();
      return { ok: true };
    },

    'graph:set-name': (payload) => {
      graphs.setName(requireString(payload, 'name', 'graph:set-name'));
      ctx.markDirty();
      return { ok: true } as const;
    },

    // -- layout -----------------------------------------------------------
    'layout:configure': (payload) => {
      graphs.layoutConfigure(sanitizeLayoutParams(payload, 'layout:configure'));
      return { ok: true };
    },

    'layout:tick': (payload) =>
      graphs.layoutTick(optionalPositiveInt(payload, 'iterations', 'layout:tick')),

    'layout:settle': (payload) =>
      graphs.layoutSettle(optionalPositiveInt(payload, 'maxIterations', 'layout:settle')),

    'layout:pin': (payload) => {
      graphs.pinNode(
        requireString(payload, 'nodeId', 'layout:pin'),
        requireFiniteNumber(payload, 'x', 'layout:pin'),
        requireFiniteNumber(payload, 'y', 'layout:pin'),
      );
      ctx.markDirty();
      return { ok: true };
    },

    'layout:unpin': (payload) => {
      graphs.unpinNode(requireString(payload, 'nodeId', 'layout:unpin'));
      ctx.markDirty();
      return { ok: true };
    },

    'layout:reset': (payload) => {
      graphs.layoutReset(optionalNonNegativeInt(payload ?? {}, 'seed', 'layout:reset'));
      ctx.markDirty();
      return { ok: true };
    },

    'layout:node-order': () => graphs.nodeOrder(),

    // -- analysis ---------------------------------------------------------
    'graph:compute-metrics': () => {
      graphs.computeMetrics();
      return { ok: true };
    },

    'graph:components': () => ({ components: graphs.components() }),

    'graph:shortest-path': (payload) => ({
      path: graphs.shortestPath(
        requireString(payload, 'fromId', 'graph:shortest-path'),
        requireString(payload, 'toId', 'graph:shortest-path'),
      ),
    }),

    'graph:backlinks': (payload) => ({
      nodeIds: graphs.backlinks(requireString(payload, 'nodeId', 'graph:backlinks')),
    }),

    'graph:search': (payload) => ({
      hits: graphs.search(
        requireString(payload, 'query', 'graph:search'),
        optionalPositiveInt(payload, 'limit', 'graph:search'),
      ),
    }),

    // -- export / import --------------------------------------------------
    'export:yaml': (payload) =>
      exportGraphYaml(
        ctx.getWindow(),
        requireString(payload, 'text', 'export:yaml'),
        optionalString(payload, 'suggestedName', 'export:yaml'),
      ),

    'import:yaml': async () => ({ file: await importMapYaml(ctx.getWindow()) }),

    'import:document': async () => ({
      document: await pickAndReadDocument(ctx.getWindow()),
    }),

    'import:folder': async () => ({
      document: await pickAndReadFolder(ctx.getWindow()),
    }),

    'image:attach': async (payload) => ({
      image: await pickAndAttachImage(
        ctx.getWindow(),
        vaults.directoryFor(requireString(payload, 'vaultId', 'image:attach')),
      ),
    }),

    'image:read': async (payload) => ({
      dataUrl: await readImage(
        vaults.directoryFor(requireString(payload, 'vaultId', 'image:read')),
        requireString(payload, 'fileName', 'image:read'),
      ),
    }),

    // -- claude bridge ----------------------------------------------------
    'claude:invoke': async (payload) => {
      await bridge.invoke(parseInvokeRequest(payload));
      return { accepted: true };
    },

    'claude:active': () => ({ requestIds: bridge.activeRequestIds() }),

    'claude:cancel': async (payload) => ({
      cancelled: await bridge.cancel(requireString(payload, 'requestId', 'claude:cancel')),
    }),

    'claude:health': () => checkClaudeHealth(),

    'llm:providers': () => bridge.providerSnapshot(),

    'llm:select': (payload) => bridge.selectProvider(requireProviderSelection(payload)),
  };
}

/**
 * Bind every handler to ipcMain. Each call is wrapped so an exception is logged
 * with its channel before it travels back to the renderer as a plain message.
 */
export function registerIpcHandlers(ctx: IpcContext): void {
  const handlers = buildHandlers(ctx);

  for (const channel of Object.keys(handlers) as IpcInvokeChannel[]) {
    const handler = handlers[channel] as (payload: unknown) => unknown;

    ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, payload: unknown) => {
      try {
        return await handler(payload);
      } catch (error: unknown) {
        const message = errorMessage(error);
        log.error(`${channel} failed`, error);
        throw new Error(message);
      }
    });
  }
  log.info(`registered ${Object.keys(handlers).length} IPC channels`);
}

export function removeIpcHandlers(channels: readonly IpcInvokeChannel[]): void {
  for (const channel of channels) ipcMain.removeHandler(channel);
}
