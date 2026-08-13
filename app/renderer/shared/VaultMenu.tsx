/**
 * The vault picker.
 *
 * Replaces a bare `<select>`, which could switch between graphs but never
 * create, rename or delete one — so a workspace accumulated identically-named
 * "Untitled" entries with no way to clear them out.
 *
 * Rename is a labelled button rather than a pencil glyph. A 0.4-opacity pencil
 * is what shipped for renaming a GROUP, and it was reported as "I don't see the
 * rename" — the control was there and nobody could find it.
 */

import { useEffect, useRef, useState } from 'react';

import type { VaultSummary } from '../../../shared/types/ipc';
import styles from './VaultMenu.module.css';

export interface VaultMenuProps {
  vaults: readonly VaultSummary[];
  activeVaultId: string | null;
  isDirty: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (vault: VaultSummary) => void;
  onDelete: (id: string) => void;
}

export default function VaultMenu({
  vaults,
  activeVaultId,
  isDirty,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: VaultMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
      setConfirmingId(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (confirmingId) setConfirmingId(null);
      else setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, confirmingId]);

  const active = vaults.find((vault) => vault.id === activeVaultId);
  // Deleting the only graph would leave the app with nothing open.
  const canDelete = vaults.length > 1;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        {isDirty ? <span className={styles.dirty} aria-label="Unsaved changes" /> : null}
        <span className={styles.triggerName}>{active?.name ?? 'No graph'}</span>
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen ? (
        <div className={styles.menu} role="menu">
          <ul className={styles.list}>
            {vaults.map((vault) => {
              const isActive = vault.id === activeVaultId;
              const isConfirming = confirmingId === vault.id;

              return (
                <li key={vault.id} className={isConfirming ? styles.rowConfirming : styles.row}>
                  {isConfirming ? (
                    <div className={styles.confirm}>
                      <span className={styles.confirmText}>
                        Delete <strong>{vault.name}</strong>? This cannot be undone.
                      </span>
                      <button type="button" onClick={() => setConfirmingId(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className={styles.confirmDelete}
                        onClick={() => {
                          setConfirmingId(null);
                          setIsOpen(false);
                          onDelete(vault.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.item}
                        onClick={() => {
                          setIsOpen(false);
                          if (!isActive) onOpen(vault.id);
                        }}
                      >
                        <span className={styles.check} aria-hidden="true">
                          {isActive ? '✓' : ''}
                        </span>
                        <span className={styles.name}>{vault.name}</span>
                        <span className={styles.meta}>
                          {vault.nodeCount} node{vault.nodeCount === 1 ? '' : 's'}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.rename}
                        onClick={() => {
                          setIsOpen(false);
                          onRename(vault);
                        }}
                        aria-label={`Rename ${vault.name}`}
                        title="Rename this graph"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className={styles.remove}
                        onClick={() => setConfirmingId(vault.id)}
                        disabled={!canDelete}
                        aria-label={`Delete ${vault.name}`}
                        title={canDelete ? 'Delete this graph' : 'The last graph cannot be deleted'}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            className={styles.create}
            onClick={() => {
              setIsOpen(false);
              onCreate();
            }}
          >
            <span aria-hidden="true">+</span> New graph
          </button>
        </div>
      ) : null}
    </div>
  );
}
