/**
 * One cell: a CodeMirror markdown block with its own ✦ button.
 *
 * Edits are debounced into `upsertCell`, which is what syncs the cell's
 * `[[wikilinks]]` into the graph. Everything else — the menu, the run, the
 * accept/reject decision — hangs off this one block.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { SourceDocument } from '../../../shared/types/claude';
import type { CellAction } from '../../../shared/types/claude';
import type { Cell as CellModel } from '../../../shared/types/graph';
import { useGraphStore } from '../shared/store';
import styles from './Cell.module.css';
import { cellSummaryOf, cellTitleOf, UNTITLED_CELL } from './cell-summary';
import SparkleMenu from './SparkleMenu';
import StreamingOverlay from './StreamingOverlay';
import { CATEGORY_COLORS, CATEGORY_GLYPHS } from '../shared/entityPresentation';
import { collectSuggestableLabels, findNodeIdByLabel } from './cell-request';
import { buildConnectionEndpoints } from '../graph/connectionTypes';
import { normalizeLabel } from '../../../shared/labels';
import { CELL_UPSERT_DEBOUNCE_MS, createDebouncer, type Debouncer } from './debounce';
import { getErrorMessage } from './errors';
import { useCellEditor, type CellEditorHandle, type FocusPosition } from './useCellEditor';
import { useCellRun } from './useCellRun';

export interface CellProps {
  cell: CellModel;
  /** The first cell has nothing to merge back into. */
  isFirst: boolean;
  /** Changes when this cell should take focus. Null when it should not. */
  focusToken: number | null;
  focusPosition: FocusPosition;
  onFocusHandled(): void;
  onAddBelow(): void;
  onRemove(): void;
  onMergeIntoPrevious(): void;
  /**
   * A document to distil into this cell, set once by the import flow. The cell
   * starts the run itself so an import reuses the same streaming preview and
   * Accept/Reject gate as every other action — an import must not write into
   * the author's document unreviewed either.
   */
  pendingImport?: SourceDocument | null;
  onImportStarted?(): void;
  /**
   * Collapse is CONTROLLED by the pane rather than held here, so it survives
   * this component unmounting and can be remembered across restarts. Local
   * state would reset every time the cell list re-rendered.
   */
  isCollapsed: boolean;
  onToggleCollapsed(): void;
  isPinned: boolean;
  onTogglePinned(): void;
  /** AI affordances do not exist when no authenticated local CLI exists. */
  llmAvailable?: boolean;
}

export default function Cell({
  cell,
  isFirst,
  pendingImport,
  onImportStarted,
  isCollapsed,
  onToggleCollapsed,
  focusToken,
  focusPosition,
  onFocusHandled,
  onAddBelow,
  onRemove,
  onMergeIntoPrevious,
  isPinned,
  onTogglePinned,
  llmAvailable = true,
}: CellProps) {
  const {
    graph,
    upsertCell,
    setSelectedNodeId,
    setSelectedSubnodeId,
    setSelectedCellId,
    selectedCellId,
    selectedSubnodeId,
    hoveredNodeId,
    setHoveredNodeId,
    setHoveredCellId,
  } = useGraphStore();
  const run = useCellRun(cell);

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [capturedSelection, setCapturedSelection] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const cellIdRef = useRef(cell.id);
  cellIdRef.current = cell.id;
  const upsertRef = useRef(upsertCell);
  upsertRef.current = upsertCell;
  const editorRef = useRef<CellEditorHandle | null>(null);

  const debouncerRef = useRef<Debouncer<string> | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createDebouncer<string>(CELL_UPSERT_DEBOUNCE_MS, (markdown) => {
      upsertRef.current(cellIdRef.current, markdown)
        .then(() => setSaveError(null))
        .catch((error: unknown) => setSaveError(getErrorMessage(error)));
    });
  }
  const debouncer = debouncerRef.current;

  const nodeLabels = useMemo(() => collectSuggestableLabels(graph), [graph]);
  const cellNodes = useMemo(
    () => (graph?.nodes ?? []).filter((node) => node.cellIds.includes(cell.id)),
    [cell.id, graph],
  );
  const primaryNodeId = cellNodes[0]?.id ?? null;

  /*
   * Following a link opens what it actually IS on the map. A label naming a
   * facet of another concept is a sub-concept, and selecting its parent node
   * instead left the author one level above the thing they clicked.
   */
  const openLink = useCallback(
    (label: string): void => {
      const endpoint = buildConnectionEndpoints(graph?.nodes ?? []).find(
        (candidate) => normalizeLabel(candidate.label) === normalizeLabel(label),
      );
      if (endpoint?.kind === 'subnode') {
        setSelectedNodeId(null);
        setSelectedSubnodeId(endpoint.id);
        return;
      }

      const nodeId = findNodeIdByLabel(graph?.nodes ?? [], label);
      if (nodeId !== null) {
        setSelectedSubnodeId(null);
        setSelectedNodeId(nodeId);
        return;
      }
      // The link is newer than the last sync. Push the edit through so the node
      // exists; the author's next click will land on it.
      debouncer.flush();
    },
    [debouncer, graph, setSelectedNodeId, setSelectedSubnodeId],
  );

  /* Read inside a CodeMirror callback, which closes over its first render. */
  const selectedSubnodeIdRef = useRef(selectedSubnodeId);
  selectedSubnodeIdRef.current = selectedSubnodeId;

  const isRunStreaming = run.active !== null && run.active.isStreaming;
  const isRunStreamingRef = useRef(isRunStreaming);
  isRunStreamingRef.current = isRunStreaming;

  // Guarded because ⌘⏎ reaches this directly, bypassing the disabled trigger.
  const openMenu = useCallback((): void => {
    if (!llmAvailable || isRunStreamingRef.current) return;
    setCapturedSelection(editorRef.current?.getSelectionText() ?? '');
    setIsMenuOpen(true);
  }, [llmAvailable]);

  const editor = useCellEditor(cell.markdown, {
    onDocChanged: (markdown) => debouncer.schedule(markdown),
    onFocusChanged: (isFocused) => {
      if (isFocused) {
        setSelectedCellId(cell.id);
        /*
         * Typing into the cell must not close the panel the author is working
         * against. A sub-concept lives inside this very cell, so editing here
         * IS editing it — replacing the selection with the cell's own node
         * shut the inspector the moment they clicked in to make a change.
         * With nothing open, the old behaviour stands: the cell names its node.
         */
        if (selectedSubnodeIdRef.current === null) {
          setSelectedNodeId(primaryNodeId);
        }
        return;
      }
      debouncer.flush();
    },
    onOpenLink: openLink,
    onSparkle: openMenu,
    onDeleteCell: () => {
      debouncer.cancel();
      onRemove();
    },
    onMergeIntoPrevious: () => {
      if (isFirst) return false;
      debouncer.cancel();
      onMergeIntoPrevious();
      return true;
    },
    getNodeLabels: () => nodeLabels,
  });

  editorRef.current = editor;

  /*
   * Changes that arrived from somewhere else — the detail panel rewriting a
   * concept's section, an accepted proposal — reach the store but not this
   * editor: CodeMirror is seeded from `cell.markdown` once and owns its
   * document thereafter. Without this, editing a description on the right left
   * the Editor showing the old prose until the cell was remounted.
   *
   * Guarded on both sides. A pending debounce means the author's own keystrokes
   * are still in flight and the store is simply behind, so overwriting would
   * delete what they are typing; and a document already equal to the store's
   * needs no dispatch, which is the common case on every snapshot refresh.
   */
  useEffect(() => {
    if (debouncer.isPending()) return;
    const current = editorRef.current?.getDocument();
    if (current === null || current === undefined || current === cell.markdown) return;
    editorRef.current?.setDocument(cell.markdown);
  }, [cell.markdown, debouncer]);

  // Flush rather than cancel: an unmount must not eat the last 300ms of typing.
  // Deliberate removals cancel first, so there is nothing queued to flush.
  useEffect(() => () => debouncer.flush(), [debouncer]);

  useEffect(() => {
    if (focusToken === null) return;
    editorRef.current?.focus(focusPosition);
    onFocusHandled();
  }, [focusPosition, focusToken, onFocusHandled]);

  // Fires once per import: onImportStarted clears the parent's pending slot,
  // so a re-render cannot start a second CLI process for the same document.
  const importRef = useRef(run.start);
  importRef.current = run.start;
  useEffect(() => {
    if (!llmAvailable || !pendingImport) return;
    onImportStarted?.();
    void importRef.current('distill-import', '', '', pendingImport);
  }, [llmAvailable, pendingImport, onImportStarted]);

  const chooseAction = useCallback(
    (action: CellAction): void => {
      // Read the live document BEFORE flushing: the flush only starts an async
      // upsert, so `cell.markdown` is still the pre-edit text on this render.
      const liveMarkdown = editorRef.current?.getDocument() ?? undefined;
      debouncer.flush();
      void run.start(action, capturedSelection, liveMarkdown);
    },
    [capturedSelection, debouncer, run],
  );

  const acceptRun = useCallback((): void => {
    void run.accept().then((markdown) => {
      if (markdown !== null) editorRef.current?.setDocument(markdown);
    });
  }, [run]);

  // Derived from the cell's own markdown, so the collapsed row is named the
  // same thing as the node this cell put on the canvas.
  const cellTitle = useMemo(() => cellTitleOf(cell.markdown), [cell.markdown]);
  const cellSummary = useMemo(() => cellSummaryOf(cell.markdown), [cell.markdown]);
  const hasNode = cellTitle !== UNTITLED_CELL;

  // First node wins for a cell that mentions several — the same one the
  // gutter, hover and selection already treat as this cell's node.
  const primaryNode = cellNodes[0] ?? null;
  const accentColor = primaryNode ? CATEGORY_COLORS[primaryNode.kind] : null;
  const relationshipCount = useMemo(() => {
    const ids = new Set(cellNodes.map((node) => node.id));
    return (graph?.edges ?? []).filter(
      (edge) => ids.has(edge.source) || ids.has(edge.target),
    ).length;
  }, [cellNodes, graph?.edges]);
  const relationshipLabel = `${relationshipCount} relationship${relationshipCount === 1 ? '' : 's'}`;

  const isActive = selectedCellId === cell.id;
  const isRelated = hoveredNodeId !== null && cellNodes.some((node) => node.id === hoveredNodeId);
  const rootClassName = [
    styles.root,
    !llmAvailable ? styles.noLlm : '',
    isActive ? styles.active : '',
    isRelated ? styles.related : '',
    isCollapsed ? styles.collapsed : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={rootClassName}
      /*
       * The cell wears its node's colour, from the same function the canvas
       * draws with — so the row and the dot on the map are recognisably the
       * same thing rather than two unrelated palettes. A cell no node owns
       * gets nothing and falls back to the neutral rule.
       */
      style={accentColor ? ({ '--bd-cell-accent': accentColor } as CSSProperties) : undefined}
      data-cell-id={cell.id}
      onMouseEnter={() => {
        setHoveredCellId(cell.id);
        setHoveredNodeId(primaryNodeId);
      }}
      onMouseLeave={() => {
        setHoveredCellId(null);
        setHoveredNodeId(null);
      }}
    >
      {llmAvailable ? (
        <div className={styles.gutter}>
          <SparkleMenu
            isOpen={isMenuOpen}
            isBusy={isRunStreaming}
            hasSelection={capturedSelection.length > 0}
            onToggle={() => (isMenuOpen ? setIsMenuOpen(false) : openMenu())}
            onClose={() => setIsMenuOpen(false)}
            onChoose={chooseAction}
          />
        </div>
      ) : null}

      <div className={styles.body}>
        <div className={styles.bar}>
          <span
            className={styles.entityMark}
            aria-label={primaryNode ? primaryNode.kind : 'Unlinked cell'}
            title={primaryNode ? `${primaryNode.kind} · mapped` : 'Unlinked cell'}
          >
            {primaryNode ? CATEGORY_GLYPHS[primaryNode.kind] : '○'}
          </span>
          <button
            type="button"
            className={styles.disclosure}
            onClick={onToggleCollapsed}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `Expand ${cellTitle}` : `Collapse ${cellTitle}`}
          >
            <span className={styles.chevron} aria-hidden="true">
              {isCollapsed ? '▸' : '▾'}
            </span>
            <span className={styles.cellTitle}>{cellTitle}</span>
          </button>

          {isCollapsed ? <span className={styles.summary}>{cellSummary}</span> : null}

          <span className={primaryNode ? styles.mapping : styles.mappingUnlinked}>
            {primaryNode ? `Mapped · ${relationshipLabel}` : 'Unlinked'}
          </span>

          <div className={styles.actions}>
            <button
              type="button"
              className={isPinned ? `${styles.pin} ${styles.pinActive}` : styles.pin}
              onClick={onTogglePinned}
              aria-pressed={isPinned}
              title={isPinned ? 'Unpin this cell' : 'Pin this cell'}
              aria-label={isPinned ? `Unpin ${cellTitle}` : `Pin ${cellTitle}`}
            >
              {isPinned ? '◆' : '◇'}
            </button>
            <button
              type="button"
              className={styles.railButton}
              onClick={onAddBelow}
              title="Add a cell below"
              aria-label="Add a cell below"
            >
              +
            </button>
            <button
              type="button"
              className={styles.delete}
              onClick={() => setIsConfirmingDelete(true)}
              aria-label={`Delete ${cellTitle}`}
              title="Delete this cell"
            >
              ✕
            </button>
          </div>
        </div>

        {isConfirmingDelete ? (
          <div className={styles.confirm} role="alertdialog" aria-label="Confirm delete">
            <p className={styles.confirmText}>
              Delete <strong>{cellTitle}</strong>?
              {hasNode ? ' Its concept leaves the graph too.' : ''}
            </p>
            <div className={styles.confirmActions}>
              <button type="button" onClick={() => setIsConfirmingDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.confirmDelete}
                onClick={() => {
                  setIsConfirmingDelete(false);
                  onRemove();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.editor} ref={editor.hostRef} hidden={isCollapsed} />

        {run.active !== null ? (
          <StreamingOverlay
            run={run.active}
            onCancel={() => void run.cancelRun()}
            onAccept={acceptRun}
            onReject={run.reject}
          />
        ) : null}

        {saveError !== null ? (
          <p className={styles.error} role="alert">
            Could not save this cell — {saveError}
          </p>
        ) : null}

        {run.localError !== null ? (
          <p className={styles.error} role="alert">
            {run.localError}{' '}
            <button type="button" className={styles.dismiss} onClick={run.dismissError}>
              Dismiss
            </button>
          </p>
        ) : null}
      </div>

    </article>
  );
}
