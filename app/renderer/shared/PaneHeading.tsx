/**
 * A pane title and its compact quantitative context.
 *
 * Kept as one layout unit so controls can never squeeze the metrics into the
 * title. CSS decides from the measured content widths whether both rows fit;
 * no title-length guesses or JavaScript resize bookkeeping are involved.
 */

import styles from './PaneHeading.module.css';

export interface PaneHeadingProps {
  title: string;
  metrics?: string;
}

export default function PaneHeading({
  title,
  metrics = '',
}: PaneHeadingProps): React.JSX.Element {
  return (
    <div className={styles.heading}>
      <h1 className={styles.title} title={title}>
        {title}
      </h1>
      {metrics ? (
        <span className={styles.metrics} title={metrics}>
          {metrics}
        </span>
      ) : null}
    </div>
  );
}
