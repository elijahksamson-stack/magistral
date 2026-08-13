/**
 * Live feedback for an in-flight ✦ run, and the decision that follows it.
 *
 * Two rules this component exists to hold:
 *   1. Prose is shown as a diff and written only on Accept. The author's text
 *      is never overwritten without an explicit click.
 *   2. Usage is reported in tokens and as a share of the subscription. Never as
 *      a price — that number is a notional weighting, not money.
 */

import { CELL_ACTION_LABELS } from '../../../shared/types/claude';
import styles from './StreamingOverlay.module.css';
import type { CellRunView } from './useCellRun';
import { summarizeUsage } from './usage';

export interface StreamingOverlayProps {
  run: CellRunView;
  onCancel(): void;
  onAccept(): void;
  onReject(): void;
}

function DiffView({ run }: { run: CellRunView }) {
  return (
    <div className={styles.diff} role="group" aria-label="Proposed change">
      {run.diff.map((line, index) => (
        // Diff lines have no stable identity; the index IS the position here.
        <div key={`${line.kind}-${index}`} className={styles[line.kind]}>
          <span className={styles.gutter} aria-hidden="true">
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
          </span>
          <span className={styles.lineText}>{line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function UsageStrip({ run }: { run: CellRunView }) {
  if (run.usage === null) return null;
  const usage = summarizeUsage(run.usage);

  return (
    <dl className={styles.usage}>
      <div className={styles.usageItem}>
        <dt>Tokens</dt>
        <dd>{usage.totalLabel}</dd>
      </div>
      <div className={styles.usageItem}>
        <dt>In / out</dt>
        <dd>
          {usage.inputLabel} / {usage.outputLabel}
        </dd>
      </div>
      <div className={styles.usageItem}>
        <dt>Cached</dt>
        <dd>{usage.cachedLabel}</dd>
      </div>
      <div className={styles.usageItem}>
        <dt>Subscription</dt>
        <dd>{usage.shareLabel}</dd>
      </div>
    </dl>
  );
}

export default function StreamingOverlay({
  run,
  onCancel,
  onAccept,
  onReject,
}: StreamingOverlayProps) {
  const actionLabel = CELL_ACTION_LABELS[run.action];

  return (
    <section className={styles.root} aria-label={`${actionLabel} result`}>
      <header className={styles.header}>
        <span className={styles.action}>
          <span aria-hidden="true">✦</span> {actionLabel}
        </span>
        {run.isStreaming ? (
          <span className={styles.status} role="status">
            <span className={styles.pulse} aria-hidden="true" />
            Thinking…
          </span>
        ) : (
          <span className={styles.status}>
            +{run.diffStats.added} / −{run.diffStats.removed}
          </span>
        )}
      </header>

      {run.error !== null ? (
        <p className={styles.error} role="alert">
          {run.error}
        </p>
      ) : run.isStreaming ? (
        <pre className={styles.rawStream}>{run.streamedText || 'Waiting for the first token…'}</pre>
      ) : (
        <DiffView run={run} />
      )}

      <UsageStrip run={run} />

      <footer className={styles.actions}>
        {run.isStreaming ? (
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <>
            <button type="button" className={styles.secondary} onClick={onReject}>
              Reject
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={onAccept}
              disabled={!run.canDecide}
            >
              Accept
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
