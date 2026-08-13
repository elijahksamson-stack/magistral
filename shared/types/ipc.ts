/**
 * IPC surface — CONTRACT.
 *
 * Implemented by: app/main/ipc.ts + app/preload/preload.ts   (agent 3)
 * Consumed by:    every renderer module                      (agents 4, 5, 6)
 *
 * The renderer never touches the filesystem, never spawns a process, and never
 * holds a native handle. It asks for things by channel name and receives
 * structured clones. `contextIsolation: true`, `nodeIntegration: false`.
 */

import type {
  ClaudeInvokeRequest,
  ClaudeStreamEvent,
  CliProviderSelection,
  CliProviderSnapshot,
  SourceDocument,
} from './claude';
import type {
  Cell,
  ExtractionResult,
  KnowledgeGraph,
  LayoutParams,
  LinkSyncReport,
  MergeReport,
  NodeKind,
  RelationKind,
  SearchHit,
} from './graph';
import type { LayoutFrame } from './addon';

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface VaultSummary {
  id: string;
  name: string;
  path: string;
  nodeCount: number;
  cellCount: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportResult {
  /** False when the user dismissed the save dialog. */
  saved: boolean;
  path?: string;
  bytes?: number;
}

// ---------------------------------------------------------------------------
// Request/response map — invoke channels
// ---------------------------------------------------------------------------

/**
 * Every entry is `channel: [requestType, responseType]`.
 * Adding a channel here without implementing it in app/main/ipc.ts is a
 * compile error, which is the point.
 */
export interface IpcInvokeMap {
  // -- vault
  'vault:list': [void, VaultSummary[]];
  'vault:create': [{ name: string }, VaultSummary];
  'vault:open': [{ id: string }, KnowledgeGraph];
  'vault:save': [{ id: string; graph: KnowledgeGraph }, { savedAt: string }];
  'vault:delete': [{ id: string }, { deleted: boolean }];
  'vault:rename': [{ id: string; name: string }, VaultSummary];

  // -- cells
  'cell:upsert': [{ cellId: string; markdown: string }, LinkSyncReport];
  'cell:remove': [{ cellId: string }, LinkSyncReport];
  'cell:reorder': [{ orderedIds: string[] }, { ok: true }];

  // -- graph mutation
  'graph:add-node': [{ label: string; kind: NodeKind }, { nodeId: string }];
  /** Put a node in a group, or pass an empty groupId to take it out. */
  'graph:set-node-label': [{ nodeId: string; label: string }, { ok: true }];
  'graph:set-node-group': [{ nodeId: string; groupId: string }, { ok: true }];
  'graph:remove-node': [{ nodeId: string }, { removed: boolean }];
  'graph:add-edge': [
    { sourceId: string; targetId: string; relation: RelationKind; weight?: number },
    { edgeId: string },
  ];
  'graph:remove-edge': [{ edgeId: string }, { removed: boolean }];
  'graph:set-edge-note': [{ edgeId: string; note: string }, { ok: true }];
  /** Describe a concept the author did not write a [[wikilink]] line for. */
  'graph:set-node-note': [{ nodeId: string; note: string }, { ok: true }];
  'graph:snapshot': [void, KnowledgeGraph];
  /** Replace the open graph from a renderer-owned undo/redo snapshot. */
  'graph:replace': [{ graph: KnowledgeGraph }, { ok: true }];
  /**
   * Rename the open graph in the core. Renaming only the vault file leaves the
   * core holding the old name, which the next snapshot restores and the next
   * save writes back over the file.
   */
  'graph:set-name': [{ name: string }, { ok: true }];

  // -- layout
  'layout:configure': [Partial<LayoutParams>, { ok: true }];
  'layout:tick': [{ iterations?: number }, LayoutFrame];
  'layout:settle': [{ maxIterations?: number }, LayoutFrame];
  'layout:pin': [{ nodeId: string; x: number; y: number }, { ok: true }];
  'layout:unpin': [{ nodeId: string }, { ok: true }];
  'layout:reset': [{ seed?: number }, { ok: true }];
  'layout:node-order': [void, { order: string[]; topologyVersion: number }];

  // -- analysis
  'graph:compute-metrics': [void, { ok: true }];
  'graph:components': [void, { components: string[][] }];
  'graph:shortest-path': [{ fromId: string; toId: string }, { path: string[] }];
  'graph:backlinks': [{ nodeId: string }, { nodeIds: string[] }];
  'graph:search': [{ query: string; limit?: number }, { hits: SearchHit[] }];

  // -- export / import
  /**
   * Write the renderer-produced YAML knowledge map.
   *
   * Replaced both JSON exports. The canonical one wrote the core's own bytes —
   * coordinates, damping, cluster ids — which round-tripped a vault but told a
   * reader nothing. The vault file on disk is still that artefact, so nothing
   * was lost; what left is a second copy of it wearing an export's clothes.
   */
  'export:yaml': [{ suggestedName?: string; text: string }, ExportResult];
  /**
   * Read an exported knowledge map back in.
   *
   * YAML is now the only export and the only import: it is the format a map
   * travels in, while the vault on disk stays the private save file rather than
   * the interchange one. Null when the author dismissed the dialog — that is
   * not an error. The renderer owns the map format, so this carries only the
   * text and the file's own name, which becomes the new vault's.
   */
  'import:yaml': [void, { file: { fileName: string; text: string } | null }];
  /**
   * Pick a .docx/.md/.txt and read it to plain text. Null when the author
   * dismissed the dialog — that is not an error.
   */
  'import:document': [void, { document: SourceDocument | null }];

  // -- claude bridge
  'claude:invoke': [ClaudeInvokeRequest, { accepted: true }];
  'claude:cancel': [{ requestId: string }, { cancelled: boolean }];
  /**
   * Request ids the bridge is actually running.
   *
   * The renderer's view of what is in flight can go stale — a reload, a crash,
   * a pane unmounting mid-run — and the bridge is the authority. Without a way
   * to ask, a turn can spin forever waiting on a process that ended.
   */
  'claude:active': [void, { requestIds: string[] }];
  'claude:health': [
    void,
    { available: boolean; version?: string; authenticated: boolean; reason?: string },
  ];
  /** Detect local subscription CLIs and report the routing choice. */
  'llm:providers': [void, CliProviderSnapshot];
  /** Choose one CLI, or restore Claude-first automatic fallback routing. */
  'llm:select': [{ provider: CliProviderSelection }, CliProviderSnapshot];
}

export type IpcInvokeChannel = keyof IpcInvokeMap;
export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeMap[C][0];
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeMap[C][1];

// ---------------------------------------------------------------------------
// Event channels — main pushes to renderer
// ---------------------------------------------------------------------------

export interface IpcEventMap {
  'claude:stream': ClaudeStreamEvent;
  'vault:dirty': { dirty: boolean };
  'app:error': { message: string; detail?: string };
  /** Native fullscreen hides the window controls, so renderer chrome reflows. */
  'window:fullscreen': { fullScreen: boolean };
}

export type IpcEventChannel = keyof IpcEventMap;

// ---------------------------------------------------------------------------
// The preload-exposed API
// ---------------------------------------------------------------------------

export interface BrainDumpApi {
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResponse<C>>;

  /** Returns an unsubscribe function. */
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventMap[C]) => void,
  ): () => void;

  platform: NodeJS.Platform;
  appVersion: string;
}

declare global {
  interface Window {
    braindump: BrainDumpApi;
  }
}
