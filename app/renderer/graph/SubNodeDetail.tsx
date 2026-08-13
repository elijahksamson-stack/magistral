/** Focused detail for an authored child facet, with its description editable. */

import { useEffect } from 'react';
import styles from './NodeDetail.module.css';
import DescriptionEditor from './DescriptionEditor';

export interface SubNodeDetailProps {
  label: string;
  description?: string;
  /**
   * Writes the description back into the cell that authored this facet.
   * Absent when no cell owns it, which leaves the description read-only.
   */
  onSaveDescription?: ((next: string) => void) | undefined;
  onGenerateDescription?: (() => void) | undefined;
  isGenerating?: boolean;
  generateHint?: string;
  onClose: () => void;
}

export default function SubNodeDetail({
  label,
  description,
  onSaveDescription,
  onGenerateDescription,
  isGenerating,
  generateHint,
  onClose,
}: SubNodeDetailProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <aside className={styles.panel} aria-label={`${label} subnode details`}>
      <header className={styles.head}>
        <h2 className={styles.title}>{label}</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {onSaveDescription ? (
        <DescriptionEditor
          value={description ?? ''}
          placeholder="No description yet. Click to write one."
          onSave={onSaveDescription}
          onGenerate={onGenerateDescription}
          isGenerating={isGenerating ?? false}
          generateHint={generateHint}
        />
      ) : description?.trim() ? (
        <p className={styles.subnodeDescription}>{description}</p>
      ) : (
        <p className={styles.subnodeEmpty}>No description yet.</p>
      )}
    </aside>
  );
}
