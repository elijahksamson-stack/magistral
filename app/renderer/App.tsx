/**
 * The shell: tab bar, the Editor/Graph split, the Chat tab, and the status bar.
 *
 * It owns no domain state. Panes read the store and the Claude hook directly,
 * so the shell's whole job is layout, vault switching, menu commands, and
 * keeping one pane's crash from taking the window with it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ChatPane from './chat/ChatPane';
import EditorPane from './editor/EditorPane';
import GraphPane from './graph/GraphPane';
import styles from './App.module.css';
import { exportGraphYaml } from './export/exportYaml';
import { applyImportPlan, planImport, vaultNameFromFile } from './export/importYaml';
import { invoke } from './graph/ipcClient';
import { isBoolean, readPersisted, writePersisted } from './shared/persisted';
import ErrorBoundary from './shared/ErrorBoundary';
import NamePrompt from './shared/NamePrompt';
import CommandPalette from './shared/CommandPalette';
import BrandLockup, { BrandGlyph } from './shared/Brand';
import ProviderSelector, { hasUsableProvider } from './shared/ProviderSelector';
import ResizableSplit from './shared/ResizableSplit';
import VaultMenu from './shared/VaultMenu';
import { toMessage } from './shared/api';
import { useGraphStore } from './shared/store';
import { useMenuCommands, type MenuCommand } from './shared/useMenuCommands';
import type { CliProviderSnapshot } from '../../shared/types/claude';
import { type ConnectionScope } from './graph/connectionTypes';
import { formatGraphStatus } from './shared/entityPresentation';

/**
 * Two tabs, not three.
 *
 * A separate Graph tab showed the same editor+graph split as the Editor tab,
 * differing only in column width — two names for one screen, and nothing told
 * you which you were on. Editor IS the split: write on the left, watch the
 * graph build on the right.
 */
type Tab = 'editor' | 'chat';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'chat', label: 'Chat' },
];

/** Writing gets the room; the graph is the read-out beside it. */
/**
 * What the name dialog is for.
 *
 * `rename` carries its target: the vault picker can rename any graph, not only
 * the one that is open, and reading the name off `store.graph` would silently
 * rename the wrong one.
 */
type NamingIntent =
  | { kind: 'create' }
  | { kind: 'save' }
  | { kind: 'rename'; id: string; currentName: string }
  | null;

const NAMING_TITLES = {
  create: 'Name the new graph',
  save: 'Name this graph',
  rename: 'Rename this graph',
} as const;

const NAMING_CONFIRM = {
  create: 'Create',
  save: 'Save',
  rename: 'Rename',
} as const;

/** A rename starts from the current name; a first save starts from nothing. */
function initialNameFor(
  intent: NonNullable<NamingIntent>,
  openGraphName: string | undefined,
): string {
  if (intent.kind === 'rename') return intent.currentName;
  if (intent.kind === 'create') return '';
  return openGraphName === 'Untitled' ? '' : (openGraphName ?? '');
}

const EDITOR_COLLAPSED_SCOPE = 'app.editorCollapsed';

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, [contenteditable="true"], .cm-editor'));
}

export default function App(): React.JSX.Element {
  const store = useGraphStore();
  const [tab, setTab] = useState<Tab>('editor');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [providerSnapshot, setProviderSnapshot] = useState<CliProviderSnapshot | null>(null);
  const [autoCompleteRequestId, setAutoCompleteRequestId] = useState<number | null>(null);
  const [autoCompleteScope, setAutoCompleteScope] = useState<ConnectionScope>('all');
  const autoCompleteSequence = useRef(0);
  /**
   * The name prompt serves two intents. Without distinguishing them, "New
   * graph" would rename the graph you are standing in instead of making one.
   */
  /**
   * The name dialog's intent. Rename carries its target, because the vault
   * being renamed is not necessarily the one that is open.
   */
  const [naming, setNaming] = useState<NamingIntent>(null);
  /**
   * Collapses the writing side so the graph gets the whole window. A thin rail
   * stays behind to bring it back — a hidden panel with no handle is a panel
   * you have lost.
   */
  const [isEditorCollapsed, setIsEditorCollapsed] = useState(false);
  const llmAvailable = hasUsableProvider(providerSnapshot);
  const activeTab: Tab = llmAvailable ? tab : 'editor';
  const visibleTabs = llmAvailable ? TABS : TABS.filter(({ id }) => id === 'editor');

  const findCrossConnections = useCallback((scope: ConnectionScope): void => {
    autoCompleteSequence.current += 1;
    setAutoCompleteScope(scope);
    setAutoCompleteRequestId(autoCompleteSequence.current);
    setTab('chat');
  }, []);

  const consumeAutoComplete = useCallback((): void => {
    setAutoCompleteRequestId(null);
  }, []);

  useEffect(() => {
    if (!llmAvailable && tab === 'chat') setTab('editor');
  }, [llmAvailable, tab]);

  useEffect(
    () =>
      window.braindump.on('window:fullscreen', ({ fullScreen }) => {
        setIsFullScreen(fullScreen);
      }),
    [],
  );

  // Remembered per vault: reopening a graph you had collapsed and finding it
  // expanded again reads as the feature having been removed.
  const vaultId = store.graph?.id ?? null;
  useEffect(() => {
    setIsEditorCollapsed(readPersisted(EDITOR_COLLAPSED_SCOPE, vaultId, isBoolean, false));
  }, [vaultId]);

  const setEditorCollapsed = useCallback(
    (collapsed: boolean): void => {
      setIsEditorCollapsed(collapsed);
      writePersisted(EDITOR_COLLAPSED_SCOPE, vaultId, collapsed);
    },
    [vaultId],
  );
  /** The chat answer being written, so the graph beside it can fire concepts. */
  const [chatStreamingText, setChatStreamingText] = useState('');
  const graphColumn = useRef<HTMLDivElement>(null);

  /**
   * Bring an exported map in as its own vault.
   *
   * The vault is named after the FILE, so `economy.yaml` lands as "economy" and
   * is findable by the name it travelled under. A clash with an existing vault
   * surfaces as the storage layer's refusal rather than being silently
   * suffixed — the author picks a new name and imports again.
   */
  const importVault = useCallback(async (): Promise<void> => {
    try {
      const { file } = await invoke('import:yaml', undefined);
      if (!file) return;

      const plan = planImport(file.text);
      setNotice(`Importing ${file.fileName}…`);
      const report = await applyImportPlan(vaultNameFromFile(file.fileName), plan);
      /*
       * The list first, then open it. The vault was created through IPC rather
       * than `createVault`, because cells and relationships have to be written
       * into it before it is worth showing — so the picker has never heard of
       * it, and opening an id absent from that list leaves it reporting
       * "No graph" about the vault filling the screen.
       */
      await store.refreshVaults();
      await store.openVault(report.id);

      const dropped = plan.skipped.length > 0
        ? ` ${plan.skipped.length} relationship${plan.skipped.length === 1 ? '' : 's'} referenced a concept the file never defined and were left out.`
        : '';
      setNotice(
        `Imported ${report.cells} concepts and ${report.edges} relationships as "${report.name}".${dropped}`,
      );
    } catch (error: unknown) {
      setNotice(`Import failed: ${toMessage(error)}`);
    }
  }, [store]);

  const runMenuCommand = useCallback(
    (command: MenuCommand): void => {
      setNotice(null);
      switch (command) {
        case 'new-vault':
          void store.createVault();
          return;
        case 'import-vault':
          void importVault();
          return;
        case 'save-vault':
          // Ask for a name the first time rather than saving another vault
          // called "Untitled" into a picker full of them.
          if (store.isUnnamed) setNaming({ kind: 'save' });
          else void store.saveVault();
          return;
        case 'export-yaml':
          exportGraphYaml().catch((error: unknown) =>
            setNotice(`Export failed: ${toMessage(error)}`),
          );
          return;
        default:
          return;
      }
    },
    [importVault, store],
  );

  useMenuCommands(runMenuCommand);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.key.toLowerCase() !== 'z' || isTextEditingTarget(event.target)) return;
      event.preventDefault();
      if (event.shiftKey) void store.redo();
      else void store.undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);

  const isSplit = activeTab !== 'chat';
  const status = notice ?? store.error;

  const confirmName = useCallback(
    (name: string): void => {
      const intent = naming;
      setNaming(null);
      if (intent === null) return;

      if (intent.kind === 'create') {
        void store.createVault(name);
        return;
      }
      if (intent.kind === 'rename') {
        // No save: renaming a vault that is not open must not write the open
        // graph over it, and `vault:rename` already persisted the new name.
        void store.renameVault(name, intent.id);
        return;
      }
      // Rename first, then persist — saving before the rename would write the
      // old name straight back over it.
      void store.renameVault(name).then(() => store.saveVault());
    },
    [naming, store],
  );

  return (
    <div
      className={styles.shell}
      data-fullscreen={isFullScreen}
      data-platform={window.braindump.platform}
    >
      {naming ? (
        <NamePrompt
          title={NAMING_TITLES[naming.kind]}
          confirmLabel={NAMING_CONFIRM[naming.kind]}
          initialValue={initialNameFor(naming, store.graph?.name)}
          onConfirm={confirmName}
          onCancel={() => setNaming(null)}
        />
      ) : null}

      <CommandPalette
        onShowEditor={() => setTab('editor')}
        onShowChat={() => setTab('chat')}
        canShowChat={llmAvailable}
      />

      <div className={styles.tabbar} role="tablist" aria-label="Workspace">
        <div className={styles.brandSlot}>
          <BrandLockup />
        </div>
        <div className={styles.tabs}>
          {visibleTabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={activeTab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={styles.spacer} />

        <ProviderSelector onSnapshot={setProviderSnapshot} hideWhenUnavailable />

        <div className={styles.vaultbar}>
          <VaultMenu
            vaults={store.vaults}
            activeVaultId={store.activeVaultId}
            isDirty={store.isDirty}
            onOpen={(id) => void store.openVault(id)}
            onCreate={() => setNaming({ kind: 'create' })}
            onRename={(vault) =>
              setNaming({ kind: 'rename', id: vault.id, currentName: vault.name })
            }
            onDelete={(id) => void store.deleteVault(id)}
          />
        </div>
      </div>

      <div className={styles.body}>
        {store.loading && !store.graph ? (
          <div className={styles.boot} role="status" aria-live="polite">
            <BrandGlyph className={styles.bootGlyph} />
            <span className={styles.bootKicker}>MAGISTRAL / LOCAL-FIRST</span>
            <strong>Opening the context</strong>
            <span className={styles.bootTrack} aria-hidden="true">
              <span />
            </span>
          </div>
        ) : isSplit ? (
          isEditorCollapsed ? (
          <div className={styles.splitCollapsed}>
            {isEditorCollapsed ? (
              <button
                type="button"
                className={styles.rail}
                onClick={() => setEditorCollapsed(false)}
                title="Show the editor"
                aria-label="Show the editor"
              >
                <span className={styles.railChevron} aria-hidden="true">
                  ›
                </span>
                <span className={styles.railLabel}>Editor</span>
              </button>
            ) : (
              <div className={styles.column}>
                <ErrorBoundary label="Editor">
                  <EditorPane
                    onCollapse={() => setEditorCollapsed(true)}
                    providerSelection={providerSnapshot?.selected ?? null}
                    llmAvailable={llmAvailable}
                  />
                </ErrorBoundary>
              </div>
            )}

            <div className={styles.divider} />

            <div className={styles.column} ref={graphColumn}>
              <ErrorBoundary label="Graph">
                <GraphPane onFindConnections={llmAvailable ? findCrossConnections : undefined} />
              </ErrorBoundary>
            </div>
          </div>
          ) : (
            <ResizableSplit
              scope="app.editorSplit"
              vaultId={vaultId}
              defaultPercent={57}
              left={
                <ErrorBoundary label="Editor">
                  <EditorPane
                    onCollapse={() => setEditorCollapsed(true)}
                    providerSelection={providerSnapshot?.selected ?? null}
                    llmAvailable={llmAvailable}
                  />
                </ErrorBoundary>
              }
              right={
                <ErrorBoundary label="Graph">
                  <GraphPane onFindConnections={llmAvailable ? findCrossConnections : undefined} />
                </ErrorBoundary>
              }
              leftLabel="Editor"
              rightLabel="Graph"
            />
          )
        ) : (
          <ResizableSplit
            scope="app.chatSplit"
            vaultId={vaultId}
            defaultPercent={67}
            left={
              <ErrorBoundary label="Chat">
                <ChatPane
                  onStreamingText={setChatStreamingText}
                  providerSnapshot={providerSnapshot}
                  onProviderSnapshot={setProviderSnapshot}
                  autoCompleteRequestId={autoCompleteRequestId}
                  autoCompleteScope={autoCompleteScope}
                  onAutoCompleteConsumed={consumeAutoComplete}
                />
              </ErrorBoundary>
            }
            right={
              <ErrorBoundary label="Graph">
                <GraphPane recallText={chatStreamingText} />
              </ErrorBoundary>
            }
            leftLabel="Chat"
            rightLabel="Graph"
          />
        )}
      </div>

      <div className={styles.statusbar}>
        <button
          type="button"
          className={styles.renameButton}
          // Was the 'save' intent, which renamed AND wrote the vault. Renaming
          // should not decide to save on the author's behalf; the picker's
          // Rename does not, and a control labelled Rename should not either.
          onClick={() =>
            store.activeVaultId && store.graph
              ? setNaming({
                  kind: 'rename',
                  id: store.activeVaultId,
                  currentName: store.graph.name,
                })
              : undefined
          }
          disabled={!store.graph}
          title="Rename this graph"
        >
          {store.graph ? store.graph.name : 'No vault'}
        </button>
        <span>
          {store.graph
            ? formatGraphStatus(store.graph)
            : '—'}
        </span>
        <span className={styles.statusSpacer} />
        <button
          type="button"
          className={styles.historyButton}
          disabled={!store.canUndo}
          onClick={() => void store.undo()}
          title="Undo graph change (⌘Z)"
          aria-label="Undo graph change"
        >
          ↶
        </button>
        <button
          type="button"
          className={styles.historyButton}
          disabled={!store.canRedo}
          onClick={() => void store.redo()}
          title="Redo graph change (⇧⌘Z)"
          aria-label="Redo graph change"
        >
          ↷
        </button>
        <div className={styles.historyWrap}>
          <button
            type="button"
            className={styles.changesButton}
            onClick={() => setIsHistoryOpen((open) => !open)}
            aria-expanded={isHistoryOpen}
          >
            Recent changes
          </button>
          {isHistoryOpen ? (
            <div className={styles.historyPopover} role="log" aria-label="Recent graph changes">
              <h2>Recent changes</h2>
              {store.recentChanges.length > 0 ? (
                <ol>
                  {store.recentChanges.map((change) => (
                    <li
                      key={change.id}
                      onMouseEnter={() => store.setHoveredNodeId(change.entityIds[0] ?? null)}
                      onMouseLeave={() => store.setHoveredNodeId(null)}
                    >
                      <button
                        type="button"
                        className={styles.changeEntity}
                        disabled={change.entityIds.length === 0}
                        onClick={() => {
                          const entityId = change.entityIds[0];
                          if (!entityId) return;
                          store.setSelectedSubnodeId(null);
                          store.setSelectedNodeId(entityId);
                        }}
                      >
                        {change.label}
                      </button>
                      <time dateTime={change.at}>
                        {new Date(change.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : <p>No changes in this session.</p>}
            </div>
          ) : null}
        </div>
        <span className={styles.saveState} data-state={store.saveState}>
          {store.saveState === 'saving'
            ? 'Saving…'
            : store.saveState === 'unsaved'
              ? 'Unsaved changes'
              : store.saveState === 'error'
                ? 'Save error'
                : 'Saved'}
        </span>
        {status ? (
          <>
            <span className={styles.statusError} title={status}>
              {status}
            </span>
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => {
                setNotice(null);
                store.clearError();
              }}
            >
              Dismiss
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
