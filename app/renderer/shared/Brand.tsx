/**
 * Magistral's digital signature.
 *
 * The M carries the identity on its own. Colour is deliberately reserved for
 * the period in the wordmark: one decisive full stop, repeated as a short
 * datum rule under the name. Cyan remains a product-state colour, not a logo
 * embellishment.
 */

import styles from './Brand.module.css';

interface ClassNameProps {
  className?: string;
}

function classes(base: string | undefined, className?: string): string {
  return [base, className].filter(Boolean).join(' ');
}

export function BrandMark({ className }: ClassNameProps): React.JSX.Element {
  return (
    <svg
      className={classes(styles.mark, className)}
      viewBox="0 0 120 94"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className={styles.markBody}
        d="M10 92 0 82V12l6-6 54 54 54-54 6 6v70l-10 10H96V58L60 94 24 58v34Z"
      />
    </svg>
  );
}

export function BrandGlyph({ className }: ClassNameProps): React.JSX.Element {
  return (
    <span className={classes(styles.glyph, className)} aria-hidden="true">
      <BrandMark />
    </span>
  );
}

export default function BrandLockup({ className }: ClassNameProps): React.JSX.Element {
  return (
    <div
      className={classes(styles.lockup, className)}
      aria-label="Magistral — a context builder"
    >
      <BrandGlyph />
      <span className={styles.type} aria-hidden="true">
        <strong className={styles.name}>
          magistral<span className={styles.period}>.</span>
        </strong>
        <small className={styles.descriptor}>CONTEXT BUILDER</small>
      </span>
    </div>
  );
}
