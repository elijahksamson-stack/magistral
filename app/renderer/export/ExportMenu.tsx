/**
 * The export control on the graph pane.
 *
 * One format: the knowledge map (.yaml) — readable by a person or a model, and
 * now the only thing Magistral both writes AND reads back.
 *
 * The interactive HTML page is gone, as are both JSON exports and JPG before
 * them. The page was a viewer for a map that could not be edited or reimported,
 * which made it a dead end; the canonical JSON was a second copy of the save
 * file offered as an export; and the outline JSON had the right content in a
 * shape nobody enjoys reading a nested tree in. One format that round-trips is
 * worth more than four that do not.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { KnowledgeGraph } from '../../../shared/types/graph';
import type { PositionIndex } from '../graph/positionIndex';
import { toErrorMessage } from '../graph/errors';
import styles from './ExportMenu.module.css';
import { exportGraphYaml } from './exportYaml';

type Format = 'yaml';

interface FormatSpec {
  readonly id: Format;
  readonly label: string;
  readonly extension: string;
  readonly hint: string;
}

const FORMATS: readonly FormatSpec[] = [
  {
    id: 'yaml',
    label: 'Knowledge map',
    extension: '.yaml',
    hint: 'Nodes, relationships and notes, each listed once. No layout state',
  },
];

export interface ExportMenuProps {
  readonly graph: KnowledgeGraph | null;
  /**
   * Kept so the graph pane's call site is unchanged. The HTML export reads the
   * snapshot rather than the live position index, so nothing here needs it.
   */
  readonly index?: PositionIndex | null;
}

export default function ExportMenu({ graph }: ExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const run = useCallback(
    async (format: Format): Promise<void> => {
      setBusy(format);
      setMessage(null);
      try {
        const result = await exportGraphYaml();

        // A dismissed save dialog is not an error and deserves no message.
        if (result.saved) setIsOpen(false);
      } catch (cause: unknown) {
        setMessage(toErrorMessage(cause));
      } finally {
        setBusy(null);
      }
    },
    [graph],
  );

  const isEmpty = !graph || graph.nodes.length === 0;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setIsOpen((open) => !open)}
        disabled={isEmpty}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={isEmpty ? 'Nothing to export yet' : 'Export this graph'}
      >
        Export
      </button>

      {isOpen ? (
        <div className={styles.menu} role="menu">
          {FORMATS.map((format) => (
            <button
              key={format.id}
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => void run(format.id)}
              disabled={busy !== null}
            >
              <span className={styles.itemLabel}>
                {format.label}
                <span className={styles.itemExt}>{format.extension}</span>
              </span>
              <span className={styles.itemHint}>
                {busy === format.id ? 'Saving…' : format.hint}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {message ? (
        <p className={styles.message} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
