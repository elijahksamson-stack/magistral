import { type CSSProperties } from 'react';
import type { NodeKind, RelationKind } from '../../../shared/types/graph';
import { NODE_KINDS, RELATION_KINDS } from '../../../shared/types/graph';
import {
  CONNECTION_SCOPES,
  CONNECTION_SCOPE_LABELS,
  type ConnectionScope,
} from './connectionTypes';
import styles from './GraphToolbar.module.css';
import { RELATION_COLORS } from './constants';
import { CATEGORY_COLORS, CATEGORY_GLYPHS } from '../shared/entityPresentation';

interface GraphToolbarProps {
  focusOnly: boolean;
  hasFocus: boolean;
  /** Whether flow is currently animating along the relationships. */
  isFlowing: boolean;
  onFlowingChange: (value: boolean) => void;
  connectMode: boolean;
  connectSourceLabel?: string;
  nodeKinds: ReadonlySet<NodeKind>;
  relations: ReadonlySet<RelationKind>;
  /**
   * The relation kinds this graph actually uses, for the legend.
   *
   * A legend listing all ten kinds asks the reader to search it for the three
   * their map contains. The Filters panel still offers every kind, because a
   * filter is about what you MIGHT see; a legend is about what you ARE seeing.
   */
  presentRelations: readonly RelationKind[];
  connectionScope: ConnectionScope;
  onFocusOnlyChange: (value: boolean) => void;
  onConnectModeChange: (value: boolean) => void;
  onOpenConnectionBuilder: () => void;
  /** Opens the reviewed AI connection scout. Absent when no local CLI is usable. */
  onFindConnections?: (scope: ConnectionScope) => void;
  onToggleNodeKind: (kind: NodeKind) => void;
  onToggleRelation: (relation: RelationKind) => void;
  onConnectionScopeChange: (scope: ConnectionScope) => void;
  onReset: () => void;
}

function readable(value: string): string {
  return value.replaceAll('_', ' ');
}

export default function GraphToolbar({
  focusOnly,
  hasFocus,
  isFlowing,
  onFlowingChange,
  connectMode,
  connectSourceLabel,
  nodeKinds,
  relations,
  presentRelations,
  connectionScope,
  onFocusOnlyChange,
  onConnectModeChange,
  onOpenConnectionBuilder,
  onFindConnections,
  onToggleNodeKind,
  onToggleRelation,
  onConnectionScopeChange,
  onReset,
}: GraphToolbarProps): React.JSX.Element {
  const filtered =
    nodeKinds.size < NODE_KINDS.length ||
    relations.size < RELATION_KINDS.length ||
    connectionScope !== 'all';

  return (
    <div className={styles.toolbar} aria-label="Graph display controls">
      <button
        type="button"
        className={styles.focus}
        aria-pressed={focusOnly}
        disabled={!hasFocus}
        title="Show only the selected concept and its immediate connections"
        onClick={() => onFocusOnlyChange(!focusOnly)}
      >
        <span aria-hidden="true">◎</span> Focus selection
      </button>

      {/* Reading the map, not changing it: which way each relationship runs. */}
      <button
        type="button"
        className={styles.focus}
        aria-pressed={isFlowing}
        title={
          isFlowing
            ? 'Stop the flow animation'
            : 'Animate every relationship in the direction it points, including sub-concepts on screen'
        }
        onClick={() => onFlowingChange(!isFlowing)}
      >
        <span aria-hidden="true">{isFlowing ? '⏸' : '▶'}</span>{' '}
        {isFlowing ? 'Stop flow' : 'Play flow'}
      </button>

      <button
        type="button"
        className={styles.focus}
        aria-pressed={connectMode}
        title={
          connectSourceLabel
            ? `Connect from ${connectSourceLabel}: choose a target`
            : connectMode
              ? 'Exit canvas connection mode'
              : 'Choose any two groups, nodes, or subnodes from the whole map'
        }
        onClick={() => {
          if (connectMode) onConnectModeChange(false);
          else onOpenConnectionBuilder();
        }}
      >
        <span aria-hidden="true">↗</span>{' '}
        {connectSourceLabel ? 'Choose target' : connectMode ? 'Exit add' : 'Add relationship'}
      </button>

      <label className={styles.scopePicker}>
        <span>View</span>
        <select
          value={connectionScope}
          aria-label="Connection level view"
          title="Show only one hierarchy pairing and its endpoints"
          onChange={(event) => onConnectionScopeChange(event.target.value as ConnectionScope)}
        >
          {CONNECTION_SCOPES.map((scope) => (
            <option key={scope} value={scope}>{CONNECTION_SCOPE_LABELS[scope]}</option>
          ))}
        </select>
      </label>

      {onFindConnections ? (
        <button
          type="button"
          className={styles.discover}
          title={`Ask the selected local AI to find ${CONNECTION_SCOPE_LABELS[connectionScope].toLowerCase()} cross-connections. Every change is reviewed.`}
          onClick={() => onFindConnections(connectionScope)}
        >
          <span aria-hidden="true">✦</span> Find relationships
        </button>
      ) : null}

      <details className={styles.panel}>
        <summary>
          Filters{filtered ? <span className={styles.activeDot} aria-label="Filters active" /> : null}
        </summary>
        <div className={styles.menu}>
          <div className={styles.menuHeader}>
            <strong>Show on canvas</strong>
            <button type="button" onClick={onReset}>Reset</button>
          </div>
          <fieldset>
            <legend>Node types</legend>
            <div className={styles.grid}>
              {NODE_KINDS.map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={nodeKinds.has(kind)}
                    onChange={() => onToggleNodeKind(kind)}
                  />
                  <span
                    className={styles.glyph}
                    style={{ color: CATEGORY_COLORS[kind] }}
                    aria-hidden="true"
                  >
                    {CATEGORY_GLYPHS[kind]}
                  </span>
                  {readable(kind)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Relationships</legend>
            <div className={styles.grid}>
              {RELATION_KINDS.map((relation) => (
                <label key={relation}>
                  <input
                    type="checkbox"
                    checked={relations.has(relation)}
                    onChange={() => onToggleRelation(relation)}
                  />
                  <span
                    className={styles.swatch}
                    style={{ background: RELATION_COLORS[relation] }}
                    aria-hidden="true"
                  />
                  {readable(relation)}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </details>

      <details className={styles.panel}>
        <summary>Legend</summary>
        <div className={`${styles.menu} ${styles.legend}`}>
          {NODE_KINDS.map((kind) => (
            <span key={kind}>
              <i
                aria-hidden="true"
                style={({ '--bd-entity-color': CATEGORY_COLORS[kind] } as CSSProperties)}
              >
                {CATEGORY_GLYPHS[kind]}
              </i>
              {readable(kind)}
            </span>
          ))}
          <small>Ring colour and shape identify category. Selection is cyan; AI findings are lime.</small>

          {presentRelations.length > 0 ? (
            <>
              <strong className={styles.legendHeading}>Relationships on this map</strong>
              {presentRelations.map((relation) => (
                <span key={relation}>
                  <i
                    aria-hidden="true"
                    className={styles.legendEdge}
                    style={{ background: RELATION_COLORS[relation] }}
                  />
                  {readable(relation)}
                </span>
              ))}
            </>
          ) : null}
        </div>
      </details>
    </div>
  );
}
