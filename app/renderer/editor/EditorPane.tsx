/**
 * The left pane: an ordered list of cells and the focus traffic between them.
 *
 * State lives in the shared graph store; this component owns only the question
 * of which cell should currently hold the caret.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

/** The DOM document, aliased because `document` names the imported file below. */
const document_ = globalThis.document;

import type { CliProviderSelection, SourceDocument } from '../../../shared/types/claude';
import { invoke } from '../shared/api';
import { isStringArray, readPersisted, writePersisted } from '../shared/persisted';
import type { Cell as CellModel } from '../../../shared/types/graph';
import { useGraphStore } from '../shared/store';
import Cell from './Cell';
import styles from './EditorPane.module.css';
import { getErrorMessage } from './errors';
import tokens from './tokens.module.css';
import type { FocusPosition } from './useCellEditor';
import PaneHeading from '../shared/PaneHeading';
import { formatGraphStatus } from '../shared/entityPresentation';

/** A document waiting for its cell to pick it up and start the run. */
const COLLAPSED_SCOPE = 'editor.collapsedCells';
const PINNED_SCOPE = 'editor.pinnedCells';
const EMPTY_IDS: ReadonlySet<string> = new Set();
type CellView = 'all' | 'pinned' | 'recent' | 'connected' | 'unlinked' | 'grouped';

/** Bucket for cells whose concepts belong to no group. Not a real group id. */
const UNGROUPED = ' ungrouped';

interface PendingImport {
  cellId: string;
  document: SourceDocument;
}

interface FocusRequest {
  cellId: string;
  position: FocusPosition;
  /** Bumped on every request so re-focusing the same cell still fires. */
  token: number;
}

/**
 * Where `[[label]]` begins in a cell, or null when the cell does not name it.
 *
 * Matched case-insensitively and tolerating padding inside the brackets, the
 * same way the core's link scanner does, so a concept written `[[ Natural Gas ]]`
 * is still found by the label the graph carries.
 */
function wikiLinkOffsetIn(markdown: string, label: string): number | null {
  const escaped = label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`\\[\\[\\s*${escaped}\\s*(\\|[^\\]]*)?\\]\\]`, 'i').exec(markdown);
  return found ? found.index : null;
}

function byOrder(a: CellModel, b: CellModel): number {
  return a.order - b.order;
}

function providerLabel(selection: CliProviderSelection | null | undefined): string {
  if (selection === 'codex') return 'ChatGPT';
  if (selection === 'claude') return 'Claude';
  if (selection === 'auto') return 'Auto';
  return 'the detected local CLI';
}

export interface EditorPaneProps {
  /** Hides this pane so the graph fills the window. Absent = not collapsible. */
  onCollapse?: () => void;
  providerSelection?: CliProviderSelection | null;
  llmAvailable?: boolean;
}

export default function EditorPane({
  onCollapse,
  providerSelection,
  llmAvailable = true,
}: EditorPaneProps = {}) {
  const {
    graph,
    loading,
    error,
    addCell,
    removeCell,
    upsertCell,
    selectedCellId,
    selectedCellAnchor,
    setSelectedCellAnchor,
  } = useGraphStore();
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<CellView>('all');
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const searchRef = useRef<HTMLInputElement>(null);

  /**
   * Which cells are folded, remembered per vault.
   *
   * Kept as a set of ids rather than a flag on the cell: folding is how the
   * author is reading the document right now, not something about the
   * document, so it has no business in the vault's schema.
   */
  const vaultId = graph?.id ?? null;
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  useEffect(() => {
    const stored = readPersisted(COLLAPSED_SCOPE, vaultId, isStringArray, []);
    setCollapsedIds(new Set(stored));
    setPinnedIds(new Set(readPersisted(PINNED_SCOPE, vaultId, isStringArray, [])));
  }, [vaultId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleCollapsed = useCallback(
    (cellId: string): void => {
      setCollapsedIds((current) => {
        const next = new Set(current);
        if (!next.delete(cellId)) next.add(cellId);
        writePersisted(COLLAPSED_SCOPE, vaultId, [...next]);
        return next;
      });
    },
    [vaultId],
  );

  const cells = useMemo(() => [...(graph?.cells ?? [])].sort(byOrder), [graph]);
  const connectedIds = useMemo(
    () => new Set((graph?.nodes ?? []).flatMap((node) => node.cellIds)),
    [graph],
  );
  const connectionCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph?.nodes ?? []) {
      for (const cellId of node.cellIds) counts.set(cellId, (counts.get(cellId) ?? 0) + node.degree);
    }
    return counts;
  }, [graph]);
  const visibleCells = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    let next = cells.filter((cell) => !needle || cell.markdown.toLocaleLowerCase().includes(needle));
    if (view === 'pinned') next = next.filter((cell) => pinnedIds.has(cell.id));
    if (view === 'connected') next = next.filter((cell) => connectedIds.has(cell.id));
    if (view === 'unlinked') next = next.filter((cell) => !connectedIds.has(cell.id));
    if (view === 'recent') next = [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (view === 'connected') {
      next = [...next].sort((a, b) => (connectionCount.get(b.id) ?? 0) - (connectionCount.get(a.id) ?? 0));
    }
    return next;
  }, [cells, connectedIds, connectionCount, pinnedIds, query, view]);

  /**
   * The same cells, bucketed by the groups their concepts sit in.
   *
   * A cell whose concepts belong to several groups is listed under each of
   * them. It genuinely does belong to all of them, and picking one arbitrarily
   * would misreport the map — the point of this view is to see membership.
   * Null unless the grouped view is showing, so nothing is computed otherwise.
   */
  const groupSections = useMemo(() => {
    if (view !== 'grouped') return null;
    const nodes = graph?.nodes ?? [];

    const labelOf = new Map<string, string>();
    for (const node of nodes) if (node.kind === 'group') labelOf.set(node.id, node.label);

    const buckets = new Map<string, CellModel[]>();
    const place = (key: string, cell: CellModel): void => {
      const list = buckets.get(key);
      if (list) list.push(cell);
      else buckets.set(key, [cell]);
    };

    for (const cell of visibleCells) {
      const groupIds = new Set<string>();
      for (const node of nodes) {
        if (node.kind === 'group' || !node.groupId) continue;
        if (node.cellIds.includes(cell.id)) groupIds.add(node.groupId);
      }
      if (groupIds.size === 0) place(UNGROUPED, cell);
      else for (const groupId of groupIds) place(groupId, cell);
    }

    return [...buckets.entries()]
      .map(([id, list]) => ({
        id,
        label: id === UNGROUPED ? 'Ungrouped' : (labelOf.get(id) ?? 'Unknown group'),
        cells: list,
      }))
      // Ungrouped last: it is the leftovers, not a peer of the real groups.
      .sort((a, b) => {
        if (a.id === UNGROUPED) return 1;
        if (b.id === UNGROUPED) return -1;
        return a.label.localeCompare(b.label);
      });
  }, [graph, view, visibleCells]);

  /**
   * One cell row. Extracted because the grouped view lists a cell under every
   * group it belongs to, so the same cell is emitted more than once and needs
   * a key that carries its section — `cell.id` alone would collide.
   */
  const renderCell = (cell: CellModel, key: string): JSX.Element => (
    <Cell
      key={key}
      cell={cell}
      isFirst={cells[0]?.id === cell.id}
      focusToken={focusRequest?.cellId === cell.id ? focusRequest.token : null}
      focusPosition={focusRequest?.position ?? 'end'}
      onFocusHandled={clearFocusRequest}
      onAddBelow={() => void appendCell(cell.id)}
      onRemove={() => void deleteCell(cell.id)}
      onMergeIntoPrevious={() => void mergeIntoPrevious(cell.id)}
      pendingImport={pendingImport?.cellId === cell.id ? pendingImport.document : null}
      onImportStarted={clearPendingImport}
      isCollapsed={collapsedIds.has(cell.id)}
      onToggleCollapsed={() => toggleCollapsed(cell.id)}
      isPinned={pinnedIds.has(cell.id)}
      onTogglePinned={() => togglePinned(cell.id)}
      llmAvailable={llmAvailable}
    />
  );

  const togglePinned = useCallback((cellId: string): void => {
    setPinnedIds((current) => {
      const next = new Set(current);
      if (!next.delete(cellId)) next.add(cellId);
      writePersisted(PINNED_SCOPE, vaultId, [...next]);
      return next;
    });
  }, [vaultId]);

  /*
   * Arriving from the map. Everything except the target folds away, so the
   * concept that was clicked is the only prose on screen rather than a row the
   * author still has to hunt for among forty open cells. Reading one cell is
   * the whole point of following a concept into the Editor.
   */
  useEffect(() => {
    if (!selectedCellId) return;
    setCollapsedIds((current) => {
      const next = new Set(cells.map((cell) => cell.id));
      next.delete(selectedCellId);
      const unchanged = next.size === current.size && [...next].every((id) => current.has(id));
      if (unchanged) return current;
      writePersisted(COLLAPSED_SCOPE, vaultId, [...next]);
      return next;
    });
    /*
     * Centring the CELL is right when the whole cell is the destination, and
     * wrong when a concept inside it is. This runs a frame later than the
     * line-level reveal, so it used to win and drag the heading back to
     * wherever centring the cell put it — usually the bottom edge, with the
     * section the author came to read left below the fold. When a concept is
     * being revealed, that reveal owns the scroll position.
     */
    const willRevealConcept = selectedCellAnchor !== null;
    requestAnimationFrame(() => {
      if (willRevealConcept) return;
      document_.querySelector(`[data-cell-id="${selectedCellId}"]`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    // `cells` is read but deliberately not a dependency: it changes on every
    // keystroke, and re-running this would re-fold the cell being typed into.
    // Only a new selection should refold the Editor.
  }, [selectedCellId, vaultId]);


  const areAllCollapsed = cells.length > 0 && cells.every((cell) => collapsedIds.has(cell.id));

  /** Folding is sticky, so a way to undo it in bulk stops being optional. */
  const toggleAllCollapsed = useCallback((): void => {
    const next = areAllCollapsed ? new Set<string>() : new Set(cells.map((cell) => cell.id));
    setCollapsedIds(next);
    writePersisted(COLLAPSED_SCOPE, vaultId, [...next]);
  }, [areAllCollapsed, cells, vaultId]);


  /**
   * Pick a document, make a cell for it, and hand the cell the text to distil.
   *
   * The cell starts the run itself, so the import lands in the same streaming
   * preview with the same Accept/Reject gate as every other Claude action.
   */
  const importDocument = useCallback(async (): Promise<void> => {
    setActionError(null);
    setIsPicking(true);
    try {
      const { document } = await invoke('import:document', undefined);
      // A dismissed file dialog is not an error.
      if (!document) return;

      const cellId = await addCell();
      setPendingImport({ cellId, document });
      setImportNotice(`Distilling ${document.name}…`);

      // Scroll the new cell into view. A distilled cell runs to hundreds of
      // lines, so an import appended to the end of a long page lands well
      // below the fold — indistinguishable from nothing having happened, which
      // is what "you can only import one document" turned out to describe.
      requestAnimationFrame(() => {
        const element = document_.querySelector(`[data-cell-id="${cellId}"]`);
        // Guarded: this runs inside rAF, where a throw is unhandled and
        // invisible, and scrollIntoView is missing in some embedders.
        if (typeof element?.scrollIntoView === 'function') {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    } catch (cause: unknown) {
      setActionError(getErrorMessage(cause));
    } finally {
      setIsPicking(false);
    }
  }, [addCell]);

  const clearPendingImport = useCallback((): void => setPendingImport(null), []);

  const requestFocus = useCallback((cellId: string, position: FocusPosition): void => {
    setFocusRequest((previous) => ({
      cellId,
      position,
      token: (previous?.token ?? 0) + 1,
    }));
  }, []);

  const clearFocusRequest = useCallback((): void => setFocusRequest(null), []);

  /*
   * Land on the concept, not merely on the cell containing it. A long imported
   * cell opens at the top, so following "Weather, Policy, and Geopolitics" in
   * from the map would otherwise leave the author reading whatever happens to
   * be first. The caret goes to the line that names it.
   *
   * Declared after requestFocus deliberately — referencing it from an effect
   * above its own `const` would be a temporal-dead-zone error at render.
   */
  useEffect(() => {
    if (!selectedCellId || !selectedCellAnchor) return;
    const markdown = cells.find((cell) => cell.id === selectedCellId)?.markdown;
    if (markdown === undefined) return;

    // Consumed either way: a label the cell no longer names must not sit there
    // waiting to hijack the next cell the author opens.
    setSelectedCellAnchor(null);
    const offset = wikiLinkOffsetIn(markdown, selectedCellAnchor);
    if (offset !== null) requestFocus(selectedCellId, offset);
    // `cells` is read but omitted from the deps for the reason given above.
  }, [selectedCellAnchor, selectedCellId, requestFocus, setSelectedCellAnchor]);

  const appendCell = useCallback(
    async (afterCellId?: string): Promise<void> => {
      try {
        const newCellId = await addCell(afterCellId);
        requestFocus(newCellId, 'start');
        setActionError(null);
      } catch (caught: unknown) {
        setActionError(getErrorMessage(caught));
      }
    },
    [addCell, requestFocus],
  );

  const deleteCell = useCallback(
    async (cellId: string): Promise<void> => {
      const index = cells.findIndex((cell) => cell.id === cellId);
      const previous = index > 0 ? cells[index - 1] : undefined;

      try {
        await removeCell(cellId);
        if (previous) requestFocus(previous.id, 'end');
        setActionError(null);
      } catch (caught: unknown) {
        setActionError(getErrorMessage(caught));
      }
    },
    [cells, removeCell, requestFocus],
  );

  /**
   * Backspace at the start of an empty cell. The cell holds no text, so the
   * merge is a removal plus a caret handoff to the end of the cell above.
   */
  const mergeIntoPrevious = useCallback(
    async (cellId: string): Promise<void> => {
      const index = cells.findIndex((cell) => cell.id === cellId);
      if (index <= 0) return;

      const previous = cells[index - 1];
      const current = cells[index];
      if (!previous || !current) return;

      try {
        if (current.markdown.trim().length > 0) {
          await upsertCell(previous.id, `${previous.markdown}${current.markdown}`);
        }
        await removeCell(cellId);
        requestFocus(previous.id, 'end');
        setActionError(null);
      } catch (caught: unknown) {
        setActionError(getErrorMessage(caught));
      }
    },
    [cells, removeCell, requestFocus, upsertCell],
  );

  if (loading) {
    return (
      <section className={`${tokens.tokens} ${styles.pane}`} aria-busy="true">
        <p className={styles.notice}>Opening vault…</p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section className={`${tokens.tokens} ${styles.pane}`}>
        <p className={styles.error} role="alert">
          {error}
        </p>
      </section>
    );
  }

  return (
    <section className={`${tokens.tokens} ${styles.pane}`} aria-label="Editor">
      <header className={styles.header}>
        <PaneHeading
          title={graph?.name ?? 'Untitled'}
          metrics={graph
            ? `${visibleCells.length === cells.length ? '' : `${visibleCells.length} visible · `}${formatGraphStatus(graph)}`
            : ''}
        />
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.foldAll}
            onClick={toggleAllCollapsed}
            title={areAllCollapsed ? 'Expand every cell' : 'Collapse every cell'}
          >
            {areAllCollapsed ? 'Expand all' : 'Collapse all'}
          </button>

          {onCollapse ? (
            <button
              type="button"
              className={styles.collapsePane}
              onClick={onCollapse}
              title="Collapse the editor and give the graph the whole window"
              aria-label="Collapse the editor"
            >
              ‹
            </button>
          ) : null}
        </div>
      </header>

      {llmAvailable ? (
        <p className={styles.claudeHint}>
          <span className={styles.claudeHintMark} aria-hidden="true">✦</span>
          <span className={styles.claudeHintText}>
            Next to any cell — enhance, continue, critique, or distill. Answering with{' '}
            <strong>{providerLabel(providerSelection)}</strong> through its subscription.
          </span>
        </p>
      ) : null}

      <div className={styles.navigator}>
        <label className={styles.search}>
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            value={query}
            placeholder="Find cells"
            aria-label="Find cells"
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘F</kbd>
        </label>
        <div className={styles.views} role="group" aria-label="Cell view">
          {(['all', 'pinned', 'recent', 'connected', 'unlinked', 'grouped'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
            >
              {option === 'connected'
                ? 'Most connected'
                : option === 'grouped'
                  ? 'By group'
                  : option[0]!.toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {importNotice !== null ? (
        <p className={styles.importNotice}>
          {importNotice}
          <button type="button" onClick={() => setImportNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </p>
      ) : null}

      {actionError !== null ? (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      ) : null}

      <div className={styles.cells}>
        {cells.length === 0 ? (
          <div className={styles.emptyEditor}>
            <p className={styles.emptyKicker}>01 / BEGIN ANYWHERE</p>
            <h2>Start with a thought.</h2>
            <p>
              Write in cells, then wrap a concept in
              <code className={styles.code}>[[brackets]]</code> to give it a place on the map.
            </p>
          </div>
        ) : null}

        {cells.length > 0 && visibleCells.length === 0 ? (
          <div className={styles.noResults}>
            <p>No cells match this view.</p>
            <button type="button" onClick={() => { setQuery(''); setView('all'); }}>Show all cells</button>
          </div>
        ) : null}

        {groupSections
          ? groupSections.map((section) => (
              <section key={section.id} className={styles.groupSection}>
                <h2 className={styles.groupHeading}>
                  {section.label}
                  <span>{section.cells.length}</span>
                </h2>
                {section.cells.map((cell) => renderCell(cell, `${section.id}:${cell.id}`))}
              </section>
            ))
          : visibleCells.map((cell) => renderCell(cell, cell.id))}
      </div>

      <footer className={styles.footer}>
        <button type="button" className={styles.addCell} onClick={() => void appendCell()}>
          <span aria-hidden="true">+</span> Add cell
        </button>

        {llmAvailable ? (
          <button
            type="button"
            className={styles.importCell}
            onClick={() => void importDocument()}
            disabled={isPicking}
            title="Read a .docx, .md or .txt and distil it into a new cell"
          >
            <span aria-hidden="true">⤓</span>{' '}
            {isPicking ? 'Choosing…' : 'Import & distil a document'}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
