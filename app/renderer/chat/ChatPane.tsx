/**
 * The Chat pane — third tab of the workstation.
 *
 * Graph-aware conversation against the selected local LLM CLI. Three things it is
 * careful about:
 *
 *  1. The session persists. Every turn after the first resumes the previous
 *     session id, so the conversation continues instead of restarting.
 *  2. Knowledge routing stays behind the interface so the conversation remains
 *     focused on the answer rather than implementation metadata.
 *  3. A turn in flight can always be stopped, and a stopped turn says so rather
 *     than looking like a short answer.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { CliProviderSnapshot } from '../../../shared/types/claude';

// Aliased: `invoke` from useClaude() below is the CLI bridge, and calling it
// with an IPC channel name would be a silent type-level near-miss.
import {
  addEdge,
  addNode,
  invoke as invokeIpc,
  removeNode as removeNodeIpc,
  replaceEdge,
  setEdgeNote,
  setNodeGroup,
} from '../graph/ipcClient';
import { newCellId, useGraphStore } from '../shared/store';
import { useClaude } from '../shared/useClaude';
import { applyCompletion } from './applyCompletion';
import { nextTurnToMap, seenTurnIds } from './autoMap';
import { cancelChatTurn, sendChatTurn } from './chatActions';
import MapReview from './MapReview';
import { helpText, isUnknownCommand, parseCommand } from './commands';
import {
  findBusyTurnId,
  isTurnBusy,
  renderTranscript,
} from './chatState';
import styles from './ChatPane.module.css';
import Composer from './Composer';
import {
  buildGraphContext,
  linkableLabels,
  normalizeLabel,
} from './graphContext';
import MessageList from './MessageList';
import PaneHeading from '../shared/PaneHeading';
import {
  buildEntityPresentations,
  CATEGORY_COLORS,
  CATEGORY_GLYPHS,
  formatGraphStatus,
  shortGraphName,
  type EntityPresentation,
} from '../shared/entityPresentation';
import { isBoolean, readPersisted, writePersisted } from '../shared/persisted';
import { subscribeSessionId } from './sessionTracking';
import { useChatTurns } from './useChatTurns';
import {
  CONNECTION_SCOPES,
  CONNECTION_SCOPE_LABELS,
  buildConnectionEndpoints,
  connectionScopeInstruction,
  type ConnectionScope,
} from '../graph/connectionTypes';

/** How long a primed "Clear chat" stays armed before disarming itself. */
const CLEAR_CONFIRM_TIMEOUT_MS = 4000;

/** localStorage scope for the auto-map toggle, remembered per vault. */
const AUTO_MAP_SCOPE = 'chat.autoMap';

const SUGGESTIONS = [
  'What relationships am I missing?',
  'Challenge the weakest link',
  'Summarize the map in plain language',
] as const;

/** Longest slice of an answer handed back to the model, in characters. */
const ANSWER_EXCERPT_LIMIT = 6000;

/**
 * Turn an answer into an instruction for a proposal.
 *
 * The answer is quoted rather than summarised: it already names the concepts,
 * already says what they are, and already relates them to what is on the map.
 * Asking the model to re-derive all that from the question alone would produce
 * a different set of concepts than the ones the author just read and wanted.
 */
function addToMapInstruction(question: string, answer: string): string {
  const excerpt =
    answer.length > ANSWER_EXCERPT_LIMIT ? `${answer.slice(0, ANSWER_EXCERPT_LIMIT)}…` : answer;
  return [
    'The answer below was written against this map, and named concepts the map does not have.',
    'Propose those missing concepts as newNodes. Give each one a note saying what it is, in the',
    "answer's own terms. Where the answer distinguishes named parts of a concept, list them under",
    'that concept as subConcepts with their own notes rather than as separate concepts.',
    'Then connect each new concept to the EXISTING concepts it bears on, with a note on every edge',
    'explaining the mechanism. Do not propose a concept the map already has.',
    `\n\nThe question asked: ${question}`,
    `\n\nThe answer given:\n${excerpt}`,
  ].join(' ');
}

function crossConnectionScan(scope: ConnectionScope): string {
  return [
    connectionScopeInstruction(scope),
    'Treat only authored children under existing parents as subnode endpoints, including children belonging to entirely different parents. Keep them nested; never return them in newNodes.',
    'For every proposed edge, explain the mechanism, shared constraint, condition, or tension in its note.',
  ].join(' ');
}

function EmptyState({
  hasGraph,
  onPrompt,
}: {
  hasGraph: boolean;
  onPrompt: (prompt: string) => void;
}): JSX.Element {
  return (
    <div className={styles.emptyState}>
      <p className={styles.emptyKicker}>CONTEXT IN / PERSPECTIVE OUT</p>
      <h2 className={styles.emptyTitle}>Think out loud against the graph</h2>
      <p className={styles.emptyBody}>
        {hasGraph
          ? 'Ask about what you have written. Answers cite your node labels — click one to select it in the graph.'
          : 'Open or create a vault to start a conversation.'}
      </p>
      <ul className={styles.emptyPoints}>
        <li>The bundled mindset and sector references are attached automatically.</li>
        <li>Uses the local CLI selected above through its subscription. No API keys.</li>
      </ul>
      {hasGraph ? (
        <div className={styles.emptyActions}>
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => onPrompt(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return fallback;
}

export interface ChatPaneProps {
  /**
   * Called with the text of the answer currently streaming, so the graph can
   * fire the concepts it names. Passing the whole text rather than each delta
   * is deliberate: a concept's name routinely arrives split across two chunks,
   * and a delta-only scan misses exactly those.
   */
  onStreamingText?: (text: string) => void;
  providerSnapshot?: CliProviderSnapshot | null;
  onProviderSnapshot?: (snapshot: CliProviderSnapshot) => void;
  /** A request started from the graph-side Discover button. */
  autoCompleteRequestId?: number | null;
  autoCompleteScope?: ConnectionScope;
  onAutoCompleteConsumed?: () => void;
}

function selectedProviderLabel(snapshot: CliProviderSnapshot | null | undefined): string {
  if (!snapshot) return 'a detected local CLI';
  if (snapshot.selected === 'auto') return 'Auto';
  return snapshot.selected === 'codex' ? 'ChatGPT' : 'Claude';
}

export default function ChatPane({
  onStreamingText,
  providerSnapshot,
  onProviderSnapshot,
  autoCompleteRequestId,
  autoCompleteScope = 'all',
  onAutoCompleteConsumed,
}: ChatPaneProps = {}): JSX.Element {
  const {
    graph,
    loading,
    error,
    selectedCellId,
    selectedNodeId,
    selectedSubnodeId,
    hoveredNodeId,
    hoveredSubnodeId,
    setSelectedNodeId,
    setSelectedSubnodeId,
    setHoveredNodeId,
    setHoveredSubnodeId,
    refreshSnapshot,
    undo,
    clearError,
  } =
    useGraphStore();
  const { runs, invoke, cancel } = useClaude();

  const { turns, addTurn, recordAnswer, clear } = useChatTurns(graph?.id ?? null);
  const [draft, setDraft] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeCanUndo, setNoticeCanUndo] = useState(false);
  const [dismissedErrorIds, setDismissedErrorIds] = useState<ReadonlySet<string>>(new Set());
  const [discoveryScope, setDiscoveryScope] = useState<ConnectionScope>('all');

  /**
   * The completion run in flight, if any.
   *
   * Tracked separately from chat turns: a proposal is not a message, and
   * folding it into the transcript would put a wall of JSON in a conversation
   * the author has to keep reading.
   */
  const [completionId, setCompletionId] = useState<string | null>(null);

  /**
   * Auto-map: read every finished answer for concepts the map lacks.
   *
   * OFF by default, and remembered per vault. CLAUDE.md rule 4 says nothing is
   * inferred in the background and no CLI runs without a click — this keeps
   * both: flipping the toggle IS the click, and every proposal it produces
   * still goes through the same review panel before anything reaches the graph.
   */
  const [isAutoMapping, setIsAutoMapping] = useState(false);
  /** Turns already read, so a re-render never re-reads the same answer. */
  const mappedTurnIds = useRef<Set<string>>(new Set());
  const [isApplying, setIsApplying] = useState(false);
  /** First click arms, second deletes. Wiping a transcript cannot be undone. */
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const consumedAutoCompleteId = useRef<number | null>(null);

  // Live view of the ids this pane owns, so the stream subscription can be
  // registered once and still filter correctly as turns accumulate. Claimed
  // synchronously on send as well, because the bridge can emit `started` before
  // React has committed the new turn.
  const ownedIds = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    ownedIds.current = new Set([...ownedIds.current, ...turns.map((turn) => turn.id)]);
  }, [turns]);

  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.braindump;
    if (!api) {
      setActionError('The Magistral bridge is unavailable — chat cannot reach a local AI CLI.');
      return undefined;
    }
    return subscribeSessionId(api, (requestId) => ownedIds.current.has(requestId), setSessionId);
  }, []);

  const rendered = useMemo(() => renderTranscript(turns, runs), [turns, runs]);

  /** The answer being written right now, if any. Drives the graph's recall pulses. */
  const streamingText = useMemo(() => {
    for (const run of Object.values(runs)) {
      if (run.streaming && run.text.length > 0) return run.text;
    }
    return '';
  }, [runs]);

  useEffect(() => {
    if (streamingText.length > 0) onStreamingText?.(streamingText);
  }, [streamingText, onStreamingText]);
  const busyTurnId = useMemo(() => findBusyTurnId(rendered), [rendered]);

  /**
   * Fold a finished answer back onto its turn.
   *
   * Runs are ephemeral; turns are what gets remembered. Without this a restart
   * would restore a transcript of questions with no answers under them.
   *
   * An empty answer is recorded too. A turn that failed or was stopped before
   * the first delta still has an outcome worth keeping, and skipping it leaves
   * the turn carrying nothing — which reads as 'pending' after a restart and
   * pins the composer to Stop.
   */
  useEffect(() => {
    for (const turn of rendered) {
      if (isTurnBusy(turn.status)) continue;
      recordAnswer(turn.id, turn.text, turn.status, turn.provider);
    }
  }, [rendered, recordAnswer]);
  const labels = useMemo(() => linkableLabels(graph), [graph]);
  const referenceEndpoints = useMemo(
    () => buildConnectionEndpoints(graph?.nodes ?? []),
    [graph?.nodes],
  );
  const endpointByLabel = useMemo(
    () => new Map(referenceEndpoints.map((endpoint) => [normalizeLabel(endpoint.label), endpoint] as const)),
    [referenceEndpoints],
  );
  const entitiesByLabel = useMemo(() => {
    const base = buildEntityPresentations(
      graph?.nodes ?? [],
      graph?.edges ?? [],
      selectedNodeId,
      hoveredNodeId,
    );
    const result = new Map<string, EntityPresentation>();
    for (const endpoint of referenceEndpoints) {
      const existing = base.get(endpoint.id);
      const relationCount = (graph?.edges ?? []).filter(
        (edge) => edge.source === endpoint.id || edge.target === endpoint.id,
      ).length;
      const selected = endpoint.kind === 'subnode' && selectedSubnodeId === endpoint.id;
      const hovered = endpoint.kind === 'subnode' && hoveredSubnodeId === endpoint.id;
      result.set(normalizeLabel(endpoint.label), existing
        ? {
            ...existing,
            categoryLabel: endpoint.kind === 'subnode' ? 'Subnode' : existing.categoryLabel,
            selectionState: selected ? 'selected' : hovered ? 'hovered' : existing.selectionState,
          }
        : {
            id: endpoint.id,
            canonicalName: endpoint.label,
            shortGraphName: shortGraphName(endpoint.label),
            category: 'concept',
            categoryLabel: 'Subnode',
            categoryColor: CATEGORY_COLORS.concept,
            glyph: CATEGORY_GLYPHS.concept,
            mappedState: 'mapped',
            relationshipCount: relationCount,
            selectionState: selected ? 'selected' : hovered ? 'hovered' : 'idle',
          });
    }
    return result;
  }, [
    graph?.edges,
    graph?.nodes,
    hoveredNodeId,
    hoveredSubnodeId,
    referenceEndpoints,
    selectedNodeId,
    selectedSubnodeId,
  ]);
  const relationshipTraces = useMemo(() => {
    const labelsById = new Map(referenceEndpoints.map((endpoint) => [endpoint.id, endpoint.label] as const));
    return (graph?.edges ?? []).flatMap((edge) => {
      const source = labelsById.get(edge.source);
      const target = labelsById.get(edge.target);
      if (!source || !target) return [];
      return [{
        id: edge.id,
        source,
        target,
        relation: edge.relation,
        ...(edge.note ? { note: edge.note } : {}),
      }];
    });
  }, [graph?.edges, referenceEndpoints]);

  const startPrompt = useCallback(async (message: string, resumeSessionId: string | null) => {
    try {
      const graphContext = buildGraphContext(graph, selectedCellId);
      const turn = await sendChatTurn({
        invoke,
        message,
        sessionId: resumeSessionId,
        ...(graphContext ? { graphContext } : {}),
      });
      if (!turn) return;
      ownedIds.current = new Set([...ownedIds.current, turn.id]);
      addTurn(turn);
      setDraft('');
      setDismissedErrorIds((current) => {
        if (current.size === 0) return current;
        const next = new Set(current);
        next.delete(turn.id);
        return next;
      });
    } catch (caught) {
      setActionError(errorMessage(caught, 'The chat turn could not be started.'));
    }
  }, [addTurn, graph, invoke, selectedCellId]);

  const handleSend = useCallback(async () => {
    setActionError(null);
    setNotice(null);
    setNoticeCanUndo(false);

    // Commands never reach the model. A message that merely mentions one is
    // not a command — see parseCommand — so this cannot eat a real question.
    const command = parseCommand(draft);
    if (command) {
      setDraft('');
      if (command.kind === 'clear') {
        clear();
        // A fresh transcript needs a fresh session, or the next answer would
        // still be reasoning from a conversation the author just discarded.
        setSessionId(null);
        setNotice('Conversation cleared.');
      } else {
        setNotice(helpText());
      }
      return;
    }
    if (isUnknownCommand(draft)) {
      setActionError(`Unknown command ${draft.trim()}. Try /help.`);
      return;
    }

    await startPrompt(draft, sessionId);
  }, [clear, draft, sessionId, startPrompt]);

  const retryTurn = useCallback((turn: (typeof rendered)[number]): void => {
    setActionError(null);
    void startPrompt(turn.prompt, null);
  }, [startPrompt]);

  const switchProviderAndRetry = useCallback(async (turn: (typeof rendered)[number]) => {
    const usable = providerSnapshot?.providers.filter(
      (provider) => provider.available && provider.authenticated,
    ) ?? [];
    const alternate = usable.find((provider) => provider.id !== turn.provider)?.id ?? 'auto';
    try {
      const next = await invokeIpc('llm:select', { provider: alternate });
      onProviderSnapshot?.(next);
      setSessionId(null);
      await startPrompt(turn.prompt, null);
    } catch (caught) {
      setActionError(errorMessage(caught, 'The provider could not be switched.'));
    }
  }, [onProviderSnapshot, providerSnapshot, startPrompt]);

  const completionRun = completionId ? runs[completionId] : undefined;
  const isCompleting = completionRun?.streaming === true;

  /**
   * Ask for a proposal. The composer's contents ride along as a focus, if the
   * author typed one — "complete the map, but on the financing side" is a
   * reasonable thing to want, and making them clear the box first would not be.
   */
  const startCompletion = useCallback(async (instruction: string, scope: ConnectionScope) => {
    setActionError(null);
    setNotice(null);
    setNoticeCanUndo(false);
    try {
      const graphContext = buildGraphContext(graph, selectedCellId);
      const requestId = await invoke({
        kind: 'complete',
        connectionScope: scope,
        ...(instruction ? { instruction } : {}),
        ...(graphContext ? { graphContext } : {}),
      });
      setCompletionId(requestId);
    } catch (caught) {
      setActionError(errorMessage(caught, 'Cross-connection discovery could not be started.'));
    }
  }, [graph, invoke, selectedCellId]);

  const handleComplete = useCallback(async () => {
    const focus = draft.trim();
    const instruction = [
      crossConnectionScan(discoveryScope),
      ...(focus ? [`Additional author focus: ${focus}`] : []),
    ].join(' ');
    setDraft('');
    await startCompletion(instruction, discoveryScope);
  }, [discoveryScope, draft, startCompletion]);

  /**
   * "Add to map" on a finished answer.
   *
   * Runs at 'all' scope: an answer naming concepts the graph lacks is exactly
   * the case where new nodes must be creatable, and every narrower scope refuses
   * newNodes by design.
   */
  const handleAddToMap = useCallback(
    (turn: (typeof rendered)[number]): void => {
      if (!graph || isCompleting) return;
      setDiscoveryScope('all');
      void startCompletion(addToMapInstruction(turn.prompt, turn.text), 'all');
    },
    [graph, isCompleting, startCompletion],
  );

  // Remembered per vault: auto-mapping suits a vault being built up and not one
  // being read, and that is a property of the vault, not of the session.
  useEffect(() => {
    setIsAutoMapping(readPersisted(AUTO_MAP_SCOPE, graph?.id ?? null, isBoolean, false));
    mappedTurnIds.current = new Set();
  }, [graph?.id]);

  const toggleAutoMapping = useCallback((): void => {
    setIsAutoMapping((current) => {
      const next = !current;
      writePersisted(AUTO_MAP_SCOPE, graph?.id ?? null, next);
      /*
       * Turning it ON must not retroactively read the whole transcript. The
       * author asked for what they say NEXT to be mapped, and firing twenty
       * proposals at a conversation they already had is not that.
       */
      if (next) mappedTurnIds.current = seenTurnIds(rendered);
      return next;
    });
  }, [graph?.id, rendered]);

  /**
   * Read the next unread answer, one at a time.
   *
   * Serialised deliberately: a proposal already on screen is one the author is
   * still deciding about, and replacing it mid-read would discard changes they
   * had ticked. The queue drains as each review is applied or dismissed.
   */
  useEffect(() => {
    if (!isAutoMapping || !graph || isCompleting || completionRun?.completion) return;

    const next = nextTurnToMap(rendered, mappedTurnIds.current);
    if (!next) return;

    mappedTurnIds.current.add(next.id);
    void startCompletion(addToMapInstruction(next.prompt, next.text), 'all');
  }, [completionRun?.completion, graph, isAutoMapping, isCompleting, rendered, startCompletion]);

  useEffect(() => {
    if (!autoCompleteRequestId || !graph || isCompleting) return;
    if (consumedAutoCompleteId.current === autoCompleteRequestId) return;
    consumedAutoCompleteId.current = autoCompleteRequestId;
    onAutoCompleteConsumed?.();
    setDiscoveryScope(autoCompleteScope);
    void startCompletion(crossConnectionScan(autoCompleteScope), autoCompleteScope);
  }, [
    autoCompleteRequestId,
    autoCompleteScope,
    graph,
    isCompleting,
    onAutoCompleteConsumed,
    startCompletion,
  ]);

  const existingSubnodeLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const node of graph?.nodes ?? []) {
      for (const subnode of node.subConcepts ?? []) labels.add(normalizeLabel(subnode.label));
    }
    return labels;
  }, [graph]);

  /**
   * Write the selected changes to the graph.
   *
   * The proposal is dismissed only on a clean apply. If anything failed, it
   * stays up with the failures listed — discarding it would leave the author
   * with a partial result and nothing to retry from.
   */
  const handleApply = useCallback(
    async (selected: ReadonlySet<string>) => {
      const accepted = completionRun?.completion?.accepted;
      if (!accepted || !graph) return;

      setActionError(null);
      setIsApplying(true);
      try {
        const report = await applyCompletion(accepted, selected, graph, {
          addNode,
          // One cell per accepted concept, so it lands in the Editor like
          // anything the author typed. No refresh per cell — the single
          // refreshSnapshot below picks up the whole batch.
          createCell: async (markdown) => {
            await invokeIpc('cell:upsert', { cellId: newCellId(), markdown });
          },
          // Undoes a concept whose cell could not be written, so the apply
          // never leaves a node the Editor cannot show and nothing can delete.
          removeNode: async (nodeId) => {
            await removeNodeIpc(nodeId);
          },
          setNodeGroup,
          addEdge,
          setEdgeNote,
          replaceEdge,
        }, discoveryScope);
        await refreshSnapshot();

        if (report.failures.length > 0) {
          setActionError(
            `Added ${report.applied}. ${report.failures.length} could not be applied: ` +
              report.failures.map((failure) => `${failure.subject} (${failure.reason})`).join('; '),
          );
          return;
        }
        setNotice(`Added ${report.applied} change${report.applied === 1 ? '' : 's'} to the map.`);
        setNoticeCanUndo(report.applied > 0);
        setCompletionId(null);
      } catch (caught) {
        setActionError(errorMessage(caught, 'The changes could not be applied.'));
      } finally {
        setIsApplying(false);
      }
    },
    [completionRun, discoveryScope, graph, refreshSnapshot],
  );

  /**
   * Wipe this vault's saved transcript. Same effect as `/clear`, including the
   * fresh session id — leaving the old one would have the next answer still
   * reasoning from a conversation the author just deleted.
   */
  const handleClearTranscript = useCallback((): void => {
    if (!isConfirmingClear) {
      setIsConfirmingClear(true);
      return;
    }
    setIsConfirmingClear(false);
    clear();
    setSessionId(null);
    setActionError(null);
    setNotice('Saved conversation deleted from this machine.');
    setNoticeCanUndo(false);
  }, [clear, isConfirmingClear]);

  // Disarm as soon as attention moves on, so a stray click much later cannot
  // land on a primed delete.
  useEffect(() => {
    if (!isConfirmingClear) return undefined;
    const timer = setTimeout(() => setIsConfirmingClear(false), CLEAR_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isConfirmingClear]);

  const handleCancel = useCallback(async () => {
    setActionError(null);
    try {
      await cancelChatTurn(cancel, busyTurnId);
    } catch (caught) {
      setActionError(errorMessage(caught, 'The turn could not be cancelled.'));
    }
  }, [busyTurnId, cancel]);

  const handleSelectLabel = useCallback(
    (label: string) => {
      const endpoint = endpointByLabel.get(normalizeLabel(label));
      if (endpoint?.kind === 'subnode') {
        setSelectedNodeId(null);
        setSelectedSubnodeId(endpoint.id);
        return;
      }
      setSelectedSubnodeId(null);
      setSelectedNodeId(endpoint?.id ?? null);
    },
    [endpointByLabel, setSelectedNodeId, setSelectedSubnodeId],
  );

  const handleHoverLabel = useCallback((label: string | null): void => {
    const endpoint = label ? endpointByLabel.get(normalizeLabel(label)) : undefined;
    setHoveredNodeId(endpoint && endpoint.kind !== 'subnode' ? endpoint.id : null);
    setHoveredSubnodeId(endpoint?.kind === 'subnode' ? endpoint.id : null);
  }, [endpointByLabel, setHoveredNodeId, setHoveredSubnodeId]);

  const storeError = error ?? actionError;

  return (
    <section className={styles.pane} aria-label="Chat">
      <header className={styles.header}>
        <PaneHeading
          title={graph ? graph.name : 'No vault open'}
          metrics={graph
            ? `${formatGraphStatus(graph)}${sessionId ? ' · session resuming' : ''}`
            : ''}
        />
        <div className={styles.headerActions}>
          {/*
            The transcript is remembered in localStorage, so it outlives the
            window. /clear already did this, but a command you have to know about
            is not a way to get your history off the machine. Two clicks, because
            it is not recoverable.
          */}
          <button
            type="button"
            className={isConfirmingClear ? styles.clearButtonArmed : styles.clearButton}
            onClick={handleClearTranscript}
            disabled={turns.length === 0}
            title="Delete this vault's saved conversation from local storage"
          >
            {isConfirmingClear ? 'Delete for good?' : 'Clear chat'}
          </button>
          <label className={styles.discoveryScope}>
            <span>Find</span>
            <select
              value={discoveryScope}
              aria-label="Cross-connection discovery scope"
              disabled={isCompleting}
              onChange={(event) => setDiscoveryScope(event.target.value as ConnectionScope)}
            >
              {CONNECTION_SCOPES.map((scope) => (
                <option key={scope} value={scope}>{CONNECTION_SCOPE_LABELS[scope]}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={isAutoMapping ? styles.autoMapOn : styles.autoMap}
            aria-pressed={isAutoMapping}
            onClick={toggleAutoMapping}
            disabled={graph === null}
            title={
              isAutoMapping
                ? 'Reading each answer for concepts your map lacks. Every proposal still waits for your approval.'
                : 'Read each answer as you talk and propose the concepts, subnodes and connections your map lacks. Nothing is added until you approve it.'
            }
          >
            {isAutoMapping ? '● Auto-map on' : '○ Auto-map'}
          </button>
          <button
            type="button"
            className={styles.completeButton}
            onClick={handleComplete}
            disabled={graph === null || isCompleting}
            title="Find explained bridges across groups, nodes, and subnodes. Nothing is added until you approve it."
          >
            {isCompleting ? 'Reading the map…' : '✦ Find relationships'}
          </button>
        </div>
      </header>

      {storeError ? (
        <div className={styles.banner} role="alert">
          <span>{storeError}</span>
          <button type="button" onClick={() => { setActionError(null); clearError(); }}>Dismiss</button>
        </div>
      ) : null}

      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
          {noticeCanUndo ? (
            <button type="button" onClick={() => { void undo(); setNotice(null); setNoticeCanUndo(false); }}>
              Undo
            </button>
          ) : null}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </p>
      ) : null}

      <div className={styles.transcript}>
        {loading && turns.length === 0 ? (
          <p className={styles.loading}>Loading graph…</p>
        ) : (
          <MessageList
            turns={rendered}
            labels={labels}
            entitiesByLabel={entitiesByLabel}
            onSelectLabel={handleSelectLabel}
            onHoverLabel={handleHoverLabel}
            relationships={relationshipTraces}
            dismissedErrorIds={dismissedErrorIds}
            onRetry={retryTurn}
            onSwitchProvider={
              (providerSnapshot?.providers.filter(
                (provider) => provider.available && provider.authenticated,
              ).length ?? 0) > 1
                ? switchProviderAndRetry
                : undefined
            }
            onDismissError={(turnId) =>
              setDismissedErrorIds((current) => new Set([...current, turnId]))
            }
            onAddToMap={graph ? handleAddToMap : undefined}
            isAddingToMap={isCompleting}
            emptyState={<EmptyState hasGraph={graph !== null} onPrompt={setDraft} />}
          />
        )}
      </div>

      {completionRun?.completion ? (
        <MapReview
          completion={completionRun.completion}
          existingSubnodeLabels={existingSubnodeLabels}
          isApplying={isApplying}
          onApply={handleApply}
          onDismiss={() => setCompletionId(null)}
        />
      ) : null}

      {isCompleting ? (
        <p className={styles.completing} role="status">
          Reading the map for {CONNECTION_SCOPE_LABELS[discoveryScope].toLowerCase()} relationships…
          <button type="button" onClick={() => void cancel(completionId ?? '')}>
            Stop
          </button>
        </p>
      ) : null}

      {completionRun?.error && !completionRun.cancelled ? (
        <p className={styles.banner} role="alert">
          {completionRun.error}
        </p>
      ) : null}

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        onCancel={handleCancel}
        isBusy={busyTurnId !== null}
        isEnabled={graph !== null}
        providerLabel={selectedProviderLabel(providerSnapshot)}
        suggestions={SUGGESTIONS}
      />
    </section>
  );
}
