/**
 * The panel that opens when a concept is clicked.
 *
 * One cell produces one node, and every [[link]] after the first is recorded
 * on that node as a sub-concept. Those sub-concepts have nowhere else to
 * surface — they are deliberately not nodes — so this panel is what makes them
 * reachable at all.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import type { GraphEdge, GraphNode, SubConcept } from '../../../shared/types/graph';
import styles from './NodeDetail.module.css';
import type { UnlinkedMention } from './unlinkedMentions';
import DescriptionEditor from './DescriptionEditor';
import { CATEGORY_COLORS, CATEGORY_GLYPHS } from '../shared/entityPresentation';

const RELATION_PHRASING: Record<string, string> = {
  relates_to: 'relates to',
  causes: 'causes',
  part_of: 'is part of',
  contradicts: 'contradicts',
  supports: 'supports',
  depends_on: 'depends on',
  instance_of: 'is an instance of',
  mentions: 'mentions',
  affects: 'affects',
  affected_by: 'is affected by',
};

export interface NodeDetailProps {
  node: GraphNode;
  edges: readonly GraphEdge[];
  /** Every node, so a group can list what is inside it. */
  allNodes: readonly GraphNode[];
  labelOf: (nodeId: string) => string;
  /** Jumps the editor to the cell that authored this concept. */
  onOpenCell: (cellId: string) => void;
  onSelectNode: (nodeId: string) => void;
  /** Opens one authored child in the minimal subnode-only detail state. */
  onSelectSubnode?: (subnode: SubConcept) => void;
  onRename: (label: string) => void;
  /** Removes the group. Its members survive, released rather than deleted. */
  onDelete: () => void;
  /**
   * Writes the `[[Label]]` cell for a concept that has none, putting it back on
   * the normal edit-and-delete route. Offered only when `cellIds` is empty.
   */
  onWriteCell: () => void;
  /**
   * The prose this concept owns. Supplied rather than read from `node.note`
   * because a concept written as a section heading owns the block beneath it,
   * which the core's line-scoped note does not capture.
   */
  description?: string;
  /** Persists the concept's description. Absent leaves it read-only. */
  onSaveDescription?: ((next: string) => void) | undefined;
  /** Asks the local model to write one from this concept and its neighbours. */
  onGenerateDescription?: (() => void) | undefined;
  isGenerating?: boolean;
  generateHint?: string;
  /**
   * Places this concept is named in prose without being linked.
   *
   * The map only knows what the author bracketed, so text written before a
   * concept existed keeps saying its name and the graph never learns about it.
   * Surfacing them here is what turns writing already done into edges.
   */
  unlinkedMentions?: readonly UnlinkedMention[];
  /**
   * Images this concept's cell embeds, already read as data URLs.
   *
   * Resolved by the pane rather than fetched here: the panel is a pure view,
   * and a component that reaches for IPC on mount is one that cannot be
   * rendered in a test without a bridge behind it.
   */
  images?: readonly { readonly fileName: string; readonly dataUrl: string }[];
  /** Brackets one mention, promoting it to a link. Absent leaves them read-only. */
  onLinkMention?: ((mention: UnlinkedMention) => void) | undefined;
  onClose: () => void;
}

export default function NodeDetail({
  node,
  edges,
  allNodes,
  labelOf,
  onOpenCell,
  onSelectNode,
  onSelectSubnode,
  onRename,
  onDelete,
  onWriteCell,
  description,
  onSaveDescription,
  onGenerateDescription,
  isGenerating,
  generateHint,
  unlinkedMentions = [],
  onLinkMention,
  images = [],
  onClose,
}: NodeDetailProps) {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const connections = edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => {
      const isOutgoing = edge.source === node.id;
      return {
        id: edge.id,
        otherId: isOutgoing ? edge.target : edge.source,
        phrase: RELATION_PHRASING[edge.relation] ?? edge.relation,
        isOutgoing,
        note: edge.note,
      };
    });

  const isGroupNode = node.kind === 'group';
  // Only groups are renameable: a concept's name IS its [[wikilink]], so
  // renaming one here would silently disagree with the cell that wrote it.
  const canRename = isGroupNode;

  const [isEditingName, setIsEditingName] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [draftName, setDraftName] = useState(node.label);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftName(node.label);
    setIsEditingName(false);
    setIsConfirmingDelete(false);
  }, [node.id, node.label]);

  useEffect(() => {
    if (!isEditingName) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [isEditingName]);

  const commitRename = useCallback((): void => {
    setIsEditingName(false);
    const trimmed = draftName.trim();
    // An empty name would leave the group unlabelled on the canvas; an
    // unchanged one is not worth a write and a snapshot refresh.
    if (trimmed.length === 0 || trimmed === node.label) {
      setDraftName(node.label);
      return;
    }
    onRename(trimmed);
  }, [draftName, node.label, onRename]);

  const subConcepts = node.subConcepts ?? [];
  const members = isGroupNode ? allNodes.filter((n) => n.groupId === node.id) : [];
  const groupOf = node.groupId ? allNodes.find((n) => n.id === node.groupId) : undefined;
  const sourceCellId = node.cellIds[0];

  /*
   * A concept no cell asserts. A group legitimately has none — it is authored
   * from this panel, not from text — but a concept without one is stranded:
   * the Editor lists cells, so it is not there, and delete below is a group's
   * control. Writing its cell is the only way back to the normal route.
   */
  const hasNoCell = !isGroupNode && node.cellIds.length === 0;

  return (
    <aside
      className={styles.panel}
      ref={rootRef}
      aria-label={`${node.label} details`}
      style={({ '--bd-entity-color': CATEGORY_COLORS[node.kind] } as CSSProperties)}
    >
      <header className={styles.head}>
        {isEditingName ? (
          <form
            className={styles.renameForm}
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <input
              ref={nameInputRef}
              className={styles.renameInput}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                // Escape abandons the edit; the name is unchanged, not blanked.
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraftName(node.label);
                  setIsEditingName(false);
                }
              }}
              aria-label="Group name"
            />
          </form>
        ) : (
          <h2 className={styles.title}>{node.label}</h2>
        )}

        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <p className={styles.kind}>
        <span aria-hidden="true">{CATEGORY_GLYPHS[node.kind]}</span> {node.kind}
      </p>

      {onSaveDescription ? (
        <DescriptionEditor
          value={description ?? node.note ?? ''}
          placeholder="No description yet. Click to write one."
          onSave={onSaveDescription}
          onGenerate={onGenerateDescription}
          isGenerating={isGenerating ?? false}
          generateHint={generateHint}
        />
      ) : node.note ? (
        <p className={styles.note}>{node.note}</p>
      ) : null}

      {isGroupNode ? (
        <section className={styles.section}>
          <h3 className={styles.heading}>
            {members.length} member{members.length === 1 ? '' : 's'}
          </h3>
          {members.length > 0 ? (
            <ul className={styles.connList}>
              {members.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    className={styles.conn}
                    onClick={() => onSelectNode(member.id)}
                  >
                    <span className={styles.other}>{member.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>Drag a concept inside the circle to add it here.</p>
          )}
        </section>
      ) : groupOf ? (
        <p className={styles.groupOf}>
          in <strong>{groupOf.label}</strong>
        </p>
      ) : null}

      {hasNoCell ? (
        <section className={styles.noCell}>
          <p className={styles.noCellText} role="status">
            No cell asserts this concept, so it cannot be edited or deleted. Writing one puts it
            in the Editor like anything you typed.
          </p>
          <button type="button" className={styles.writeCell} onClick={onWriteCell}>
            Write its cell
          </button>
        </section>
      ) : null}

      {isGroupNode || hasNoCell ? null : subConcepts.length > 0 ? (
        <section className={styles.section}>
          <h3 className={styles.heading}>
            {subConcepts.length} sub-concept{subConcepts.length === 1 ? '' : 's'}
          </h3>
          <ul className={styles.subList}>
            {subConcepts.map((sub) => (
              <li key={sub.label} className={styles.sub}>
                <button
                  type="button"
                  className={styles.subButton}
                  onClick={() => onSelectSubnode?.(sub)}
                  aria-label={`Open ${sub.label} subnode`}
                >
                  <span className={styles.subLabel}>{sub.label}</span>
                  {sub.note ? <span className={styles.subNote}>{sub.note}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        // Never shown for a group: a group has no cell, so telling its author
        // to add links to one is nonsense.
        <p className={styles.empty}>
          No sub-concepts. Add more <code>[[links]]</code> to this cell and they appear here.
        </p>
      )}

      {connections.length > 0 ? (
        <section className={styles.section}>
          <h3 className={styles.heading}>
            {connections.length} connection{connections.length === 1 ? '' : 's'}
          </h3>
          <ul className={styles.connList}>
            {connections.map((connection) => (
              <li key={connection.id}>
                <button
                  type="button"
                  className={styles.conn}
                  onClick={() => onSelectNode(connection.otherId)}
                >
                  <span className={styles.rel}>
                    {connection.isOutgoing ? `${connection.phrase} →` : `← ${connection.phrase}`}
                  </span>
                  <span className={styles.other}>{labelOf(connection.otherId)}</span>
                  {connection.note ? (
                    <span className={styles.connNote}>{connection.note}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {isGroupNode ? (
        <div className={styles.groupActions}>
          {isConfirmingDelete ? (
            <div className={styles.confirm} role="alertdialog" aria-label="Confirm delete">
              <p className={styles.confirmText}>
                Delete <strong>{node.label}</strong>?
                {members.length > 0
                  ? ` Its ${members.length} member${members.length === 1 ? '' : 's'} stay in the graph, ungrouped.`
                  : ''}
              </p>
              <div className={styles.confirmRow}>
                <button type="button" onClick={() => setIsConfirmingDelete(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.confirmDelete}
                  onClick={() => {
                    setIsConfirmingDelete(false);
                    onDelete();
                  }}
                >
                  Delete group
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className={styles.action}
                onClick={() => setIsEditingName(true)}
              >
                Rename group
              </button>
              <button
                type="button"
                className={styles.actionDanger}
                onClick={() => setIsConfirmingDelete(true)}
              >
                Delete group
              </button>
            </>
          )}
        </div>
      ) : null}

      {images.length > 0 ? (
        <section className={styles.section}>
          <h4 className={styles.heading}>Images · {images.length}</h4>
          <ul className={styles.figures}>
            {images.map((image) => (
              <li key={image.fileName}>
                {/* The filename is the caption: it is what the cell says, and
                    what the author types to refer to the figure again. */}
                <img src={image.dataUrl} alt={image.fileName} />
                <span>{image.fileName}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {unlinkedMentions.length > 0 ? (
        <section className={styles.section}>
          <h4 className={styles.heading}>Mentioned, not linked · {unlinkedMentions.length}</h4>
          <p className={styles.mentionHint}>
            Named here in plain text. Linking it draws the relationship.
          </p>
          <ul className={styles.mentions}>
            {unlinkedMentions.map((mention) => (
              <li key={`${mention.cellId}:${mention.index}`}>
                <span className={styles.mentionExcerpt}>{mention.excerpt}</span>
                <span className={styles.mentionActions}>
                  <button type="button" onClick={() => onOpenCell(mention.cellId)}>
                    Open
                  </button>
                  {onLinkMention ? (
                    <button
                      type="button"
                      className={styles.mentionLink}
                      onClick={() => onLinkMention(mention)}
                    >
                      Link it
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sourceCellId ? (
        <button type="button" className={styles.openCell} onClick={() => onOpenCell(sourceCellId)}>
          Open the cell that wrote this
        </button>
      ) : null}
    </aside>
  );
}
