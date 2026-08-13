/**
 * Typed access to the preload bridge.
 *
 * The renderer never touches the filesystem, spawns a process, or holds a
 * native handle — it asks by channel name. A missing bridge is a hard error
 * here rather than an undefined-is-not-a-function three frames later.
 */

import type { LayoutFrame } from '../../../shared/types/addon';
import type { KnowledgeGraph, LayoutParams, NodeKind, RelationKind } from '../../../shared/types/graph';
import type {
  BrainDumpApi,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../../shared/types/ipc';

export function getBridge(): BrainDumpApi {
  const bridge = typeof window === 'undefined' ? undefined : window.braindump;
  if (!bridge) {
    throw new Error('Magistral bridge unavailable — the preload script did not load.');
  }
  return bridge;
}

export function invoke<C extends IpcInvokeChannel>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  return getBridge().invoke(channel, payload);
}

// -- layout -----------------------------------------------------------------

export function fetchNodeOrder(): Promise<{ order: string[]; topologyVersion: number }> {
  return invoke('layout:node-order', undefined);
}

export function tickLayout(iterations: number): Promise<LayoutFrame> {
  return invoke('layout:tick', { iterations });
}

export async function pinNode(nodeId: string, x: number, y: number): Promise<void> {
  await invoke('layout:pin', { nodeId, x, y });
}

export async function unpinNode(nodeId: string): Promise<void> {
  await invoke('layout:unpin', { nodeId });
}

export async function configureLayout(params: Partial<LayoutParams>): Promise<void> {
  await invoke('layout:configure', params);
}

export async function resetLayout(): Promise<void> {
  await invoke('layout:reset', {});
}

// -- graph ------------------------------------------------------------------

export function fetchSnapshot(): Promise<KnowledgeGraph> {
  return invoke('graph:snapshot', undefined);
}

/** Create a node directly — used for groups, which no cell asserts. */
export async function addNode(label: string, kind: NodeKind): Promise<string> {
  const { nodeId } = await invoke('graph:add-node', { label, kind });
  return nodeId;
}

/** Describe what a relationship actually is. Pass '' to clear it. */
export async function setEdgeNote(edgeId: string, note: string): Promise<void> {
  await invoke('graph:set-edge-note', { edgeId, note });
}

/**
 * Describe a concept directly. Pass '' to clear it.
 *
 * Currently uncalled: an accepted "Complete the map" concept carries its
 * description in the CELL it becomes, and the core takes a node's note from
 * the line its [[wikilink]] sits on. Kept as the counterpart to setEdgeNote —
 * it is the only way to describe a node no cell wrote, which is what a group
 * is.
 */
export async function setNodeNote(nodeId: string, note: string): Promise<void> {
  await invoke('graph:set-node-note', { nodeId, note });
}

/** Delete a node. A group's members are released, not deleted with it. */
export async function removeNode(nodeId: string): Promise<boolean> {
  const { removed } = await invoke('graph:remove-node', { nodeId });
  return removed;
}

/** Rename a node. Rejects when the label collides with another node. */
export async function setNodeLabel(nodeId: string, label: string): Promise<void> {
  await invoke('graph:set-node-label', { nodeId, label });
}

/** Put a node in a group, or pass '' to take it out. */
export async function setNodeGroup(nodeId: string, groupId: string): Promise<void> {
  await invoke('graph:set-node-group', { nodeId, groupId });
}

/** Remove a relationship. Returns false when it was already gone. */
export async function removeEdge(edgeId: string): Promise<boolean> {
  const { removed } = await invoke('graph:remove-edge', { edgeId });
  return removed;
}

/**
 * Change a relationship by replacing it.
 *
 * The core has no in-place edge update, and adding one for this would be a
 * larger change than the feature warrants: remove-then-add produces exactly
 * the same end state, and the core's dedup means re-adding an identical triple
 * is a no-op rather than a duplicate.
 */
export async function replaceEdge(
  edgeId: string,
  sourceId: string,
  targetId: string,
  relation: RelationKind,
): Promise<string> {
  await removeEdge(edgeId);
  return addEdge(sourceId, targetId, relation);
}

/**
 * Create an edge the author drew on the canvas.
 *
 * Returns the edge id. The core deduplicates: re-asserting an existing
 * (source, target, relation) triple bumps its weight instead of stacking a
 * second identical edge, so drawing the same connection twice is harmless.
 */
export async function addEdge(
  sourceId: string,
  targetId: string,
  relation: RelationKind,
): Promise<string> {
  const { edgeId } = await invoke('graph:add-edge', { sourceId, targetId, relation });
  return edgeId;
}
