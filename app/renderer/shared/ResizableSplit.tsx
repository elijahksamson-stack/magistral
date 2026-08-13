import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { isNumber, readPersisted, writePersisted } from './persisted';
import styles from './ResizableSplit.module.css';

const MIN_PERCENT = 24;
const MAX_PERCENT = 76;
const KEYBOARD_STEP = 3;

function clamp(value: number): number {
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, value));
}

export interface ResizableSplitProps {
  scope: string;
  vaultId: string | null;
  defaultPercent: number;
  left: ReactNode;
  right: ReactNode;
  leftLabel: string;
  rightLabel: string;
}

export default function ResizableSplit({
  scope,
  vaultId,
  defaultPercent,
  left,
  right,
  leftLabel,
  rightLabel,
}: ResizableSplitProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState(defaultPercent);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setPercent(clamp(readPersisted(scope, vaultId, isNumber, defaultPercent)));
  }, [defaultPercent, scope, vaultId]);

  const commit = useCallback(
    (next: number): void => {
      const clamped = clamp(next);
      setPercent(clamped);
      writePersisted(scope, vaultId, clamped);
    },
    [scope, vaultId],
  );

  const updateFromPointer = useCallback(
    (clientX: number): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      commit(((clientX - rect.left) / rect.width) * 100);
    },
    [commit],
  );

  return (
    <div
      ref={rootRef}
      className={dragging ? `${styles.split} ${styles.dragging}` : styles.split}
      style={{ '--bd-split-percent': `${percent}%` } as React.CSSProperties}
    >
      <div className={styles.pane} aria-label={leftLabel}>{left}</div>
      <div
        className={styles.handle}
        role="separator"
        aria-label={`Resize ${leftLabel} and ${rightLabel}`}
        aria-orientation="vertical"
        aria-valuemin={MIN_PERCENT}
        aria-valuemax={MAX_PERCENT}
        aria-valuenow={Math.round(percent)}
        tabIndex={0}
        onDoubleClick={() => commit(defaultPercent)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          commit(percent + (event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP));
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          updateFromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateFromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setDragging(false);
          updateFromPointer(event.clientX);
        }}
        onPointerCancel={() => setDragging(false)}
        title="Drag to resize · Double-click to reset"
      >
        <span aria-hidden="true" />
      </div>
      <div className={styles.pane} aria-label={rightLabel}>{right}</div>
    </div>
  );
}
