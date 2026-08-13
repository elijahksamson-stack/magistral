/**
 * Relation picker shown when a drawn edge lands on a node.
 *
 * Drag-to-connect states THAT two concepts relate; this states HOW. Asking
 * once, at the moment of the drop, is what keeps the graph typed — an
 * untyped web of `relates_to` cannot express "EUV constrains semiconductors",
 * which is the entire reason to build a graph rather than a list.
 */

import { useEffect, useRef, useState } from 'react';

import {
  MAX_EDGE_NOTE_LENGTH,
  RELATION_KINDS,
  type RelationKind,
} from '../../../shared/types/graph';
import type { ConnectionEndpointKind } from './connectionTypes';
import styles from './RelationPicker.module.css';

/** Reads as a sentence between the two labels, so the choice is unambiguous. */
const RELATION_PHRASING: Record<RelationKind, string> = {
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

export interface RelationPickerProps {
  sourceLabel: string;
  targetLabel: string;
  sourceKind: ConnectionEndpointKind;
  targetKind: ConnectionEndpointKind;
  /** View-only subnodes become addressable but remain nested when saved. */
  promotesSource?: boolean;
  promotesTarget?: boolean;
  /** Where to place the popup, in pane-local pixels. */
  x: number;
  y: number;
  onPick: (relation: RelationKind, note: string) => void;
  onCancel: () => void;
}

export default function RelationPicker({
  sourceLabel,
  targetLabel,
  sourceKind,
  targetKind,
  promotesSource = false,
  promotesTarget = false,
  x,
  y,
  onPick,
  onCancel,
}: RelationPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('');

  // Focus the first option so the whole picker is keyboard-drivable, and so
  // Escape has somewhere to fire from.
  useEffect(() => {
    rootRef.current?.querySelector('button')?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <>
      {/* Click-away target. Sits under the popup, over everything else. */}
      <div className={styles.scrim} onPointerDown={onCancel} />
      <div
        ref={rootRef}
        className={styles.picker}
        style={{ left: x, top: y }}
        role="dialog"
        aria-label="Choose a relation"
      >
        <p className={styles.summary}>
          <span className={styles.endpoint}>
            <span className={styles.node}>{sourceLabel}</span>
            <span className={styles.kind}>{sourceKind}</span>
          </span>
          <span className={styles.verb}>…</span>
          <span className={styles.endpoint}>
            <span className={styles.node}>{targetLabel}</span>
            <span className={styles.kind}>{targetKind}</span>
          </span>
        </p>
        {promotesSource || promotesTarget ? (
          <p className={styles.promotion}>
            Saving connects {promotesSource && promotesTarget ? 'these existing subnodes' : 'this existing subnode'}
            {' '}without moving {promotesSource && promotesTarget ? 'them' : 'it'} out from under the parent.
          </p>
        ) : null}
        <label className={styles.noteLabel} htmlFor="bd-new-edge-note">
          How do they cross-connect?
        </label>
        <textarea
          id="bd-new-edge-note"
          className={styles.note}
          value={note}
          rows={3}
          maxLength={MAX_EDGE_NOTE_LENGTH}
          placeholder="Name the mechanism, condition, or shared constraint…"
          onChange={(event) => setNote(event.target.value)}
        />
        <ul className={styles.options}>
          {RELATION_KINDS.map((relation) => (
            <li key={relation}>
              <button type="button" className={styles.option} onClick={() => onPick(relation, note)}>
                <span className={styles.optionVerb}>{RELATION_PHRASING[relation]}</span>
                <span className={styles.optionKind}>{relation}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
