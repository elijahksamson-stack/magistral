/**
 * The description on a concept's detail panel, editable in place.
 *
 * Shared by NodeDetail and SubNodeDetail so a node and a sub-concept read and
 * behave identically — the panel is the same object seen at two depths, and two
 * separate editors would drift apart.
 *
 * Persistence differs underneath (a node writes its note through IPC, a
 * sub-concept writes back into its cell's markdown), so this component owns the
 * draft and nothing else: it hands committed text to `onSave`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './NodeDetail.module.css';

export interface DescriptionEditorProps {
  /** The description as it currently stands. Empty when there is none yet. */
  value: string;
  /** Shown when nothing is written and the field is idle. */
  placeholder: string;
  onSave: (next: string) => void;
  /** Absent when no local model is available to write one. */
  onGenerate?: (() => void) | undefined;
  isGenerating?: boolean;
  /** Explains what the model will read, so the button is never a mystery. */
  generateHint?: string;
}

export default function DescriptionEditor({
  value,
  placeholder,
  onSave,
  onGenerate,
  isGenerating = false,
  generateHint,
}: DescriptionEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // A generated description arriving while the field is closed should appear;
  // one arriving mid-edit must not overwrite what is being typed.
  useEffect(() => {
    if (!isEditing) setDraft(value);
  }, [value, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    areaRef.current?.focus();
    areaRef.current?.select();
  }, [isEditing]);

  const commit = useCallback((): void => {
    setIsEditing(false);
    const next = draft.trim();
    if (next === value.trim()) return;
    onSave(next);
  }, [draft, onSave, value]);

  const cancel = useCallback((): void => {
    setDraft(value);
    setIsEditing(false);
  }, [value]);

  return (
    <section className={styles.description}>
      <div className={styles.descriptionHead}>
        <h3 className={styles.heading}>Description</h3>
        {onGenerate ? (
          <button
            type="button"
            className={styles.generate}
            onClick={onGenerate}
            disabled={isGenerating}
            title={generateHint}
          >
            {/* Says which it will do: an existing description is deepened, never replaced. */}
            <span aria-hidden="true">✦</span>{' '}
            {isGenerating ? 'Writing…' : value.trim() ? 'Deepen it' : 'Write it'}
          </button>
        ) : null}
      </div>

      {isEditing ? (
        <textarea
          ref={areaRef}
          className={styles.descriptionInput}
          value={draft}
          rows={4}
          aria-label="Description"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
              return;
            }
            // Enter alone inserts a newline: a description is prose, not a
            // single-line field. Committing is deliberate.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={value.trim() ? styles.descriptionText : styles.descriptionEmpty}
          onClick={() => setIsEditing(true)}
          aria-label={value.trim() ? 'Edit description' : 'Add a description'}
        >
          {value.trim() || placeholder}
        </button>
      )}
    </section>
  );
}
