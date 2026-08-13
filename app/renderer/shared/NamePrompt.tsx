/**
 * Asks what to call this graph.
 *
 * Save used to write straight to a vault called "Untitled" with no chance to
 * name it, so every saved graph was called the same thing and the vault picker
 * was a list of identical entries. The first save asks; later ones do not.
 */

import { useEffect, useRef, useState } from 'react';

import styles from './NamePrompt.module.css';

export interface NamePromptProps {
  title: string;
  confirmLabel: string;
  initialValue: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export default function NamePrompt({
  title,
  confirmLabel,
  initialValue,
  onConfirm,
  onCancel,
}: NamePromptProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const trimmed = value.trim();
  const canConfirm = trimmed.length > 0;

  return (
    <div
      className={styles.scrim}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          if (canConfirm) onConfirm(trimmed);
        }}
      >
        <label className={styles.label} htmlFor="bd-name-input">
          {title}
        </label>
        <input
          id="bd-name-input"
          ref={inputRef}
          className={styles.input}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel();
          }}
          placeholder="e.g. Semiconductor constraint"
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.actions}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.confirm} disabled={!canConfirm}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
