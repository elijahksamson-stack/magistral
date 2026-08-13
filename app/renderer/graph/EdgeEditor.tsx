/**
 * Editing a relationship after it has been drawn.
 *
 * Drag-to-connect asks for the relation once, at the drop. Getting it wrong —
 * or drawing it backwards — used to mean deleting the edge and redrawing it,
 * which is a poor answer when the whole point of the graph is that the
 * relationships are the argument.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MAX_EDGE_NOTE_LENGTH,
  RELATION_KINDS,
  type GraphEdge,
  type RelationKind,
} from '../../../shared/types/graph';
import { RELATION_PHRASING } from '../shared/relations';
import styles from './EdgeEditor.module.css';

export interface EdgeEditorProps {
  edge: GraphEdge;
  sourceLabel: string;
  targetLabel: string;
  /** Pane-local pixels. */
  x: number;
  y: number;
  onChangeRelation: (relation: RelationKind) => void;
  onChangeNote: (note: string) => void;
  onFlip: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function EdgeEditor({
  edge,
  sourceLabel,
  targetLabel,
  x,
  y,
  onChangeRelation,
  onChangeNote,
  onFlip,
  onDelete,
  onClose,
}: EdgeEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState(edge.note ?? '');

  // Reset when the editor is pointed at a different relationship — replacing
  // an edge mints a new id, so this fires on every flip and relation change.
  useEffect(() => {
    setNote(edge.note ?? '');
  }, [edge.id, edge.note]);

  const isNoteDirty = note !== (edge.note ?? '');

  /**
   * Committed on blur and on close rather than on every keystroke: each write
   * marks the vault dirty and refreshes the snapshot, and doing that per
   * character would fight the author's typing.
   */
  const commitNote = useCallback((): void => {
    if (note !== (edge.note ?? '')) onChangeNote(note);
  }, [note, edge.note, onChangeNote]);

  const closeAndCommit = useCallback((): void => {
    commitNote();
    onClose();
  }, [commitNote, onClose]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape must not discard what was just typed.
        closeAndCommit();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeAndCommit]);

  return (
    <>
      <div className={styles.scrim} onPointerDown={closeAndCommit} />
      <div
        ref={rootRef}
        className={styles.editor}
        style={{ left: x, top: y }}
        role="dialog"
        aria-label="Edit relationship"
      >
        <p className={styles.sentence}>
          <span className={styles.node}>{sourceLabel}</span>
          <span className={styles.verb}>{RELATION_PHRASING[edge.relation]}</span>
          <span className={styles.node}>{targetLabel}</span>
        </p>

        <label className={styles.noteLabel} htmlFor="bd-edge-note">
          What is this relationship?
        </label>
        <textarea
          id="bd-edge-note"
          className={styles.note}
          value={note}
          maxLength={MAX_EDGE_NOTE_LENGTH}
          rows={4}
          placeholder="How does one affect the other? Under what conditions? How sure are you?"
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => commitNote()}
        />
        <p className={styles.counter}>
          {note.length} / {MAX_EDGE_NOTE_LENGTH}
          {isNoteDirty ? <span className={styles.unsaved}> · unsaved</span> : null}
        </p>

        <button type="button" className={styles.flip} onClick={onFlip}>
          <span aria-hidden="true">⇄</span> Reverse direction
        </button>

        <p className={styles.heading}>Relationship</p>
        <ul className={styles.options}>
          {RELATION_KINDS.map((relation) => (
            <li key={relation}>
              <button
                type="button"
                className={relation === edge.relation ? styles.optionActive : styles.option}
                onClick={() => onChangeRelation(relation)}
              >
                <span className={styles.check} aria-hidden="true">
                  {relation === edge.relation ? '✓' : ''}
                </span>
                <span className={styles.optionVerb}>{RELATION_PHRASING[relation]}</span>
              </button>
            </li>
          ))}
        </ul>

        <button type="button" className={styles.delete} onClick={onDelete}>
          Delete this connection
        </button>
      </div>
    </>
  );
}
