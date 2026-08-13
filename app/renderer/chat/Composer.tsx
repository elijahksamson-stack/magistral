/**
 * The chat input.
 *
 * Presentational and controlled. The parent owns the draft text and both
 * actions; this component decides only how they are reached from the keyboard.
 */

import { type JSX, type KeyboardEvent } from 'react';

import styles from './Composer.module.css';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  /** True while a turn is in flight — sending is blocked, cancelling is not. */
  isBusy: boolean;
  /** False when no vault is open. */
  isEnabled: boolean;
  placeholder?: string;
  providerLabel?: string;
  suggestions?: readonly string[];
}

const MIN_ROWS = 2;
const MAX_ROWS = 8;
const APPROX_CHARS_PER_ROW = 72;

/** Grow with the draft, within bounds. Cheap, and avoids a layout observer. */
function rowsFor(value: string): number {
  const wrapped = value
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / APPROX_CHARS_PER_ROW)), 0);
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, wrapped));
}

export default function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  isBusy,
  isEnabled,
  placeholder = 'Ask about the graph…',
  providerLabel,
  suggestions = [],
}: ComposerProps): JSX.Element {
  const canSend = isEnabled && !isBusy && value.trim().length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className={styles.composer}>
      {value.length === 0 && isEnabled && suggestions.length > 0 ? (
        <div className={styles.suggestions} aria-label="Suggested prompts">
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => onChange(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        className={styles.input}
        value={value}
        rows={rowsFor(value)}
        placeholder={isEnabled ? placeholder : 'Open a vault to start a conversation'}
        disabled={!isEnabled}
        aria-label="Message"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className={styles.controls}>
        <span className={styles.hint}>
          {isBusy
            ? `Streaming — Stop ends this turn${providerLabel ? ` · via ${providerLabel}` : ''}`
            : `${providerLabel ? `Answer with ${providerLabel} · ` : ''}Enter to send · Shift+Enter for a new line`}
        </span>

        {isBusy ? (
          <button type="button" className={styles.cancel} onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button type="button" className={styles.send} disabled={!canSend} onClick={onSend}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
