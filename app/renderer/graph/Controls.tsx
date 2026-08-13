/**
 * The control cluster in the corner of the graph pane: zoom, fit, re-run, and
 * a popover for the force parameters. Every parameter change is written
 * straight through to the C++ layout via `layout:configure` by the pane.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LayoutParams } from '../../../shared/types/graph';
import styles from './Controls.module.css';

interface ParamField {
  readonly key: keyof LayoutParams;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

const PARAM_FIELDS: readonly ParamField[] = [
  { key: 'repulsion', label: 'Repulsion', min: 500, max: 20_000, step: 100 },
  { key: 'attraction', label: 'Attraction', min: 0.005, max: 0.4, step: 0.005 },
  { key: 'gravity', label: 'Gravity', min: 0, max: 0.2, step: 0.005 },
  { key: 'linkDistance', label: 'Link distance', min: 20, max: 400, step: 5 },
];

const PERCENT = 100;

export interface ControlsProps {
  readonly zoom: number;
  readonly isSimulating: boolean;
  readonly params: LayoutParams;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  readonly onRerun: () => void;
  readonly onParamChange: (patch: Partial<LayoutParams>) => void;
}

interface IconButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly isActive?: boolean;
  readonly children: ReactNode;
}

function IconButton({ label, onClick, isActive, children }: IconButtonProps) {
  return (
    <button
      type="button"
      className={isActive ? `${styles.button} ${styles.buttonActive}` : styles.button}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={isActive}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        {children}
      </svg>
    </button>
  );
}

function formatParam(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(3);
}

export default function Controls(props: ControlsProps) {
  const { zoom, isSimulating, params, onZoomIn, onZoomOut, onFit, onRerun, onParamChange } = props;
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const togglePopover = useCallback(() => setIsPopoverOpen((open) => !open), []);

  useEffect(() => {
    if (!isPopoverOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = popoverRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setIsPopoverOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isPopoverOpen]);

  return (
    <div className={styles.cluster} ref={popoverRef}>
      {isPopoverOpen ? (
        <div className={styles.popover} role="group" aria-label="Layout parameters">
          {PARAM_FIELDS.map((field) => (
            <label key={field.key} className={styles.field}>
              <span className={styles.fieldLabel}>
                {field.label}
                <em className={styles.fieldValue}>{formatParam(params[field.key])}</em>
              </span>
              <input
                type="range"
                min={field.min}
                max={field.max}
                step={field.step}
                value={params[field.key]}
                onChange={(event) =>
                  onParamChange({ [field.key]: Number(event.target.value) } as Partial<LayoutParams>)
                }
              />
            </label>
          ))}
        </div>
      ) : null}

      <div className={styles.row}>
        <span className={styles.zoomLabel} title="Current zoom">
          {Math.round(zoom * PERCENT)}%
        </span>
        <IconButton label="Zoom out" onClick={onZoomOut}>
          <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </IconButton>
        <IconButton label="Zoom in" onClick={onZoomIn}>
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </IconButton>
        <IconButton label="Fit graph to screen" onClick={onFit}>
          <path
            d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </IconButton>
        <IconButton label="Re-run layout" onClick={onRerun} isActive={isSimulating}>
          <path
            d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </IconButton>
        <IconButton label="Layout parameters" onClick={togglePopover} isActive={isPopoverOpen}>
          <path
            d="M2 4h12M2 8h12M2 12h12"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="6" cy="4" r="1.6" fill="currentColor" />
          <circle cx="10" cy="8" r="1.6" fill="currentColor" />
          <circle cx="5" cy="12" r="1.6" fill="currentColor" />
        </IconButton>
      </div>
    </div>
  );
}
