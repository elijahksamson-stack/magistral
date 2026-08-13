/**
 * The per-cell ✦ button and its menu — the app's signature affordance.
 *
 * Nothing here runs on its own. A CLI process is spawned only when the author
 * clicks one of these five actions.
 */

import { useCallback, useEffect, useRef } from 'react';
import { MENU_CELL_ACTIONS, CELL_ACTION_LABELS, type CellAction } from '../../../shared/types/claude';
import styles from './SparkleMenu.module.css';

const ACTION_HINTS: Record<CellAction, string> = {
  enhance: 'Sharpen the prose, keep the claims',
  continue: 'Write the next paragraph in your voice',
  critique: 'Attack the reasoning, name the weakest link',
  distill: 'Compress to the load-bearing sentences',
  // Never shown in this menu — reached from the editor's Import control, since
  // it needs a document rather than the cell it writes into.
  'distill-import': 'Distil an imported document into this cell',
};

export interface SparkleMenuProps {
  isOpen: boolean;
  isBusy: boolean;
  /** Shown on the trigger when the author has text selected. */
  hasSelection: boolean;
  onToggle(): void;
  onClose(): void;
  onChoose(action: CellAction): void;
}

export default function SparkleMenu({
  isOpen,
  isBusy,
  hasSelection,
  onToggle,
  onClose,
  onChoose,
}: SparkleMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleChoose = useCallback(
    (action: CellAction) => (): void => {
      onChoose(action);
      onClose();
    },
    [onChoose, onClose],
  );

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={isBusy ? `${styles.trigger} ${styles.busy}` : styles.trigger}
        onClick={onToggle}
        disabled={isBusy}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={isBusy ? 'Claude is working' : 'Claude actions for this cell'}
        title={
          isBusy
            ? 'Claude is working on this cell'
            : hasSelection
              ? 'Act on the selection (⌘⏎)'
              : 'Act on this cell (⌘⏎)'
        }
      >
        <span className={styles.glyph} aria-hidden="true">
          ✦
        </span>
      </button>

      {isOpen ? (
        <div className={styles.menu} role="menu">
          {hasSelection ? (
            <p className={styles.scope}>Acting on your selection</p>
          ) : null}
          {MENU_CELL_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={handleChoose(action)}
            >
              <span className={styles.itemLabel}>{CELL_ACTION_LABELS[action]}</span>
              <span className={styles.itemHint}>{ACTION_HINTS[action]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
