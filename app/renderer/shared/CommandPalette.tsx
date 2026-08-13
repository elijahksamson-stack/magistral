import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { cellSummaryOf, cellTitleOf } from '../editor/cell-summary';
import { useGraphStore } from './store';
import styles from './CommandPalette.module.css';
import { buildEntityPresentations, type EntityPresentation } from './entityPresentation';

interface PaletteItem {
  id: string;
  kind: 'command' | 'cell' | 'concept';
  label: string;
  detail: string;
  entity?: EntityPresentation;
  entityId?: string;
  run(): void;
}

export interface CommandPaletteProps {
  onShowEditor(): void;
  onShowChat(): void;
  canShowChat?: boolean;
}

export default function CommandPalette({
  onShowEditor,
  onShowChat,
  canShowChat = true,
}: CommandPaletteProps): React.JSX.Element | null {
  const store = useGraphStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const presentations = buildEntityPresentations(
      store.graph?.nodes ?? [],
      store.graph?.edges ?? [],
      store.selectedNodeId,
      store.hoveredNodeId,
    );
    const commands: PaletteItem[] = [
      { id: 'editor', kind: 'command', label: 'Show Editor', detail: 'Workspace', run: onShowEditor },
      ...(canShowChat
        ? [{ id: 'chat', kind: 'command' as const, label: 'Show Chat', detail: 'Workspace', run: onShowChat }]
        : []),
      { id: 'save', kind: 'command', label: 'Save graph', detail: '⌘S', run: () => void store.saveVault() },
      { id: 'undo', kind: 'command', label: 'Undo graph change', detail: '⌘Z', run: () => void store.undo() },
      { id: 'redo', kind: 'command', label: 'Redo graph change', detail: '⇧⌘Z', run: () => void store.redo() },
    ];
    const cells = (store.graph?.cells ?? []).map((cell) => ({
      id: `cell:${cell.id}`,
      kind: 'cell' as const,
      label: cellTitleOf(cell.markdown),
      detail: cellSummaryOf(cell.markdown) || 'Cell',
      run: () => {
        onShowEditor();
        store.setSelectedSubnodeId(null);
        store.setSelectedCellId(cell.id);
      },
    }));
    const nodes = (store.graph?.nodes ?? []).map((node) => ({
      id: `node:${node.id}`,
      kind: 'concept' as const,
      label: node.label,
      detail: `${node.kind} · ${node.degree} connection${node.degree === 1 ? '' : 's'}`,
      entity: presentations.get(node.id),
      entityId: node.id,
      run: () => {
        store.setSelectedSubnodeId(null);
        store.setSelectedNodeId(node.id);
      },
    }));
    return [...commands, ...cells, ...nodes];
  }, [canShowChat, onShowChat, onShowEditor, store]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items.slice(0, 18);
    return items
      .filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(needle))
      .slice(0, 24);
  }, [items, query]);

  if (!open) return null;
  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={() => setOpen(false)}>
      <section className={styles.palette} role="dialog" aria-modal="true" aria-label="Search and commands" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.searchRow}>
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search cells, concepts, and commands…"
            aria-label="Search Magistral"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((index) => Math.min(filtered.length - 1, index + 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => Math.max(0, index - 1));
              }
              if (event.key === 'Enter') choose(filtered[active]);
            }}
          />
          <kbd>⌘K</kbd>
        </div>
        <ul className={styles.results} role="listbox">
          {filtered.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                className={index === active ? styles.active : undefined}
                role="option"
                aria-selected={index === active}
                data-entity={item.entity ? 'true' : 'false'}
                style={item.entity
                  ? ({ '--bd-entity-color': item.entity.categoryColor } as CSSProperties)
                  : undefined}
                onMouseEnter={() => {
                  setActive(index);
                  store.setHoveredNodeId(item.entityId ?? null);
                }}
                onMouseLeave={() => store.setHoveredNodeId(null)}
                onClick={() => choose(item)}
              >
                <span className={styles.kind}>
                  {item.entity ? `${item.entity.glyph} ${item.entity.categoryLabel}` : item.kind}
                </span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </button>
            </li>
          ))}
          {filtered.length === 0 ? <li className={styles.noResults}>No matching cells or concepts.</li> : null}
        </ul>
      </section>
    </div>
  );
}
