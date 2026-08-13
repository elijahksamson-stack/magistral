/** A searchable manual linker for every group, node, and authored subnode. */

import { useMemo, useState } from 'react';

import {
  CONNECTION_SCOPES,
  CONNECTION_SCOPE_LABELS,
  connectionScopeFor,
  endpointKindsForScope,
  type ConnectionEndpoint,
  type ConnectionScope,
} from './connectionTypes';
import styles from './ConnectionBuilder.module.css';

export interface ConnectionBuilderProps {
  endpoints: readonly ConnectionEndpoint[];
  initialScope: ConnectionScope;
  onConnect: (sourceId: string, targetId: string) => void;
  onPickOnCanvas: () => void;
  onCancel: () => void;
}

function optionLabel(endpoint: ConnectionEndpoint): string {
  if (endpoint.kind !== 'subnode' || endpoint.parentLabels.length === 0) {
    return `${endpoint.label} — ${endpoint.kind}`;
  }
  return `${endpoint.label} — subnode under ${endpoint.parentLabels.join(' / ')}`;
}

function filterEndpoints(
  endpoints: readonly ConnectionEndpoint[],
  scope: ConnectionScope,
  query: string,
): ConnectionEndpoint[] {
  const allowed = endpointKindsForScope(scope);
  const needle = query.trim().toLocaleLowerCase();
  return endpoints.filter((endpoint) => {
    if (!allowed.has(endpoint.kind)) return false;
    if (!needle) return true;
    return optionLabel(endpoint).toLocaleLowerCase().includes(needle);
  });
}

interface EndpointColumnProps {
  title: string;
  query: string;
  selectedId: string;
  endpoints: readonly ConnectionEndpoint[];
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
}

function EndpointColumn({
  title,
  query,
  selectedId,
  endpoints,
  onQuery,
  onSelect,
}: EndpointColumnProps): React.JSX.Element {
  return (
    <div className={styles.endpointColumn}>
      <label className={styles.endpointTitle}>
        {title}
        <input
          type="search"
          value={query}
          placeholder="Search groups, nodes, subnodes…"
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <select
        className={styles.endpointList}
        size={8}
        value={selectedId}
        aria-label={`${title} endpoint`}
        onChange={(event) => onSelect(event.target.value)}
      >
        {endpoints.map((endpoint) => (
          <option key={endpoint.id} value={endpoint.id}>
            {optionLabel(endpoint)}
          </option>
        ))}
      </select>
      <small>{endpoints.length} available</small>
    </div>
  );
}

export default function ConnectionBuilder({
  endpoints,
  initialScope,
  onConnect,
  onPickOnCanvas,
  onCancel,
}: ConnectionBuilderProps): React.JSX.Element {
  const [scope, setScope] = useState(initialScope);
  const [sourceQuery, setSourceQuery] = useState('');
  const [targetQuery, setTargetQuery] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');

  const endpointById = useMemo(
    () => new Map(endpoints.map((endpoint) => [endpoint.id, endpoint] as const)),
    [endpoints],
  );
  const sourceOptions = useMemo(
    () => filterEndpoints(endpoints, scope, sourceQuery),
    [endpoints, scope, sourceQuery],
  );
  const targetOptions = useMemo(
    () => filterEndpoints(endpoints, scope, targetQuery),
    [endpoints, scope, targetQuery],
  );

  const source = endpointById.get(sourceId);
  const target = endpointById.get(targetId);
  const sameEndpoint = Boolean(source && target && source.id === target.id);
  const pairScope = source && target ? connectionScopeFor(source.kind, target.kind) : null;
  const validPair = Boolean(
    source && target && !sameEndpoint && (scope === 'all' || pairScope === scope),
  );

  const pairHint = sameEndpoint
    ? 'Choose two different endpoints.'
    : source && target && scope !== 'all' && pairScope !== scope
      ? `That pair is ${pairScope ? CONNECTION_SCOPE_LABELS[pairScope] : 'not available'}, not ${CONNECTION_SCOPE_LABELS[scope]}.`
      : 'Direction runs from the left endpoint to the right endpoint.';

  return (
    <>
      <div className={styles.scrim} onPointerDown={onCancel} />
      <section className={styles.builder} role="dialog" aria-label="Add a relationship">
        <header className={styles.header}>
          <div>
            <p>MANUAL RELATIONSHIP</p>
            <h2>Choose any two endpoints</h2>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close connection builder">✕</button>
        </header>

        <label className={styles.scopeLabel}>
          Connection level
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as ConnectionScope);
              setSourceId('');
              setTargetId('');
              setSourceQuery('');
              setTargetQuery('');
            }}
          >
            {CONNECTION_SCOPES.map((option) => (
              <option key={option} value={option}>{CONNECTION_SCOPE_LABELS[option]}</option>
            ))}
          </select>
        </label>

        <div className={styles.endpoints}>
          <EndpointColumn
            title="From"
            query={sourceQuery}
            selectedId={sourceId}
            endpoints={sourceOptions}
            onQuery={setSourceQuery}
            onSelect={setSourceId}
          />
          <span className={styles.arrow} aria-hidden="true">→</span>
          <EndpointColumn
            title="To"
            query={targetQuery}
            selectedId={targetId}
            endpoints={targetOptions}
            onQuery={setTargetQuery}
            onSelect={setTargetId}
          />
        </div>

        <p className={styles.hint}>{pairHint}</p>
        <footer className={styles.actions}>
          <button type="button" className={styles.canvasButton} onClick={onPickOnCanvas}>
            Pick on canvas instead
          </button>
          <button
            type="button"
            className={styles.nextButton}
            disabled={!validPair}
            onClick={() => {
              if (source && target && validPair) onConnect(source.id, target.id);
            }}
          >
            Choose relationship →
          </button>
        </footer>
      </section>
    </>
  );
}
