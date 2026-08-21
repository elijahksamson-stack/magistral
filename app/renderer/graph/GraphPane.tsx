/**
 * The graph pane: a canvas, a render loop, and the gestures that drive them.
 *
 * State lives in three places on purpose — the store owns the graph and the
 * selection, the C++ core owns node positions, and this component owns only the
 * viewport and the in-flight gesture. Handlers read the gesture through a ref
 * so several pointer events inside one animation frame compose correctly
 * instead of racing React's render.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  DEFAULT_LAYOUT_PARAMS,
  NODE_KINDS,
  RELATION_KINDS,
  type GraphEdge,
  type GraphNode,
  type LayoutParams,
  type NodeKind,
  type RelationKind,
  type SubConcept,
} from '../../../shared/types/graph';
import { normalizeLabel } from '../../../shared/labels';
import ExportMenu from '../export/ExportMenu';
import { BrandGlyph } from '../shared/Brand';
import NamePrompt from '../shared/NamePrompt';
import ConnectionBuilder from './ConnectionBuilder';
import EdgeEditor from './EdgeEditor';
import NodeDetail from './NodeDetail';
import SubNodeDetail from './SubNodeDetail';
import RelationPicker from './RelationPicker';
import { newCellId, useGraphStore } from '../shared/store';
import { buildEntityPresentations } from '../shared/entityPresentation';
import { cellMarkdownFor } from '../shared/conceptCell';
import Controls from './Controls';
import GraphToolbar from './GraphToolbar';
import { CANVAS_BACKGROUND } from './constants';
import { toErrorMessage } from './errors';
import styles from './GraphPane.module.css';
import {
  INITIAL_INTERACTION_STATE,
  clearHover,
  doubleClick,
  frameGraph,
  keyDown,
  pointerCancel,
  pointerDown,
  pointerMove,
  pointerUp,
  wheel,
  zoomByStep,
  type InteractionEffect,
  type InteractionResult,
  type InteractionState,
  type SceneContext,
} from './interaction';
import {
  addEdge,
  addNode,
  invoke,
  configureLayout,
  setNodeGroup,
  pinNode,
  removeEdge,
  removeNode,
  replaceEdge,
  setEdgeNote,
  setNodeNote,
  setNodeLabel,
  resetLayout,
  unpinNode,
} from './ipcClient';
import { renderGraph } from './renderer';
import { buildNodeContentSizes } from './nodeStyle';
import { computeGroupHulls, groupAt } from './groups';
import { resolveExpansion, toggleExpanded } from './expansion';
import { hitTestEdge } from './hitTest';
import {
  EMPTY_DISCOVERY,
  beginDiscovery,
  discoveryProgress,
  newEdgeIds,
  pruneDiscovery,
  type DiscoveryState,
} from './discovery';
import {
  EMPTY_RECALL,
  buildRecallIndex,
  fireNodes,
  findRecalled,
  pruneRecall,
  recallIntensity,
  type RecallState,
} from './recall';
import { computeNeighbourhood } from './selection';
import { linkSpanText, setLinkSpanText } from './linkSpan';
import { findUnlinkedMentions, linkMentionAt, type UnlinkedMention } from './unlinkedMentions';
import { embeddedImages } from './embeds';
import { flowPhase } from './flow';
import { useClaude } from '../shared/useClaude';
import { useLayoutLoop } from './useLayoutLoop';
import { nodePoint, withPositionOverrides } from './positionIndex';
import { screenToWorld, worldToScreen, type Point, type Size } from './viewport';
import { animateCamera, revealSelection } from './camera';
import {
  CONNECTION_SCOPE_LABELS,
  buildConnectionEndpoints,
  edgesForConnectionScope,
  type ConnectionEndpointKind,
  type ConnectionScope,
} from './connectionTypes';

const EMPTY_NODES: readonly GraphNode[] = [];
const EMPTY_EDGES: readonly GraphEdge[] = [];
const EMPTY_SIZE: Size = { width: 0, height: 0 };

/** Used only to keep the relation picker inside the pane. */
const PICKER_WIDTH_PX = 240;
const PICKER_HEIGHT_PX = 430;
const EDGE_EDITOR_WIDTH_PX = 236;
const EDGE_EDITOR_HEIGHT_PX = 400;
const EMPTY_STRENGTHS: ReadonlyMap<string, number> = new Map();
const SUBNODE_ORBIT_WORLD = 72;

/**
 * Ceiling on unlinked mentions offered for one concept.
 *
 * A short label can appear in every cell in the vault. A panel listing two
 * hundred of them is one the author closes rather than reads, and the useful
 * ones are always near the top.
 */
const MAX_UNLINKED_MENTIONS = 25;

function nestedPosition(
  parent: GraphNode,
  child: GraphNode,
  index: ReturnType<typeof withPositionOverrides>,
): Point {
  const children = parent.subConcepts ?? [];
  const slot = Math.max(
    0,
    children.findIndex(
      (candidate) => normalizeLabel(candidate.label) === normalizeLabel(child.label),
    ),
  );
  const total = Math.max(1, children.length);
  const angle = -Math.PI / 2 + (slot / total) * Math.PI * 2;
  const centre = nodePoint(index, parent);
  return {
    x: centre.x + Math.cos(angle) * SUBNODE_ORBIT_WORLD,
    y: centre.y + Math.sin(angle) * SUBNODE_ORBIT_WORLD,
  };
}

/** An edge the author has drawn but not yet named. */
interface PendingConnection {
  sourceId: string;
  targetId: string;
  /** Drop point, pane-local. */
  x: number;
  y: number;
}

function localPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export interface GraphPaneProps {
  /**
   * Text of the answer currently streaming in the chat pane. Every concept it
   * names fires a green pulse. Absent in the editor, where nothing is being
   * recalled.
   */
  recallText?: string;
  /** Opens the reviewed AI relationship scout from the Editor/Graph workspace. */
  onFindConnections?: (scope: ConnectionScope) => void;
}

export default function GraphPane({ recallText, onFindConnections }: GraphPaneProps = {}) {
  const {
    graph,
    loading,
    error: storeError,
    selectedNodeId,
    selectedSubnodeId,
    selectedCellId,
    hoveredNodeId: storeHoveredNodeId,
    hoveredSubnodeId,
    hoveredCellId,
    setSelectedNodeId,
    setSelectedSubnodeId,
    setSelectedCellId,
    setSelectedCellAnchor,
    setHoveredNodeId,
    setHoveredSubnodeId,
    refreshSnapshot,
    upsertCell,
  } = useGraphStore();

  const { invoke: invokeClaude, runs: claudeRuns } = useClaude();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framedSceneRef = useRef<string | null>(null);
  const cancelCameraRef = useRef<(() => void) | null>(null);

  const [size, setSize] = useState<Size>(EMPTY_SIZE);
  const [dpr, setDpr] = useState(1);
  const [params, setParams] = useState<LayoutParams>(DEFAULT_LAYOUT_PARAMS);
  const [paneError, setPaneError] = useState<string | null>(null);
  const [interactionState, setInteractionState] = useState<InteractionState>(
    INITIAL_INTERACTION_STATE,
  );
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  /** Persistent, discoverable alternative to the expert Shift+drag gesture. */
  const [connectMode, setConnectMode] = useState(false);
  const [isConnectionBuilderOpen, setIsConnectionBuilderOpen] = useState(false);
  const [connectSourceId, setConnectSourceIdState] = useState<string | null>(null);
  const [pointerAt, setPointerAt] = useState<Point | null>(null);
  const [focusOnly, setFocusOnly] = useState(false);
  const [nodeKinds, setNodeKinds] = useState<ReadonlySet<NodeKind>>(
    () => new Set(NODE_KINDS),
  );
  const [relations, setRelations] = useState<ReadonlySet<RelationKind>>(
    () => new Set(RELATION_KINDS),
  );
  const [connectionScope, setConnectionScope] = useState<ConnectionScope>('all');

  /**
   * The relation kinds the map actually uses, in the canonical order, for the
   * legend. Derived from the edges rather than from the filter set: the legend
   * describes what is drawn, and a kind can be filtered on while no edge has it.
   */
  const presentRelations = useMemo((): RelationKind[] => {
    const used = new Set((graph?.edges ?? []).map((edge) => edge.relation));
    return RELATION_KINDS.filter((relation) => used.has(relation));
  }, [graph?.edges]);

  /** The relationship being edited, plus where the click landed. */
  const [editingEdge, setEditingEdge] = useState<{ edgeId: string; x: number; y: number } | null>(
    null,
  );
  const [isNamingGroup, setIsNamingGroup] = useState(false);
  /**
   * Concepts the author has opened, oldest first, capped at two.
   *
   * Their sub-concepts stay in colour and everything else greys out, so a
   * connection can be drawn between two neighbourhoods while the rest of the
   * map stays readable behind it.
   */
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  const interactionRef = useRef(INITIAL_INTERACTION_STATE);
  const connectModeRef = useRef(false);
  const connectSourceRef = useRef<string | null>(null);

  const setConnectSourceId = useCallback((nodeId: string | null): void => {
    connectSourceRef.current = nodeId;
    setConnectSourceIdState(nodeId);
  }, []);

  const changeConnectMode = useCallback((active: boolean): void => {
    connectModeRef.current = active;
    setConnectMode(active);
    setConnectSourceId(null);
    setPendingConnection(null);
    setEditingEdge(null);
    if (active) {
      setSelectedNodeId(null);
      setSelectedSubnodeId(null);
    }
  }, [setConnectSourceId, setSelectedNodeId]);

  const openConnectionBuilder = useCallback((): void => {
    changeConnectMode(false);
    setIsConnectionBuilderOpen(true);
  }, [changeConnectMode]);

  const nodes = graph?.nodes ?? EMPTY_NODES;
  const edges = graph?.edges ?? EMPTY_EDGES;
  const contentSizes = useMemo(
    () => buildNodeContentSizes(nodes, graph?.cells ?? []),
    [graph?.cells, nodes],
  );
  const { index, isRunning, restart, invalidateTopology } = useLayoutLoop({
    isEnabled: nodes.length > 0,
    // A node drag writes a pin per pointermove; without this the loop settles
    // between them and none of those pins is ever drawn.
    keepAwake: interactionState.mode === 'node' || interactionState.mode === 'connect',
    onError: setPaneError,
  });

  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node] as const)),
    [nodes],
  );
  const connectionEndpoints = useMemo(() => buildConnectionEndpoints(nodes), [nodes]);
  const endpointById = useMemo(
    () => new Map(connectionEndpoints.map((endpoint) => [endpoint.id, endpoint] as const)),
    [connectionEndpoints],
  );
  const selectedSubnode = selectedSubnodeId
    ? endpointById.get(selectedSubnodeId) ?? null
    : null;
  useEffect(() => {
    if (selectedSubnodeId && selectedSubnode?.kind !== 'subnode') {
      setSelectedSubnodeId(null);
    }
  }, [selectedSubnode, selectedSubnodeId]);
  useEffect(() => {
    if (selectedSubnode?.kind !== 'subnode') return;
    setExpandedIds(selectedSubnode.parentIds.slice(0, 2));
  }, [selectedSubnode]);

  /*
   * Selecting a facet on the canvas takes the Editor to the prose that asserts
   * it. A sub-concept has no cell of its own — it lives inside a line of its
   * parent's — so the parent's cell is where "go to it" actually lands, and the
   * Editor scrolls there and folds everything else away.
   */
  /*
   * Fires once per selection, tracked by id rather than by the endpoint object.
   *
   * Keying this on the object was a feedback loop: the Editor consumes the
   * anchor by setting it back to null, which re-renders this pane, which
   * rebuilds `endpointById` and hands back a fresh endpoint object — so the
   * effect refired, re-set the anchor, and the two panes ping-ponged until
   * React gave up on the update depth and the detail panel stopped rendering.
   * An id is a string: it only changes when the author selects something else.
   */
  const anchoredSubnodeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedSubnodeId) {
      anchoredSubnodeRef.current = null;
      return;
    }
    if (anchoredSubnodeRef.current === selectedSubnodeId) return;

    const subnode = endpointById.get(selectedSubnodeId);
    if (subnode?.kind !== 'subnode') return;
    const cellId = subnode.parentIds
      .map((parentId) => nodeById.get(parentId))
      .find((parent) => parent !== undefined && parent.cellIds.length > 0)?.cellIds[0];
    if (!cellId) return;

    anchoredSubnodeRef.current = selectedSubnodeId;
    // The label is what the Editor searches for: the cell is the container, the
    // line naming this facet is the destination.
    setSelectedCellAnchor(subnode.label);
    setSelectedCellId(cellId);
  }, [endpointById, nodeById, selectedSubnodeId, setSelectedCellAnchor, setSelectedCellId]);
  const levelEdges = useMemo(
    () => edgesForConnectionScope(edges, endpointById, connectionScope),
    [connectionScope, edges, endpointById],
  );
  const filteredConnectionEdges = useMemo(
    () => levelEdges.filter((edge) => relations.has(edge.relation)),
    [levelEdges, relations],
  );
  const scopedEndpointIds = useMemo(() => {
    if (connectionScope === 'all') return null;
    return new Set(filteredConnectionEdges.flatMap((edge) => [edge.source, edge.target]));
  }, [connectionScope, filteredConnectionEdges]);
  const scopedParentIds = useMemo(() => {
    if (!scopedEndpointIds) return null;
    const parents = new Set<string>();
    for (const endpointId of scopedEndpointIds) {
      const endpoint = endpointById.get(endpointId);
      if (endpoint?.kind !== 'subnode') continue;
      for (const parentId of endpoint.parentIds) parents.add(parentId);
    }
    return parents;
  }, [endpointById, scopedEndpointIds]);
  const cellFocusId = selectedCellId ?? hoveredCellId;
  const cellFocusNodeId = useMemo(
    () => nodes.find((node) => cellFocusId && node.cellIds.includes(cellFocusId))?.id ?? null,
    [cellFocusId, nodes],
  );
  const focusNodeId =
    interactionState.hoveredNodeId ??
    storeHoveredNodeId ??
    hoveredSubnodeId ??
    selectedSubnodeId ??
    selectedNodeId ??
    cellFocusNodeId;
  const highlightIds = useMemo(
    () => computeNeighbourhood(filteredConnectionEdges, focusNodeId),
    [filteredConnectionEdges, focusNodeId],
  );
  const visibleNodes = useMemo(() => {
    const byKind = nodes.filter((node) => {
      const endpoint = endpointById.get(node.id);
      if (!scopedEndpointIds) {
        // Nested children surface through their parent expansion, not as
        // free-standing top-level nodes in the ordinary map.
        return nodeKinds.has(node.kind) && endpoint?.kind !== 'subnode';
      }
      if (scopedParentIds?.has(node.id)) return true;
      return nodeKinds.has(node.kind) && scopedEndpointIds.has(node.id);
    });
    if (!focusOnly || !highlightIds) return byKind;
    return byKind.filter((node) => highlightIds.has(node.id) || scopedParentIds?.has(node.id));
  }, [endpointById, focusOnly, highlightIds, nodeKinds, nodes, scopedEndpointIds, scopedParentIds]);

  const expansion = useMemo(
    () => resolveExpansion(nodes, expandedIds, { positionOf: (node) => nodePoint(index, node) }),
    [nodes, expandedIds, index],
  );
  const renderedNodes = useMemo(() => {
    const rendered = [...visibleNodes];
    const included = new Set(rendered.map((node) => node.id));

    // An explicitly exposed real sub-concept remains visible even when the
    // ordinary focus filter would omit it; otherwise clicking its parent could
    // reveal a relationship line ending at an invisible node.
    if (connectionScope !== 'all') return rendered;
    for (const node of nodes) {
      if (!expansion.exposedIds.has(node.id) || included.has(node.id)) continue;
      rendered.push(node);
      included.add(node.id);
    }
    rendered.push(...expansion.virtualNodes);
    return rendered;
  }, [connectionScope, expansion, nodes, visibleNodes]);
  const renderedNodeById = useMemo(
    () => new Map(renderedNodes.map((node) => [node.id, node] as const)),
    [renderedNodes],
  );
  const hierarchyLinks = useMemo(() => {
    if (connectionScope === 'all') return expansion.links;
    const links: Array<{ sourceId: string; targetId: string }> = [];
    for (const endpoint of connectionEndpoints) {
      if (endpoint.kind !== 'subnode' || !renderedNodeById.has(endpoint.id)) continue;
      for (const parentId of endpoint.parentIds) {
        if (renderedNodeById.has(parentId)) links.push({ sourceId: parentId, targetId: endpoint.id });
      }
    }
    return links;
  }, [connectionEndpoints, connectionScope, expansion.links, renderedNodeById]);
  const displayPositionOverrides = useMemo(() => {
    const overrides = new Map<string, Point>();
    for (const endpoint of connectionEndpoints) {
      if (endpoint.kind !== 'subnode' || endpoint.isVirtual) continue;
      const child = renderedNodeById.get(endpoint.id);
      if (connectionScope === 'all' && !expansion.exposedIds.has(endpoint.id)) continue;
      const parent = endpoint.parentIds
        .map((parentId) => renderedNodeById.get(parentId))
        .find((candidate): candidate is GraphNode => candidate !== undefined);
      if (child && parent) overrides.set(child.id, nestedPosition(parent, child, index));
    }
    return overrides;
  }, [connectionEndpoints, connectionScope, expansion.exposedIds, index, renderedNodeById]);
  const displayIndex = useMemo(
    () => withPositionOverrides(index, displayPositionOverrides),
    [displayPositionOverrides, index],
  );
  const subNodeIds = useMemo(
    () => new Set([
      ...connectionEndpoints
        .filter((endpoint) => endpoint.kind === 'subnode')
        .map((endpoint) => endpoint.id),
      ...expansion.links.map((link) => link.targetId),
    ]),
    [connectionEndpoints, expansion.links],
  );
  const visibleNodeIds = useMemo(
    () => new Set(renderedNodes.map((node) => node.id)),
    [renderedNodes],
  );
  const visibleEdges = useMemo(
    () => filteredConnectionEdges.filter(
      (edge) =>
        visibleNodeIds.has(edge.source) &&
        visibleNodeIds.has(edge.target),
    ),
    [filteredConnectionEdges, visibleNodeIds],
  );
  const sceneContext = useMemo<SceneContext>(
    () => ({ nodes: renderedNodes, index: displayIndex, contentSizes }),
    [renderedNodes, displayIndex, contentSizes],
  );
  const presentations = useMemo(
    () => buildEntityPresentations(
      renderedNodes,
      visibleEdges,
      selectedSubnodeId ?? selectedNodeId,
      focusNodeId,
    ),
    [focusNodeId, renderedNodes, selectedNodeId, selectedSubnodeId, visibleEdges],
  );

  // -- plumbing -------------------------------------------------------------

  const applyState = useCallback((next: InteractionState) => {
    interactionRef.current = next;
    setInteractionState(next);
  }, []);
  const moveCamera = useCallback((next: InteractionState): void => {
    cancelCameraRef.current?.();
    cancelCameraRef.current = animateCamera(interactionRef.current, next, applyState);
  }, [applyState]);
  useEffect(() => () => cancelCameraRef.current?.(), []);

  /**
   * The scene as it is NOW, for handlers that must not close over a render.
   *
   * runEffects hit-tests edges, and its identity has to stay stable across
   * renders. Reading `edges` from the closure meant it kept testing against
   * the list captured when the callback was first built — so after a
   * relationship was flipped (which mints a new edge id) every later click
   * resolved to an id that no longer existed, and the editor never opened
   * again. Same failure shape as the stale save that resurrected "Untitled".
   */
  const sceneRef = useRef({
    edges: visibleEdges,
    nodeById: renderedNodeById,
    realNodeById: nodeById,
    virtualNodeById: expansion.virtualNodeById,
    endpointById,
    index: displayIndex,
  });
  sceneRef.current = {
    edges: visibleEdges,
    nodeById: renderedNodeById,
    realNodeById: nodeById,
    virtualNodeById: expansion.virtualNodeById,
    endpointById,
    index: displayIndex,
  };

  // Same reason: runEffects must not close over a particular render's copy.
  const refreshSnapshotRef = useRef(refreshSnapshot);
  refreshSnapshotRef.current = refreshSnapshot;

  const runEffects = useCallback(
    (effects: readonly InteractionEffect[]) => {
      const fail = (cause: unknown): void => setPaneError(toErrorMessage(cause));
      for (const effect of effects) {
        if (effect.kind === 'select') {
          // Connect mode turns two ordinary clicks into one typed connection.
          // It works for persisted nodes, group nodes, and view-only subnodes;
          // the latter are materialized only after the author picks a relation.
          if (connectModeRef.current && effect.at) {
            const clickedId = effect.nodeId;
            const sourceId = connectSourceRef.current;
            if (!clickedId || clickedId === sourceId) {
              setConnectSourceId(null);
              continue;
            }
            if (!sourceId) {
              setConnectSourceId(clickedId);
              setSelectedSubnodeId(null);
              setSelectedNodeId(null);
              setSelectedCellId(null);
              setEditingEdge(null);
              continue;
            }
            setConnectSourceId(null);
            setPendingConnection({
              sourceId,
              targetId: clickedId,
              x: effect.at.x,
              y: effect.at.y,
            });
            continue;
          }

          // A click that missed every node may still have landed on a
          // relationship. Nodes win: an edge passing under one must not
          // steal the click.
          if (effect.nodeId === null && effect.at) {
            const scene = sceneRef.current;
            const edgeId = hitTestEdge(
              {
                edges: scene.edges,
                nodeById: scene.nodeById,
                index: scene.index,
                viewport: interactionRef.current.viewport,
              },
              effect.at,
            );
            if (edgeId) {
              setSelectedSubnodeId(null);
              setSelectedNodeId(null);
              setSelectedCellId(null);
              setEditingEdge({ edgeId, x: effect.at.x, y: effect.at.y });
              continue;
            }
          }

          const virtual = effect.nodeId
            ? sceneRef.current.virtualNodeById.get(effect.nodeId)
            : null;
          if (virtual) {
            setSelectedSubnodeId(effect.nodeId);
            setSelectedNodeId(null);
            setSelectedCellId(null);
            setEditingEdge(null);
            continue;
          }

          const endpoint = effect.nodeId
            ? sceneRef.current.endpointById.get(effect.nodeId)
            : null;
          if (endpoint?.kind === 'subnode') {
            setSelectedSubnodeId(endpoint.id);
            setSelectedNodeId(null);
            setSelectedCellId(null);
            setEditingEdge(null);
            continue;
          }

          const selected = effect.nodeId
            ? sceneRef.current.realNodeById.get(effect.nodeId)
            : null;
          setSelectedSubnodeId(null);
          setSelectedNodeId(selected?.id ?? null);
          setSelectedCellId(selected?.cellIds[0] ?? null);
          setEditingEdge(null);

          // Expansion is a click gesture. Keyboard navigation and detail-panel
          // links may select a node without unexpectedly replacing a slot.
          if (!effect.at) continue;
          if (!selected) setExpandedIds([]);
          else if (selected.kind !== 'group') {
            setExpandedIds((current) => toggleExpanded(current, selected.id));
          }
        }
        else if (effect.kind === 'wake') restart();
        else if (effect.kind === 'pin') {
          if (!sceneRef.current.virtualNodeById.has(effect.nodeId)) {
            void pinNode(effect.nodeId, effect.x, effect.y).catch(fail);
          }
        }
        else if (effect.kind === 'drop') {
          // Dropping inside a circle joins that group; dropping outside every
          // circle leaves whichever one the node was in.
          const scene = sceneRef.current;
          const dragged = scene.realNodeById.get(effect.nodeId);
          if (dragged && dragged.kind !== 'group') {
            const target = activeGroupRef.current ?? '';
            if ((dragged.groupId ?? '') !== target) {
              void setNodeGroup(effect.nodeId, target)
                .then(() => refreshSnapshotRef.current())
                .catch(fail);
            }
          }
        }
        else if (effect.kind === 'connect')
          {
            setConnectSourceId(null);
            setPendingConnection({
              sourceId: effect.sourceId,
              targetId: effect.targetId,
              x: effect.at.x,
              y: effect.at.y,
            });
          }
        else if (!sceneRef.current.virtualNodeById.has(effect.nodeId)) {
          void unpinNode(effect.nodeId).catch(fail);
        }
      }
    },
    [restart, setConnectSourceId, setSelectedCellId, setSelectedNodeId],
  );

  useEffect(() => {
    const endpoint = interactionState.hoveredNodeId
      ? endpointById.get(interactionState.hoveredNodeId)
      : undefined;
    setHoveredNodeId(endpoint && endpoint.kind !== 'subnode' ? endpoint.id : null);
    setHoveredSubnodeId(endpoint?.kind === 'subnode' ? endpoint.id : null);
  }, [endpointById, interactionState.hoveredNodeId, setHoveredNodeId, setHoveredSubnodeId]);

  const applyResult = useCallback(
    (result: InteractionResult) => {
      applyState(result.state);
      runEffects(result.effects);
    },
    [applyState, runEffects],
  );

  // -- drawing an edge ------------------------------------------------------

  const labelOf = useCallback(
    (nodeId: string): string =>
      endpointById.get(nodeId)?.label ?? renderedNodeById.get(nodeId)?.label ?? 'unknown',
    [endpointById, renderedNodeById],
  );

  const endpointKind = useCallback(
    (nodeId: string): ConnectionEndpointKind => {
      return endpointById.get(nodeId)?.kind ??
        (renderedNodeById.get(nodeId)?.kind === 'group' ? 'group' : 'node');
    },
    [endpointById, renderedNodeById],
  );

  const materializeEndpoint = useCallback(
    async (nodeId: string): Promise<string> => {
      const endpoint = endpointById.get(nodeId);
      const virtual = expansion.virtualNodeById.get(nodeId);
      if (!virtual && !endpoint?.isVirtual) return nodeId;

      // Merely looking at a facet never mutates the graph. The relationship
      // gesture is the explicit assertion that makes it addressable while it
      // remains a nested child of its authored parent.
      const label = virtual?.node.label ?? endpoint?.label ?? '';
      const note = virtual?.node.note ?? endpoint?.note;
      const realId = await addNode(label, 'concept');
      if (note) await setNodeNote(realId, note);
      return realId;
    },
    [endpointById, expansion.virtualNodeById],
  );

  /**
   * Commit the edge the author drew, then refresh so it appears immediately.
   * The picker closes first: leaving it open through an await makes a slow
   * round-trip look like a dead click.
   */
  const onPickRelation = useCallback(
    (relation: RelationKind, note: string): void => {
      const pending = pendingConnection;
      if (!pending) return;
      setPendingConnection(null);

      void (async () => {
        const sourceId = await materializeEndpoint(pending.sourceId);
        const targetId = await materializeEndpoint(pending.targetId);
        if (sourceId === targetId) {
          throw new Error('A concept cannot be connected to itself.');
        }
        const edgeId = await addEdge(sourceId, targetId, relation);
        if (note.trim()) await setEdgeNote(edgeId, note.trim());
        await refreshSnapshot();
        invalidateTopology();
        restart();
      })()
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [
      pendingConnection,
      materializeEndpoint,
      refreshSnapshot,
      invalidateTopology,
      restart,
    ],
  );

  const chooseManualEndpoints = useCallback(
    (sourceId: string, targetId: string): void => {
      setIsConnectionBuilderOpen(false);
      setPendingConnection({
        sourceId,
        targetId,
        x: Math.max(0, size.width / 2 - PICKER_WIDTH_PX / 2),
        y: 72,
      });
    },
    [size.width],
  );

  const pickManualEndpointsOnCanvas = useCallback((): void => {
    setIsConnectionBuilderOpen(false);
    setConnectionScope('all');
    changeConnectMode(true);
  }, [changeConnectMode]);

  useEffect(() => {
    if (!connectSourceId) return;
    if (renderedNodeById.has(connectSourceId)) return;
    setConnectSourceId(null);
  }, [connectSourceId, renderedNodeById, setConnectSourceId]);

  // -- groups ---------------------------------------------------------------

  const groupHulls = useMemo(
    () => computeGroupHulls(visibleNodes, displayIndex, interactionState.viewport.zoom, contentSizes),
    [visibleNodes, displayIndex, interactionState.viewport.zoom, contentSizes],
  );

  /**
   * The group a dragged node is currently over. Highlighted while dragging so
   * the drop is predictable, and applied on release.
   */
  const activeGroupId = useMemo(() => {
    const draggingId = interactionState.mode === 'node' ? interactionState.dragNodeId : null;
    if (!draggingId || !interactionState.hasMoved) return null;

    const dragged = nodeById.get(draggingId);
    // A group cannot go inside a group, so dragging one highlights nothing.
    if (!dragged || dragged.kind === 'group') return null;

    const at = interactionState.lastScreen;
    if (!at) return null;
    const world = screenToWorld(interactionState.viewport, at.x, at.y);
    // Its current group goes in so leaving takes a deliberate pull rather than
    // happening the instant the node grazes the ring.
    return groupAt(groupHulls, world, dragged.groupId ?? null);
  }, [interactionState, nodeById, groupHulls]);

  const activeGroupRef = useRef<string | null>(null);
  activeGroupRef.current = activeGroupId;

  /**
   * Rename a node. Only groups reach this — a concept's name is its
   * [[wikilink]], and renaming one here would disagree with the cell.
   */
  const onRenameNode = useCallback(
    (label: string): void => {
      if (!selectedNodeId) return;
      void setNodeLabel(selectedNodeId, label)
        .then(() => refreshSnapshot())
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [selectedNodeId, refreshSnapshot],
  );

  /**
   * Delete the selected node. Reached only from a group's panel: a concept is
   * removed by deleting the [[wikilink]] that asserts it, and offering a second
   * route would leave the text and the graph disagreeing.
   *
   * The core releases a deleted group's members rather than deleting them.
   */
  const onDeleteNode = useCallback((): void => {
    const nodeId = selectedNodeId;
    if (!nodeId) return;
    setSelectedNodeId(null);
    void removeNode(nodeId)
      .then(async () => {
        await refreshSnapshot();
        invalidateTopology();
        restart();
      })
      .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
  }, [selectedNodeId, setSelectedNodeId, refreshSnapshot, invalidateTopology, restart]);

  /**
   * Give a stranded concept the cell that asserts it.
   *
   * A concept with no cell cannot be edited or deleted, because both go
   * through that cell's [[wikilink]]. Writing one puts it back on the normal
   * route rather than adding a second one — the core's syncCell resolves the
   * link to the node that already exists, so this attaches a cell rather than
   * making a duplicate concept.
   *
   * Explicit, never automatic: the graph is only ever built by a click.
   */
  /*
   * A concept's own description. The core holds this one directly, so it is a
   * straight write — but the snapshot still has to be re-read afterwards, or
   * the panel keeps showing the text the author just replaced.
   */
  /** The cell a concept was authored in, with its markdown, when it has one. */
  const cellTextFor = useCallback(
    (node: GraphNode | null | undefined): { cellId: string; markdown: string } | null => {
      const cellId = node?.cellIds[0];
      const markdown = graph?.cells.find((cell) => cell.id === cellId)?.markdown;
      return cellId !== undefined && markdown !== undefined ? { cellId, markdown } : null;
    },
    [graph?.cells],
  );

  const onSaveNodeDescription = useCallback(
    (next: string): void => {
      const target = selectedNodeId ? nodeById.get(selectedNodeId) : null;
      if (!target) return;

      // A concept the author wrote keeps its description in the cell, so the
      // cell is what must change. The core's own note field is only for a node
      // no cell authored — one an import or a proposal put on the canvas.
      const source = cellTextFor(target);
      const current = source ? linkSpanText(source.markdown, target.label) : null;
      if (source && current !== null) {
        // Saving the text that is already there is not a change worth a write.
        if (next.trim() === current.trim()) return;

        const rewritten = setLinkSpanText(source.markdown, target.label, next);
        if (rewritten === source.markdown) {
          // The description differs but the cell did not move, so the label is
          // not linked in the cell we resolved. Silence here is what discarded
          // an author's typing without a word.
          setPaneError(`"${target.label}" could not be updated in its cell.`);
          return;
        }
        void upsertCell(source.cellId, rewritten)
          .then(() => {
            invalidateTopology();
            restart();
          })
          .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
        return;
      }

      void setNodeNote(target.id, next)
        .then(() => refreshSnapshot())
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [cellTextFor, invalidateTopology, nodeById, refreshSnapshot, restart, selectedNodeId, upsertCell],
  );

  /*
   * A sub-concept's description lives in the cell that authored it — the core
   * rebuilds subConcepts from the markdown on every edit, so anything written
   * anywhere else would be erased by the next keystroke in the Editor. Writing
   * the cell is the only durable route, and it is also what the author would
   * have done by hand.
   */
  const onSaveSubnodeDescription = useCallback(
    (next: string): void => {
      const subnode = selectedSubnodeId ? endpointById.get(selectedSubnodeId) : null;
      if (!subnode || subnode.kind !== 'subnode') return;

      const parent = subnode.parentIds
        .map((parentId) => nodeById.get(parentId))
        .find((candidate) => candidate !== undefined && candidate.cellIds.length > 0);
      const cellId = parent?.cellIds[0];
      const markdown = graph?.cells.find((cell) => cell.id === cellId)?.markdown;
      if (cellId === undefined || markdown === undefined) {
        setPaneError(`No cell authors "${subnode.label}", so its description cannot be saved.`);
        return;
      }

      /*
       * One rule for both shapes: the link owns the text up to the next link,
       * whether it sits alone on its line or mid-paragraph. The two-rule version
       * this replaced had to guess which writer applied, and guessed wrong on an
       * aliased link — silently discarding the edit.
       */
      const current = linkSpanText(markdown, subnode.label);
      if (current !== null && next.trim() === current.trim()) return;

      const rewritten = setLinkSpanText(markdown, subnode.label, next);
      if (rewritten === markdown) {
        setPaneError(`"${subnode.label}" is not linked in the cell that owns it.`);
        return;
      }
      void upsertCell(cellId, rewritten)
        .then(() => {
          invalidateTopology();
          restart();
        })
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [
      endpointById,
      graph?.cells,
      invalidateTopology,
      nodeById,
      restart,
      selectedSubnodeId,
      upsertCell,
    ],
  );

  /*
   * "Write it": the local model drafts a description from the concept's name
   * and the neighbourhood the author drew around it.
   *
   * The result is written through the same save path a typed edit uses, so
   * there is exactly one way a description reaches the graph. Nothing is
   * applied until the run finishes — a half-streamed sentence saved on every
   * chunk would churn the cell and the undo history with fragments.
   */
  const [describeRunId, setDescribeRunId] = useState<string | null>(null);
  const describeSaveRef = useRef<((text: string) => void) | null>(null);
  const describeRun = describeRunId ? claudeRuns[describeRunId] : undefined;

  useEffect(() => {
    if (!describeRunId || !describeRun || describeRun.streaming) return;
    setDescribeRunId(null);
    const save = describeSaveRef.current;
    describeSaveRef.current = null;
    if (describeRun.error) {
      setPaneError(describeRun.error);
      return;
    }
    const text = describeRun.text.trim();
    if (text.length > 0) save?.(text);
  }, [describeRun, describeRunId]);

  const startDescribe = useCallback(
    (
      label: string,
      neighbours: readonly string[],
      save: (text: string) => void,
      extras: {
        subConcepts?: readonly string[];
        parentLabel?: string;
        existing?: string;
      } = {},
    ): void => {
      describeSaveRef.current = save;
      void invokeClaude({
        kind: 'describe',
        label,
        neighbours,
        ...(extras.subConcepts ? { subConcepts: extras.subConcepts } : {}),
        ...(extras.parentLabel ? { parentLabel: extras.parentLabel } : {}),
        ...(extras.existing?.trim() ? { existing: extras.existing.trim() } : {}),
      })
        .then((requestId) => setDescribeRunId(requestId))
        .catch((cause: unknown) => {
          describeSaveRef.current = null;
          setPaneError(toErrorMessage(cause));
        });
    },
    [invokeClaude],
  );

  /** Relationships as the model should read them: phrase plus the other end. */
  const neighbourPhrasesFor = useCallback(
    (nodeId: string): string[] =>
      edges
        .filter((edge) => edge.source === nodeId || edge.target === nodeId)
        .map((edge) => {
          const isOutgoing = edge.source === nodeId;
          const other = labelOf(isOutgoing ? edge.target : edge.source);
          const arrow = isOutgoing ? `${edge.relation} →` : `← ${edge.relation}`;
          return edge.note ? `${arrow} ${other} (${edge.note})` : `${arrow} ${other}`;
        }),
    [edges, labelOf],
  );

  /*
   * What the panel shows. A concept written as a section heading owns the prose
   * beneath it, which the core's line-scoped note cannot see — that is why a
   * concept with pages under it read as "No description yet". The section wins
   * where there is one; otherwise the core's note stands.
   *
   * Declared before the generate callbacks that list these in their dependency
   * arrays: a dep array is evaluated at render, so a `const` below would be a
   * temporal-dead-zone error rather than a stale value.
   */
  const selectedNodeDescription = useMemo((): string => {
    const target = selectedNodeId ? nodeById.get(selectedNodeId) : null;
    if (!target) return '';
    const source = cellTextFor(target);
    const authored = source ? linkSpanText(source.markdown, target.label) : null;
    return authored ?? target.note ?? '';
  }, [cellTextFor, nodeById, selectedNodeId]);

  /**
   * Where the selected concept is named in prose without being linked.
   *
   * Capped, because a common word can appear in every cell and a panel listing
   * two hundred of them is one the author closes rather than reads. The count
   * shown is the count offered, so the number never overstates the work.
   */
  const selectedNodeMentions = useMemo((): UnlinkedMention[] => {
    const target = selectedNodeId ? nodeById.get(selectedNodeId) : null;
    if (!target || target.kind === 'group') return [];
    return findUnlinkedMentions(graph?.cells ?? [], target.label).slice(0, MAX_UNLINKED_MENTIONS);
  }, [graph?.cells, nodeById, selectedNodeId]);

  /**
   * Bracket one mention, turning writing already done into a relationship.
   *
   * Goes through `upsertCell` like a typed edit, so the core re-parses the cell
   * and the new link becomes an edge by the same route as one typed by hand.
   */
  const onLinkMention = useCallback(
    (mention: UnlinkedMention): void => {
      const cell = graph?.cells.find((candidate) => candidate.id === mention.cellId);
      if (!cell) return;

      const rewritten = linkMentionAt(cell.markdown, mention.index, mention.text.length);
      if (rewritten === cell.markdown) {
        setPaneError('That mention has moved since the panel was drawn. Reopen the concept.');
        return;
      }

      void upsertCell(cell.id, rewritten)
        .then(() => {
          invalidateTopology();
          restart();
        })
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [graph?.cells, invalidateTopology, restart, upsertCell],
  );

  /**
   * Images the selected concept's cell embeds, read as data URLs.
   *
   * Loaded in an effect rather than a memo because reading them crosses IPC.
   * The request is abandoned when the selection changes mid-flight, so clicking
   * quickly through concepts cannot land an earlier concept's figures on a
   * later one.
   */
  const [selectedNodeImages, setSelectedNodeImages] = useState<
    readonly { fileName: string; dataUrl: string }[]
  >([]);

  useEffect(() => {
    const target = selectedNodeId ? nodeById.get(selectedNodeId) : null;
    const source = target ? cellTextFor(target) : null;
    const fileNames = source ? embeddedImages(source.markdown) : [];
    const vaultId = graph?.id;

    if (!vaultId || fileNames.length === 0) {
      setSelectedNodeImages([]);
      return undefined;
    }

    let isCurrent = true;
    void Promise.all(
      fileNames.map(async (fileName) => {
        const { dataUrl } = await invoke('image:read', { vaultId, fileName });
        return dataUrl ? { fileName, dataUrl } : null;
      }),
    )
      .then((loaded) => {
        // A missing file is a gap in the gallery, not an error: a cell can
        // outlive an attachment the author deleted by hand.
        if (isCurrent) setSelectedNodeImages(loaded.filter((image) => image !== null));
      })
      .catch((cause: unknown) => {
        if (isCurrent) setPaneError(toErrorMessage(cause));
      });

    return () => {
      isCurrent = false;
    };
  }, [cellTextFor, graph?.id, nodeById, selectedNodeId]);

  const selectedSubnodeDescription = useMemo((): string => {
    if (selectedSubnode?.kind !== 'subnode') return '';
    const parent = selectedSubnode.parentIds
      .map((parentId) => nodeById.get(parentId))
      .find((candidate) => candidate !== undefined && candidate.cellIds.length > 0);
    const source = cellTextFor(parent);
    const authored = source ? linkSpanText(source.markdown, selectedSubnode.label) : null;
    return authored ?? selectedSubnode.note ?? '';
  }, [cellTextFor, nodeById, selectedSubnode]);

  const onGenerateNodeDescription = useCallback((): void => {
    const target = selectedNodeId ? nodeById.get(selectedNodeId) : null;
    if (!target) return;
    startDescribe(
      target.label,
      neighbourPhrasesFor(target.id),
      onSaveNodeDescription,
      {
        subConcepts: (target.subConcepts ?? []).map((sub) => sub.label),
        existing: selectedNodeDescription,
      },
    );
  }, [
    neighbourPhrasesFor,
    nodeById,
    onSaveNodeDescription,
    selectedNodeDescription,
    selectedNodeId,
    startDescribe,
  ]);

  const onGenerateSubnodeDescription = useCallback((): void => {
    const subnode = selectedSubnodeId ? endpointById.get(selectedSubnodeId) : null;
    if (!subnode || subnode.kind !== 'subnode') return;

    const parent = subnode.parentIds
      .map((parentId) => nodeById.get(parentId))
      .find((candidate) => candidate !== undefined);
    // A sub-concept has no edges of its own, so its neighbourhood IS its
    // parent's: that is the context which gives it meaning in this map.
    startDescribe(
      subnode.label,
      parent ? neighbourPhrasesFor(parent.id) : [],
      onSaveSubnodeDescription,
      {
        ...(parent ? { parentLabel: parent.label } : {}),
        ...(parent
          ? { subConcepts: (parent.subConcepts ?? []).map((sub) => sub.label) }
          : {}),
        existing: selectedSubnodeDescription,
      },
    );
  }, [
    endpointById,
    neighbourPhrasesFor,
    nodeById,
    onSaveSubnodeDescription,
    selectedSubnodeDescription,
    selectedSubnodeId,
    startDescribe,
  ]);

  const onWriteCell = useCallback((): void => {
    const target = nodes.find((candidate) => candidate.id === selectedNodeId);
    if (!target || target.kind === 'group' || target.cellIds.length > 0) return;

    const cellId = newCellId();
    void upsertCell(cellId, cellMarkdownFor(target.label, target.note))
      .then(() => {
        // Jump the Editor to it, so "it is in the Editor now" is visible
        // rather than asserted.
        setSelectedCellId(cellId);
        invalidateTopology();
        restart();
      })
      .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
  }, [
    nodes,
    selectedNodeId,
    upsertCell,
    setSelectedCellId,
    invalidateTopology,
    restart,
  ]);

  const createGroup = useCallback(
    (label: string): void => {
      void addNode(label, 'group')
        .then(async () => {
          await refreshSnapshot();
          invalidateTopology();
          restart();
        })
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [refreshSnapshot, invalidateTopology, restart],
  );

  // -- recall pulses --------------------------------------------------------

  const [recall, setRecall] = useState<RecallState>(EMPTY_RECALL);
  const recallIndex = useMemo(() => buildRecallIndex(nodes), [nodes]);

  useEffect(() => {
    if (recallText === undefined || recallText.length === 0) return;
    const hits = findRecalled(recallIndex, recallText);
    if (hits.length === 0) return;
    setRecall((state) => fireNodes(state, hits, Date.now()));
  }, [recallText, recallIndex]);

  /**
   * Decay loop. Runs only while something is lit, so an idle graph costs
   * nothing — the layout loop already stops when it settles, and this must
   * not be the thing that keeps a frame timer alive forever.
   */
  const [recallStrengths, setRecallStrengths] = useState<ReadonlyMap<string, number>>(EMPTY_STRENGTHS);
  useEffect(() => {
    if (recall.size === 0) {
      setRecallStrengths((current) => (current.size === 0 ? current : EMPTY_STRENGTHS));
      return undefined;
    }

    let frame = 0;
    const step = (): void => {
      const now = Date.now();
      const strengths = new Map<string, number>();
      for (const nodeId of recall.keys()) {
        const intensity = recallIntensity(recall, nodeId, now);
        if (intensity > 0) strengths.set(nodeId, intensity);
      }
      setRecallStrengths(strengths);

      const pruned = pruneRecall(recall, now);
      if (pruned !== recall) {
        setRecall(pruned);
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [recall]);

  // -- flow -----------------------------------------------------------------

  /*
   * Explicitly started and explicitly stopped. The loop exists only while it is
   * playing, so a stopped graph costs nothing — the layout loop already settles
   * when it converges, and this must not become the thing that keeps a frame
   * timer alive forever.
   */
  const [isFlowing, setIsFlowing] = useState(false);
  const [flowAt, setFlowAt] = useState(0);
  useEffect(() => {
    if (!isFlowing) return undefined;

    let frame = 0;
    const step = (): void => {
      setFlowAt(flowPhase(Date.now()));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [isFlowing]);

  // -- discovery pulses -----------------------------------------------------

  /*
   * A relationship arriving is an event, so it is detected from the snapshot
   * rather than from whichever surface caused it — chat proposals, the
   * connection builder and a canvas drag all land the same way and should all
   * read the same way. The previous edge list is a ref, not state: it exists
   * only to diff against and must not itself trigger a render.
   */
  const [discovery, setDiscovery] = useState<DiscoveryState>(EMPTY_DISCOVERY);
  const previousEdgesRef = useRef<readonly GraphEdge[] | null>(null);
  useEffect(() => {
    const landed = newEdgeIds(previousEdgesRef.current, edges);
    previousEdgesRef.current = edges;
    if (landed.length === 0) return;
    setDiscovery((state) => beginDiscovery(state, landed, Date.now()));
  }, [edges]);

  /** Travel loop, alive only while something is in flight. See recall above. */
  const [discoveryProgressById, setDiscoveryProgressById] =
    useState<ReadonlyMap<string, number>>(EMPTY_STRENGTHS);
  useEffect(() => {
    if (discovery.size === 0) {
      setDiscoveryProgressById((current) => (current.size === 0 ? current : EMPTY_STRENGTHS));
      return undefined;
    }

    let frame = 0;
    const step = (): void => {
      const now = Date.now();
      const travelled = new Map<string, number>();
      for (const edgeId of discovery.keys()) {
        const progress = discoveryProgress(discovery, edgeId, now);
        if (progress !== null) travelled.set(edgeId, progress);
      }
      setDiscoveryProgressById(travelled);

      const pruned = pruneDiscovery(discovery, now);
      if (pruned !== discovery) {
        setDiscovery(pruned);
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [discovery]);

  // -- editing a relationship -----------------------------------------------

  const edgeById = useMemo(
    () => new Map(edges.map((edge) => [edge.id, edge] as const)),
    [edges],
  );
  const editedEdge = editingEdge ? (edgeById.get(editingEdge.edgeId) ?? null) : null;

  const afterEdgeChange = useCallback(async (): Promise<void> => {
    await refreshSnapshot();
    invalidateTopology();
    restart();
  }, [refreshSnapshot, invalidateTopology, restart]);

  const onChangeRelation = useCallback(
    (relation: RelationKind): void => {
      if (!editedEdge) return;
      const at = editingEdge ? { x: editingEdge.x, y: editingEdge.y } : null;
      void replaceEdge(editedEdge.id, editedEdge.source, editedEdge.target, relation)
        .then(async (newEdgeId) => {
          await afterEdgeChange();
          // Stay open so the sentence at the top confirms what it now says.
          if (at) setEditingEdge({ edgeId: newEdgeId, ...at });
        })
        .catch((cause: unknown) => {
          setEditingEdge(null);
          setPaneError(toErrorMessage(cause));
        });
    },
    [editedEdge, editingEdge, afterEdgeChange],
  );

  /**
   * Reverse by re-asserting the same relation with the endpoints swapped.
   *
   * The editor stays open on the NEW edge — replacing mints a fresh id, and
   * closing would mean hunting the line down again to reverse it back. Flipping
   * is the one edit people do repeatedly while deciding which way round the
   * claim actually reads.
   */
  const onFlipEdge = useCallback((): void => {
    if (!editedEdge || !editingEdge) return;
    const at = { x: editingEdge.x, y: editingEdge.y };

    void replaceEdge(editedEdge.id, editedEdge.target, editedEdge.source, editedEdge.relation)
      .then(async (newEdgeId) => {
        await afterEdgeChange();
        setEditingEdge({ edgeId: newEdgeId, ...at });
      })
      .catch((cause: unknown) => {
        setEditingEdge(null);
        setPaneError(toErrorMessage(cause));
      });
  }, [editedEdge, editingEdge, afterEdgeChange]);

  /**
   * Describe the relationship. Unlike a relation change this does NOT replace
   * the edge, so the editor keeps pointing at the same id and the text the
   * author is writing stays put.
   */
  const onChangeEdgeNote = useCallback(
    (note: string): void => {
      if (!editedEdge) return;
      void setEdgeNote(editedEdge.id, note)
        .then(() => refreshSnapshot())
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [editedEdge, refreshSnapshot],
  );

  const onDeleteEdge = useCallback((): void => {
    if (!editedEdge) return;
    setEditingEdge(null);
    void removeEdge(editedEdge.id)
      .then(afterEdgeChange)
      .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
  }, [editedEdge, afterEdgeChange]);

  // -- size, layout wake-ups, framing ---------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      setDpr(window.devicePixelRatio || 1);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const topologySignature = `${nodes.length}:${edges.length}:${graph?.updatedAt ?? ''}`;
  useEffect(() => {
    invalidateTopology();
  }, [topologySignature, invalidateTopology]);

  const clickConnectDraft = useMemo(() => {
    if (!connectMode || !connectSourceId) return null;
    const source = renderedNodeById.get(connectSourceId);
    if (!source) return null;

    const hovered = interactionState.hoveredNodeId;
    const targetId = hovered && hovered !== connectSourceId ? hovered : null;
    const target = targetId ? renderedNodeById.get(targetId) : null;
    const sourceWorld = nodePoint(displayIndex, source);
    const targetWorld = target ? nodePoint(displayIndex, target) : null;
    return {
      sourceId: connectSourceId,
      to: targetWorld
        ? worldToScreen(interactionState.viewport, targetWorld.x, targetWorld.y)
        : pointerAt ?? worldToScreen(interactionState.viewport, sourceWorld.x, sourceWorld.y),
      targetId,
    };
  }, [
    connectMode,
    connectSourceId,
    displayIndex,
    interactionState.hoveredNodeId,
    interactionState.viewport,
    pointerAt,
    renderedNodeById,
  ]);

  useEffect(() => {
    if (!graph || !displayIndex || nodes.length === 0 || size.width === 0) return;
    if (interactionRef.current.mode !== 'idle') return;
    /*
     * Refit only when the MAP or the VIEWPORT changes — a different graph, a
     * resized pane, a different connection level.
     *
     * It used to refit whenever the set of visible nodes changed, and hovering
     * a concept expands its sub-concepts, so a hover silently rebuilt the whole
     * camera: the author's zoom and pan were discarded mid-gesture and a
     * connection could not be drawn because the target moved out from under the
     * pointer. The camera belongs to the author. Nothing they merely LOOK at
     * is allowed to move it.
     */
    const signature = `${graph.id}:${size.width}x${size.height}:${connectionScope}`;
    if (framedSceneRef.current === signature) return;
    framedSceneRef.current = signature;
    moveCamera(frameGraph(interactionRef.current, sceneContext, size));
  }, [connectionScope, displayIndex, graph, moveCamera, nodes.length, sceneContext, size]);

  /*
   * Bringing a selected concept into view. Pans only — never refits — so the
   * scale the author chose survives selecting something, and it stays where it
   * is when the concept is already comfortably on screen.
   */
  const revealedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    const endpointId = selectedSubnodeId ?? selectedNodeId ?? '';
    if (!endpointId || !displayIndex || size.width === 0) {
      revealedSelectionRef.current = null;
      return;
    }
    if (revealedSelectionRef.current === endpointId) return;
    if (interactionRef.current.mode !== 'idle') return;

    const selected = renderedNodeById.get(endpointId);
    if (!selected) return;
    revealedSelectionRef.current = endpointId;
    // The detail inspector owns the right 310px, so a concept selected beneath
    // it is nudged clear rather than left hidden behind the panel describing it.
    moveCamera(revealSelection(interactionRef.current, nodePoint(displayIndex, selected), size));
  }, [displayIndex, moveCamera, renderedNodeById, selectedNodeId, selectedSubnodeId, size]);

  // -- the frame ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setPaneError('This display could not provide a 2D drawing context.');
      return;
    }

    renderGraph(ctx, {
      nodes: renderedNodes,
      nodeById: renderedNodeById,
      edges: visibleEdges,
      index: displayIndex,
      viewport: interactionState.viewport,
      width: size.width,
      height: size.height,
      dpr,
      background: CANVAS_BACKGROUND,
      selectedNodeId: selectedSubnodeId ?? selectedNodeId,
      hoveredNodeId: focusNodeId,
      highlightIds,
      forceLabels: false,
      groupHulls,
      activeGroupId,
      exposedIds: expansion.expandedIds.length > 0 ? expansion.exposedIds : null,
      subNodeIds,
      expansionLinks: hierarchyLinks,
      recall: recallStrengths,
      discovery: discoveryProgressById,
      flowPhase: isFlowing ? flowAt : null,
      connectDraft:
        interactionState.mode === 'connect' && interactionState.connectFromId
          ? {
              sourceId: interactionState.connectFromId,
              to: interactionState.connectScreen ?? { x: 0, y: 0 },
              targetId: interactionState.connectTargetId,
            }
          : clickConnectDraft,
      contentSizes,
      presentations,
    });
  }, [
    activeGroupId,
    dpr,
    groupHulls,
    visibleEdges,
    focusNodeId,
    expansion,
    hierarchyLinks,
    highlightIds,
    displayIndex,
    interactionState,
    renderedNodeById,
    recallStrengths,
    discoveryProgressById,
    isFlowing,
    flowAt,
    renderedNodes,
    subNodeIds,
    contentSizes,
    presentations,
    clickConnectDraft,
    selectedNodeId,
    selectedSubnodeId,
    size,
  ]);

  /** Native listener: React's wheel handler is passive and cannot preventDefault. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const point: Point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      applyState(wheel(interactionRef.current, point, event.deltaY).state);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [applyState]);

  // -- controls -------------------------------------------------------------

  const onZoomIn = useCallback(
    () => applyState(zoomByStep(interactionRef.current, 1, size)),
    [applyState, size],
  );
  const onZoomOut = useCallback(
    () => applyState(zoomByStep(interactionRef.current, -1, size)),
    [applyState, size],
  );
  const onFit = useCallback(
    () => moveCamera(frameGraph(interactionRef.current, sceneContext, size)),
    [moveCamera, sceneContext, size],
  );

  const toggleNodeKind = useCallback((kind: NodeKind): void => {
    setNodeKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const toggleRelation = useCallback((relation: RelationKind): void => {
    setRelations((current) => {
      const next = new Set(current);
      if (next.has(relation)) next.delete(relation);
      else next.add(relation);
      return next;
    });
  }, []);

  const changeConnectionScope = useCallback((scope: ConnectionScope): void => {
    setConnectionScope(scope);
    setExpandedIds([]);
    setFocusOnly(false);
    setSelectedNodeId(null);
    setSelectedSubnodeId(null);
    setEditingEdge(null);
    setPendingConnection(null);
  }, [setSelectedNodeId]);

  const resetFilters = useCallback((): void => {
    setNodeKinds(new Set(NODE_KINDS));
    setRelations(new Set(RELATION_KINDS));
    setConnectionScope('all');
    setFocusOnly(false);
    setExpandedIds([]);
    setSelectedSubnodeId(null);
  }, []);

  const onRerun = useCallback(() => {
    void resetLayout()
      .then(() => restart())
      .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
  }, [restart]);

  const onParamChange = useCallback(
    (patch: Partial<LayoutParams>) => {
      setParams((current) => ({ ...current, ...patch }));
      void configureLayout(patch)
        .then(() => restart())
        .catch((cause: unknown) => setPaneError(toErrorMessage(cause)));
    },
    [restart],
  );

  // -- gestures -------------------------------------------------------------

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    applyResult(
      pointerDown(interactionRef.current, sceneContext, localPoint(event), {
        // Shift turns a node drag into an edge draw. Plain drag still moves
        // and pins, which is the gesture people reach for first.
        connect: event.shiftKey || connectModeRef.current,
      }),
    );
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = localPoint(event);
    setPointerAt(point);
    applyResult(pointerMove(interactionRef.current, sceneContext, point));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = localPoint(event);
    const current = interactionRef.current;

    // In persistent Connect mode, a press/release without travel chooses one
    // endpoint. A travelled press still uses the fast drag-to-connect path.
    if (connectModeRef.current && !current.hasMoved) {
      const world = screenToWorld(current.viewport, point.x, point.y);
      // A group's enclosing circle is its largest, easiest target. Members
      // still win because a press directly on one enters `connect` mode and
      // supplies connectFromId; blank space inside the hull resolves here.
      const clickedId = current.connectFromId ?? groupAt(groupHulls, world);
      applyState(pointerUp(current, sceneContext, point).state);
      runEffects([{ kind: 'select', nodeId: clickedId, at: point }]);
      return;
    }
    applyResult(pointerUp(current, sceneContext, point));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>): void => {
    if (event.key === 'Escape' && connectModeRef.current) {
      event.preventDefault();
      changeConnectMode(false);
      return;
    }
    const result = keyDown(interactionRef.current, sceneContext, event.key, size, selectedNodeId);
    if (!result.handled) return;
    event.preventDefault();
    applyResult(result);
  };

  const message = paneError ?? storeError;
  const isEmpty = !loading && nodes.length === 0;
  const isScopedViewEmpty =
    !loading && nodes.length > 0 && connectionScope !== 'all' && visibleEdges.length === 0;
  /**
   * Shift+drag is invisible until someone says so, and a graph of unconnected
   * dots is exactly when the author needs to hear it. Shown only while there is
   * something to connect and nothing connected yet, so it retires on its own.
   */
  const shouldHintConnect =
    !loading && nodes.length >= 2 && edges.length === 0 && selectedNodeId === null;
  const expansionCount = expansion.expandedIds.length;

  /** Clicking a concept opens its sub-concepts — the only place they surface. */
  const selectedNode = selectedNodeId ? (nodeById.get(selectedNodeId) ?? null) : null;
  const selectNodeFromDetail = useCallback((nodeId: string): void => {
    setSelectedSubnodeId(null);
    setSelectedNodeId(nodeId);
  }, [setSelectedNodeId]);
  const selectAuthoredSubnode = useCallback((subnode: SubConcept): void => {
    if (!selectedNodeId) return;
    const endpoint = connectionEndpoints.find(
      (candidate) =>
        candidate.kind === 'subnode' &&
        candidate.parentIds.includes(selectedNodeId) &&
        normalizeLabel(candidate.label) === normalizeLabel(subnode.label),
    );
    if (!endpoint) return;
    setSelectedSubnodeId(endpoint.id);
    setSelectedNodeId(null);
    setSelectedCellId(null);
  }, [connectionEndpoints, selectedNodeId, setSelectedCellId, setSelectedNodeId]);

  return (
    <div className={styles.pane} ref={containerRef}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        width={Math.max(1, Math.round(size.width * dpr))}
        height={Math.max(1, Math.round(size.height * dpr))}
        style={{ width: `${size.width}px`, height: `${size.height}px` }}
        tabIndex={0}
        role="application"
        aria-label="Knowledge graph"
        data-connect-mode={connectMode ? 'true' : 'false'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => applyResult(pointerCancel(interactionRef.current))}
        onPointerLeave={() => {
          setPointerAt(null);
          applyState(clearHover(interactionRef.current));
        }}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          applyResult(
            doubleClick(interactionRef.current, sceneContext, {
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            }),
          );
        }}
        onKeyDown={onKeyDown}
      />

      {isEmpty ? (
        <div className={styles.empty}>
          <BrandGlyph className={styles.emptyGlyph} />
          <p className={styles.emptyKicker}>HOLD THE CONTEXT · SEE THE SYSTEM</p>
          <p className={styles.emptyTitle}>Start with one thought.</p>
          <p className={styles.emptyHint}>
            Type a <code>[[wikilink]]</code> in the editor, or ask Chat to find cross-connections.
            <br />
            Then <kbd>Shift</kbd> + drag between concepts to connect them.
          </p>
        </div>
      ) : null}

      {isScopedViewEmpty && !isConnectionBuilderOpen ? (
        <div className={styles.scopeEmpty} role="status">
          <strong>No {CONNECTION_SCOPE_LABELS[connectionScope]} connections yet</strong>
          <span>Change the level filter, build one manually, or ask AI to look for one.</span>
          <button type="button" onClick={openConnectionBuilder}>Add relationship</button>
        </div>
      ) : null}

      {selectedSubnode?.kind === 'subnode' ? (
        <SubNodeDetail
          label={selectedSubnode.label}
          description={selectedSubnodeDescription}
          onSaveDescription={onSaveSubnodeDescription}
          onGenerateDescription={onFindConnections ? onGenerateSubnodeDescription : undefined}
          isGenerating={describeRunId !== null}
          generateHint={
            selectedSubnodeDescription.trim()
              ? 'Deepen the description you have, using this facet’s parent concept and everything it connects to. Your claims are kept.'
              : "Write a description from this facet's parent concept and everything it connects to."
          }
          onClose={() => setSelectedSubnodeId(null)}
        />
      ) : selectedNode ? (
        <NodeDetail
          node={selectedNode}
          edges={edges}
          allNodes={nodes}
          labelOf={labelOf}
          onSelectNode={selectNodeFromDetail}
          onSelectSubnode={selectAuthoredSubnode}
          onOpenCell={(cellId) => setSelectedCellId(cellId)}
          onRename={onRenameNode}
          onDelete={onDeleteNode}
          onWriteCell={onWriteCell}
          description={selectedNodeDescription}
          onSaveDescription={onSaveNodeDescription}
          onGenerateDescription={onFindConnections ? onGenerateNodeDescription : undefined}
          isGenerating={describeRunId !== null}
          generateHint={
            selectedNodeDescription.trim()
              ? 'Deepen the description you have, using this concept’s sub-concepts and everything it connects to. Your claims are kept.'
              : "Write a description from this concept's name, its sub-concepts and everything it connects to."
          }
          unlinkedMentions={selectedNodeMentions}
          onLinkMention={onLinkMention}
          images={selectedNodeImages}
          onClose={() => setSelectedNodeId(null)}
        />
      ) : null}

      {!isEmpty ? (
        <GraphToolbar
          focusOnly={focusOnly}
          hasFocus={focusNodeId !== null}
          isFlowing={isFlowing}
          onFlowingChange={setIsFlowing}
          connectMode={connectMode}
          connectSourceLabel={connectSourceId ? labelOf(connectSourceId) : undefined}
          nodeKinds={nodeKinds}
          relations={relations}
          presentRelations={presentRelations}
          connectionScope={connectionScope}
          onFocusOnlyChange={setFocusOnly}
          onConnectModeChange={changeConnectMode}
          onOpenConnectionBuilder={openConnectionBuilder}
          onFindConnections={onFindConnections}
          onToggleNodeKind={toggleNodeKind}
          onToggleRelation={toggleRelation}
          onConnectionScopeChange={changeConnectionScope}
          onReset={resetFilters}
        />
      ) : null}

      <button
        type="button"
        className={styles.newGroup}
        onClick={() => setIsNamingGroup(true)}
        title="Create a group and drag nodes into it"
      >
        <span aria-hidden="true">◯</span> New group
      </button>

      {isNamingGroup ? (
        <NamePrompt
          title="Name this group"
          confirmLabel="Create"
          initialValue=""
          onConfirm={(label) => {
            setIsNamingGroup(false);
            createGroup(label);
          }}
          onCancel={() => setIsNamingGroup(false)}
        />
      ) : null}

      {editedEdge && editingEdge ? (
        <EdgeEditor
          edge={editedEdge}
          sourceLabel={labelOf(editedEdge.source)}
          targetLabel={labelOf(editedEdge.target)}
          x={Math.min(editingEdge.x, Math.max(0, size.width - EDGE_EDITOR_WIDTH_PX))}
          y={Math.min(editingEdge.y, Math.max(0, size.height - EDGE_EDITOR_HEIGHT_PX))}
          onChangeRelation={onChangeRelation}
          onChangeNote={onChangeEdgeNote}
          onFlip={onFlipEdge}
          onDelete={onDeleteEdge}
          onClose={() => setEditingEdge(null)}
        />
      ) : null}

      {connectMode ? (
        <p className={styles.connectHint}>
          {connectSourceId
            ? `From ${labelOf(connectSourceId)} · choose any group, node, or subnode`
            : 'Add relationship · click a source, then any group region, node, or exposed subnode · Esc exits'}
        </p>
      ) : expansionCount > 0 ? (
        <p className={styles.connectHint}>
          {expansionCount === 1
            ? '1 of 2 concepts open · click one more to compare · Connect links any exposed endpoint'
            : '2 concepts open · another click replaces the comparison · Connect links any exposed endpoint'}
        </p>
      ) : shouldHintConnect ? (
        <p className={styles.connectHint}>
          Choose <strong>Add relationship</strong>, then click two endpoints · or <kbd>Shift</kbd> + drag
        </p>
      ) : null}

      {message ? (
        <div className={styles.banner} role="alert">
          <span>{message}</span>
          <button type="button" onClick={() => setPaneError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}

      {isConnectionBuilderOpen ? (
        <ConnectionBuilder
          endpoints={connectionEndpoints}
          initialScope={connectionScope}
          onConnect={chooseManualEndpoints}
          onPickOnCanvas={pickManualEndpointsOnCanvas}
          onCancel={() => setIsConnectionBuilderOpen(false)}
        />
      ) : null}

      {pendingConnection ? (
        <RelationPicker
          sourceLabel={labelOf(pendingConnection.sourceId)}
          targetLabel={labelOf(pendingConnection.targetId)}
          sourceKind={endpointKind(pendingConnection.sourceId)}
          targetKind={endpointKind(pendingConnection.targetId)}
          promotesSource={expansion.virtualNodeById.has(pendingConnection.sourceId)}
          promotesTarget={expansion.virtualNodeById.has(pendingConnection.targetId)}
          x={Math.min(pendingConnection.x, Math.max(0, size.width - PICKER_WIDTH_PX))}
          y={Math.min(pendingConnection.y, Math.max(0, size.height - PICKER_HEIGHT_PX))}
          onPick={onPickRelation}
          onCancel={() => setPendingConnection(null)}
        />
      ) : null}

      <ExportMenu graph={graph} index={index} />
      <Controls
        zoom={interactionState.viewport.zoom}
        isSimulating={isRunning}
        params={params}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onFit={onFit}
        onRerun={onRerun}
        onParamChange={onParamChange}
      />
    </div>
  );
}
