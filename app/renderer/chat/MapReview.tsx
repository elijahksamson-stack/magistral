/**
 * The review pane for a "Complete the map" proposal.
 *
 * Nothing the model proposes reaches the graph without passing through this.
 * The author sees every change, unchecks what they disagree with, and clicks
 * once. That is the whole safety story at the UI level — the schema guarantees
 * the model cannot ask to delete anything, and this guarantees a person saw
 * everything it did ask for.
 *
 * Refusals are shown too. A proposal that arrived with nine changes and shows
 * six needs to say where the other three went, or the pane looks like it lost
 * them.
 */

import { useMemo, useState, type JSX } from 'react';

import type { ValidatedCompletion } from '../../../shared/types/completion';
import styles from './MapReview.module.css';
import {
  allKeys,
  countByKind,
  listProposals,
  toggleSelection,
  type ProposalItem,
} from './proposals';

export interface MapReviewProps {
  completion: ValidatedCompletion;
  /** Hides stale validator artifacts that attempted to promote existing children. */
  existingSubnodeLabels?: ReadonlySet<string>;
  /** True while the changes are being written to the graph. */
  isApplying: boolean;
  onApply: (selected: ReadonlySet<string>) => void;
  onDismiss: () => void;
}

function summarize(counts: ReturnType<typeof countByKind>): string {
  const parts: string[] = [];
  if (counts.nodes > 0) parts.push(`${counts.nodes} concept${counts.nodes === 1 ? '' : 's'}`);
  if (counts.edges > 0) {
    parts.push(`${counts.edges} relationship${counts.edges === 1 ? '' : 's'}`);
  }
  if (counts.changes > 0) parts.push(`${counts.changes} retyped`);
  if (counts.groupings > 0) parts.push(`${counts.groupings} grouped`);
  return parts.join(' · ');
}

function ProposalRow({
  item,
  isSelected,
  onToggle,
}: {
  item: ProposalItem;
  isSelected: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <li className={isSelected ? styles.row : styles.rowMuted}>
      <label className={styles.rowLabel}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={isSelected}
          onChange={onToggle}
          // The visible text is the change itself, which is what a screen
          // reader should announce — not "checkbox 4 of 9".
          aria-label={item.title}
        />
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{item.title}</span>
          <span className={styles.rowDetail}>{item.detail}</span>
          {item.note ? <span className={styles.rowNote}>{item.note}</span> : null}
        </span>
      </label>
    </li>
  );
}

export default function MapReview({
  completion,
  existingSubnodeLabels,
  isApplying,
  onApply,
  onDismiss,
}: MapReviewProps): JSX.Element | null {
  const items = useMemo(
    () => listProposals(completion.accepted, existingSubnodeLabels),
    [completion, existingSubnodeLabels],
  );

  // Everything starts checked. The author asked for this; making them opt in
  // to each change would turn an accepted proposal into a chore.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => allKeys(items));

  const counts = countByKind(items, selected);
  const total = items.filter((item) => selected.has(item.key)).length;
  const { rejected } = completion;

  if (items.length === 0) {
    return (
      <section className={styles.panel} aria-label="Proposed changes">
        <p className={styles.empty}>
          {rejected.length > 0
            ? 'Nothing in that proposal could be applied.'
            : 'The map looks complete — nothing to add.'}
        </p>
        {completion.accepted.rationale ? (
          <p className={styles.rationale}>{completion.accepted.rationale}</p>
        ) : null}
        {rejected.length > 0 ? (
          <ul className={styles.rejected}>
            {rejected.map((entry) => (
              <li key={`${entry.kind}:${entry.subject}`}>
                <span className={styles.rejectedSubject}>{entry.subject}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" className={styles.secondary} onClick={onDismiss}>
          Close
        </button>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label="Proposed changes">
      <header className={styles.header}>
        <h3 className={styles.title}>Proposed additions</h3>
        <p className={styles.summary}>{summarize(counts) || 'nothing selected'}</p>
      </header>

      {completion.accepted.rationale ? (
        <p className={styles.rationale}>{completion.accepted.rationale}</p>
      ) : null}

      <div className={styles.selectAll}>
        <button
          type="button"
          className={styles.link}
          onClick={() => setSelected(allKeys(items))}
          disabled={total === items.length}
        >
          Select all
        </button>
        <button
          type="button"
          className={styles.link}
          onClick={() => setSelected(new Set())}
          disabled={total === 0}
        >
          Select none
        </button>
      </div>

      <ul className={styles.list}>
        {items.map((item) => (
          <ProposalRow
            key={item.key}
            item={item}
            isSelected={selected.has(item.key)}
            onToggle={() => setSelected((current) => toggleSelection(items, current, item.key))}
          />
        ))}
      </ul>

      {rejected.length > 0 ? (
        <details className={styles.rejectedBlock}>
          <summary>
            {rejected.length} change{rejected.length === 1 ? '' : 's'} could not be proposed
          </summary>
          <ul className={styles.rejected}>
            {rejected.map((entry) => (
              <li key={`${entry.kind}:${entry.subject}`}>
                <span className={styles.rejectedSubject}>{entry.subject}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <footer className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={() => onApply(selected)}
          disabled={total === 0 || isApplying}
        >
          {isApplying ? 'Adding…' : `Add ${total} to the map`}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={onDismiss}
          disabled={isApplying}
        >
          Discard
        </button>
      </footer>
    </section>
  );
}
