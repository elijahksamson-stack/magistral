/**
 * The shared graph store — the single piece of renderer state every pane reads.
 *
 * The native graph lives in the main process, so this holds no graph logic of
 * its own: it issues an IPC mutation, then re-reads the authoritative snapshot.
 * One writer, one truth. That is why `addCell` returns only after the snapshot
 * containing the new cell has landed.
 *
 * Consumed by app/renderer/editor, /graph and /chat.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ExtractionResult, KnowledgeGraph, MergeReport } from '../../../shared/types/graph';
import type { VaultSummary } from '../../../shared/types/ipc';
import { getApi, invoke, toMessage } from './api';
import { clearClaudeRuns } from './useClaude';

const DEFAULT_VAULT_NAME = 'Untitled';
const HISTORY_LIMIT = 30;

export interface ChangeRecord {
  id: string;
  label: string;
  at: string;
  /** Entities touched by this change, for cross-pane preview and selection. */
  entityIds: readonly string[];
}

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

function describeChange(before: KnowledgeGraph, after: KnowledgeGraph): string {
  const nodeDelta = after.nodes.length - before.nodes.length;
  const edgeDelta = after.edges.length - before.edges.length;
  const cellDelta = after.cells.length - before.cells.length;
  if (nodeDelta !== 0) return `${nodeDelta > 0 ? 'Added' : 'Removed'} ${Math.abs(nodeDelta)} concept${Math.abs(nodeDelta) === 1 ? '' : 's'}`;
  if (edgeDelta !== 0) return `${edgeDelta > 0 ? 'Added' : 'Removed'} ${Math.abs(edgeDelta)} relationship${Math.abs(edgeDelta) === 1 ? '' : 's'}`;
  if (cellDelta !== 0) return `${cellDelta > 0 ? 'Added' : 'Removed'} a cell`;
  if (before.name !== after.name) return `Renamed graph to ${after.name}`;
  return 'Edited a cell';
}

function changedEntityIds(before: KnowledgeGraph, after: KnowledgeGraph): string[] {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node] as const));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node] as const));
  const changed = new Set<string>();
  for (const [id, node] of afterNodes) {
    if (JSON.stringify(beforeNodes.get(id)) !== JSON.stringify(node)) changed.add(id);
  }
  for (const id of beforeNodes.keys()) if (!afterNodes.has(id)) changed.add(id);

  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge] as const));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge] as const));
  for (const [id, edge] of afterEdges) {
    if (JSON.stringify(beforeEdges.get(id)) === JSON.stringify(edge)) continue;
    changed.add(edge.source);
    changed.add(edge.target);
  }
  for (const [id, edge] of beforeEdges) {
    if (afterEdges.has(id)) continue;
    changed.add(edge.source);
    changed.add(edge.target);
  }
  return [...changed].slice(0, 8);
}

export interface GraphStore {
  graph: KnowledgeGraph | null;
  loading: boolean;
  error: string | null;

  addCell(afterCellId?: string): Promise<string>;
  upsertCell(cellId: string, markdown: string): Promise<void>;
  removeCell(cellId: string): Promise<void>;
  reorderCells(orderedIds: string[]): Promise<void>;
  refreshSnapshot(): Promise<void>;
  /**
   * Re-read the vault list.
   *
   * Needed by anything that creates a vault WITHOUT going through
   * `createVault` — an import does, because it has to write cells and edges
   * into the new vault before it is worth showing. Without this the picker
   * holds a stale list, fails to find the active id in it, and reports
   * "No graph" about a vault that is open on screen.
   */
  refreshVaults(): Promise<void>;

  selectedNodeId: string | null;
  setSelectedNodeId(id: string | null): void;
  /** Endpoint id for an authored child. Kept separate: a subnode is never a top-level node. */
  selectedSubnodeId: string | null;
  setSelectedSubnodeId(id: string | null): void;
  selectedCellId: string | null;
  setSelectedCellId(id: string | null): void;
  /**
   * The concept the Editor should reveal inside the selected cell.
   *
   * A sub-concept is a line within its parent's cell, so selecting the cell is
   * not enough to arrive anywhere useful — a long imported cell opens at the
   * top and the concept that was clicked sits somewhere below the fold.
   * Transient and renderer-only: never persisted, never crosses IPC.
   */
  selectedCellAnchor: string | null;
  setSelectedCellAnchor(label: string | null): void;
  hoveredNodeId: string | null;
  setHoveredNodeId(id: string | null): void;
  hoveredSubnodeId: string | null;
  setHoveredSubnodeId(id: string | null): void;
  hoveredCellId: string | null;
  setHoveredCellId(id: string | null): void;

  // -- shell extras, additive to the pane contract -------------------------
  vaults: VaultSummary[];
  activeVaultId: string | null;
  isDirty: boolean;
  saveState: SaveState;
  lastSavedAt: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undo(): Promise<void>;
  redo(): Promise<void>;
  recentChanges: readonly ChangeRecord[];
  createVault(name?: string): Promise<void>;
  openVault(id: string): Promise<void>;
  saveVault(): Promise<void>;
  /**
   * Rename a vault. Defaults to the open one; pass an id to rename another.
   */
  renameVault(name: string, vaultId?: string): Promise<void>;
  deleteVault(id: string): Promise<void>;
  /** True while the vault still carries the placeholder name. */
  isUnnamed: boolean;
  clearError(): void;
}

const GraphStoreContext = createContext<GraphStore | null>(null);

/**
 * Exported because the chat pane also creates cells — an accepted "Complete
 * the map" concept becomes one. Two generators would be two formats.
 */
export function newCellId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cell-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function GraphStoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedSubnodeId, setSelectedSubnodeId] = useState<string | null>(null);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [selectedCellAnchor, setSelectedCellAnchor] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredSubnodeId, setHoveredSubnodeId] = useState<string | null>(null);
  const [hoveredCellId, setHoveredCellId] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [recentChanges, setRecentChanges] = useState<readonly ChangeRecord[]>([]);
  const graphRef = useRef<KnowledgeGraph | null>(null);
  const undoRef = useRef<KnowledgeGraph[]>([]);
  const redoRef = useRef<KnowledgeGraph[]>([]);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const fail = useCallback((context: string, cause: unknown) => {
    if (isMounted.current) setError(`${context}: ${toMessage(cause)}`);
  }, []);

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await invoke('graph:snapshot', undefined);
      if (!isMounted.current) return;
      const before = graphRef.current;
      if (before && before.id === snapshot.id && JSON.stringify(before) !== JSON.stringify(snapshot)) {
        undoRef.current = [...undoRef.current.slice(-(HISTORY_LIMIT - 1)), before];
        redoRef.current = [];
        setHistoryVersion((version) => version + 1);
        setRecentChanges((changes) => [
          {
            id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
            label: describeChange(before, snapshot),
            at: new Date().toISOString(),
            entityIds: changedEntityIds(before, snapshot),
          },
          ...changes,
        ].slice(0, 8));
      }
      graphRef.current = snapshot;
      setGraph(snapshot);
    } catch (cause: unknown) {
      fail('Could not read the graph', cause);
    }
  }, [fail]);

  const refreshVaults = useCallback(async (): Promise<VaultSummary[]> => {
    const list = await invoke('vault:list', undefined);
    if (isMounted.current) setVaults(list);
    return list;
  }, []);

  const openVault = useCallback(
    async (id: string): Promise<void> => {
      setLoading(true);
      try {
        const opened = await invoke('vault:open', { id });
        if (!isMounted.current) return;
        // Runs belong to the graph they were asked about. Carrying them across
        // would attach an answer to concepts it never saw.
        clearClaudeRuns();
        graphRef.current = opened;
        undoRef.current = [];
        redoRef.current = [];
        setHistoryVersion((version) => version + 1);
        setRecentChanges([]);
        setSelectedNodeId(null);
        setSelectedSubnodeId(null);
        setSelectedCellId(null);
        setHoveredNodeId(null);
        setHoveredSubnodeId(null);
        setHoveredCellId(null);
        setGraph(opened);
        setActiveVaultId(id);
        setIsDirty(false);
        setError(null);
      } catch (cause: unknown) {
        fail('Could not open that vault', cause);
      } finally {
        if (isMounted.current) setLoading(false);
      }
    },
    [fail],
  );

  const createVault = useCallback(
    async (name = DEFAULT_VAULT_NAME): Promise<void> => {
      try {
        const created = await invoke('vault:create', { name });
        await refreshVaults();
        await openVault(created.id);
      } catch (cause: unknown) {
        fail('Could not create a vault', cause);
      }
    },
    [fail, openVault, refreshVaults],
  );

  /**
   * Persist the open graph.
   *
   * Reads the snapshot from the CORE rather than using the `graph` in state.
   * State is a cached view captured at render time, and a save chained onto
   * another action — `renameVault(...).then(saveVault)` — would otherwise
   * write the pre-action graph back over what just changed. That is exactly
   * how a freshly typed name got replaced by "Untitled" a moment later.
   */
  const saveVault = useCallback(async (): Promise<void> => {
    if (!activeVaultId) return;
    setIsSaving(true);
    try {
      const current = await invoke('graph:snapshot', undefined);
      const { savedAt } = await invoke('vault:save', { id: activeVaultId, graph: current });
      if (isMounted.current) {
        setIsDirty(false);
        setLastSavedAt(savedAt);
      }
      await refreshVaults();
    } catch (cause: unknown) {
      fail('Could not save the vault', cause);
    } finally {
      if (isMounted.current) setIsSaving(false);
    }
  }, [activeVaultId, fail, refreshVaults]);

  /**
   * Rename the open vault.
   *
   * The graph carries the name, so it is written through the graph rather than
   * only the vault index — otherwise the title bar and the exported file would
   * disagree about what this is called.
   */
  const renameVault = useCallback(
    async (name: string, vaultId?: string): Promise<void> => {
      const trimmed = name.trim();
      const targetId = vaultId ?? activeVaultId;
      if (!targetId || trimmed.length === 0) return;

      // The core only holds the OPEN graph. `vault:rename` rewrites the name
      // inside the vault file itself, so a closed vault needs nothing more.
      const isOpenVault = targetId === activeVaultId;

      try {
        // Order matters for the open one. The core owns its name: renaming
        // only the vault file leaves the core holding "Untitled", which
        // refreshSnapshot restores and the next save writes back over the
        // file — which is exactly why naming a graph appeared to do nothing.
        if (isOpenVault) await invoke('graph:set-name', { name: trimmed });
        await invoke('vault:rename', { id: targetId, name: trimmed });
        if (isOpenVault) await refreshSnapshot();
        await refreshVaults();
      } catch (cause: unknown) {
        fail('Could not rename the vault', cause);
      }
    },
    [activeVaultId, fail, refreshSnapshot, refreshVaults],
  );

  /**
   * Delete a graph, opening another if it was the one on screen.
   *
   * Refuses the last one: the app has no meaningful state with no graph open,
   * and silently landing on an empty shell is worse than declining.
   */
  const deleteVault = useCallback(
    async (id: string): Promise<void> => {
      if (vaults.length <= 1) {
        fail('The last graph cannot be deleted', new Error('at least one graph must remain'));
        return;
      }
      try {
        await invoke('vault:delete', { id });
        const remaining = await refreshVaults();

        if (id === activeVaultId) {
          const next = remaining[0];
          if (next) await openVault(next.id);
        }
      } catch (cause: unknown) {
        fail('Could not delete the graph', cause);
      }
    },
    [activeVaultId, fail, openVault, refreshVaults, vaults.length],
  );

  /** True while the vault still carries the placeholder name. */
  const isUnnamed = (graph?.name ?? DEFAULT_VAULT_NAME) === DEFAULT_VAULT_NAME;

  // -- bootstrap ------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const boot = async (): Promise<void> => {
      try {
        const list = await refreshVaults();
        if (cancelled) return;
        const first = list[0];
        if (first) {
          await openVault(first.id);
          return;
        }
        await createVault();
      } catch (cause: unknown) {
        fail('Magistral could not start', cause);
      } finally {
        if (!cancelled && isMounted.current) setLoading(false);
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
    // Intentionally empty deps: bootstrap runs exactly once. Listing the
    // callbacks would re-open (or re-create) a vault every time one is rebuilt.
  }, []);

  // -- main-process events --------------------------------------------------

  useEffect(() => {
    const api = window.braindump;
    if (!api) {
      setError('The Magistral bridge is unavailable — the preload script did not load.');
      setLoading(false);
      return;
    }

    const offDirty = api.on('vault:dirty', ({ dirty }) => setIsDirty(dirty));
    const offError = api.on('app:error', ({ message, detail }) =>
      setError(detail ? `${message} ${detail}` : message),
    );
    return () => {
      offDirty();
      offError();
    };
  }, []);

  // -- cell mutations -------------------------------------------------------

  const upsertCell = useCallback(
    async (cellId: string, markdown: string): Promise<void> => {
      try {
        await invoke('cell:upsert', { cellId, markdown });
        await refreshSnapshot();
      } catch (cause: unknown) {
        fail('Could not save that cell', cause);
      }
    },
    [fail, refreshSnapshot],
  );

  const reorderCells = useCallback(
    async (orderedIds: string[]): Promise<void> => {
      try {
        await invoke('cell:reorder', { orderedIds });
        await refreshSnapshot();
      } catch (cause: unknown) {
        fail('Could not reorder cells', cause);
      }
    },
    [fail, refreshSnapshot],
  );

  const addCell = useCallback(
    async (afterCellId?: string): Promise<string> => {
      const cellId = newCellId();
      await invoke('cell:upsert', { cellId, markdown: '' });

      if (afterCellId && graph) {
        const existing = graph.cells.map((cell) => cell.id).filter((id) => id !== cellId);
        const index = existing.indexOf(afterCellId);
        const ordered =
          index === -1
            ? [...existing, cellId]
            : [...existing.slice(0, index + 1), cellId, ...existing.slice(index + 1)];
        await invoke('cell:reorder', { orderedIds: ordered });
      }

      await refreshSnapshot();
      return cellId;
    },
    [graph, refreshSnapshot],
  );

  const removeCell = useCallback(
    async (cellId: string): Promise<void> => {
      try {
        await invoke('cell:remove', { cellId });
        if (isMounted.current && selectedCellId === cellId) setSelectedCellId(null);
        await refreshSnapshot();
      } catch (cause: unknown) {
        fail('Could not remove that cell', cause);
      }
    },
    [fail, refreshSnapshot, selectedCellId],
  );

  const restoreHistory = useCallback(
    async (direction: 'undo' | 'redo'): Promise<void> => {
      const current = graphRef.current;
      const source = direction === 'undo' ? undoRef : redoRef;
      const target = direction === 'undo' ? redoRef : undoRef;
      const next = source.current.at(-1);
      if (!current || !next) return;

      source.current = source.current.slice(0, -1);
      target.current = [...target.current.slice(-(HISTORY_LIMIT - 1)), current];
      try {
        await invoke('graph:replace', { graph: next });
        graphRef.current = next;
        setGraph(next);
        setIsDirty(true);
        setHistoryVersion((version) => version + 1);
        setRecentChanges((changes) => [
          {
            id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
            label: `${direction === 'undo' ? 'Undid' : 'Redid'} ${describeChange(next, current).toLowerCase()}`,
            at: new Date().toISOString(),
            entityIds: changedEntityIds(current, next),
          },
          ...changes,
        ].slice(0, 8));
      } catch (cause: unknown) {
        // Put the snapshot back so a failed IPC round-trip loses nothing.
        source.current = [...source.current, next];
        target.current = target.current.slice(0, -1);
        fail(`Could not ${direction}`, cause);
      }
    },
    [fail],
  );

  const undo = useCallback(() => restoreHistory('undo'), [restoreHistory]);
  const redo = useCallback(() => restoreHistory('redo'), [restoreHistory]);


  const clearError = useCallback(() => setError(null), []);

  /** Public wrapper: the pane contract does not need the summaries back. */
  const refreshVaultList = useCallback(async (): Promise<void> => {
    await refreshVaults();
  }, [refreshVaults]);

  const value = useMemo<GraphStore>(
    () => ({
      graph,
      loading,
      error,
      addCell,
      upsertCell,
      removeCell,
      reorderCells,
      refreshSnapshot,
      refreshVaults: refreshVaultList,
      selectedNodeId,
      setSelectedNodeId,
      selectedSubnodeId,
      setSelectedSubnodeId,
      selectedCellId,
      setSelectedCellId,
      selectedCellAnchor,
      setSelectedCellAnchor,
      hoveredNodeId,
      setHoveredNodeId,
      hoveredSubnodeId,
      setHoveredSubnodeId,
      hoveredCellId,
      setHoveredCellId,
      vaults,
      activeVaultId,
      isDirty,
      saveState: isSaving ? 'saving' : error ? 'error' : isDirty ? 'unsaved' : 'saved',
      lastSavedAt,
      canUndo: undoRef.current.length > 0,
      canRedo: redoRef.current.length > 0,
      undo,
      redo,
      recentChanges,
      createVault,
      openVault,
      saveVault,
      renameVault,
      deleteVault,
      isUnnamed,
      clearError,
    }),
    [
      graph,
      loading,
      error,
      addCell,
      upsertCell,
      removeCell,
      reorderCells,
      refreshSnapshot,
      refreshVaultList,
      selectedNodeId,
      selectedSubnodeId,
      selectedCellId,
      selectedCellAnchor,
      hoveredNodeId,
      hoveredSubnodeId,
      hoveredCellId,
      vaults,
      activeVaultId,
      isDirty,
      isSaving,
      lastSavedAt,
      historyVersion,
      undo,
      redo,
      recentChanges,
      createVault,
      openVault,
      saveVault,
      renameVault,
      deleteVault,
      isUnnamed,
      clearError,
    ],
  );

  return <GraphStoreContext.Provider value={value}>{children}</GraphStoreContext.Provider>;
}

export function useGraphStore(): GraphStore {
  const store = useContext(GraphStoreContext);
  if (!store) {
    throw new Error('useGraphStore must be used inside <GraphStoreProvider>.');
  }
  return store;
}

/** Re-exported so panes can assert the bridge exists before rendering. */
export { getApi };
