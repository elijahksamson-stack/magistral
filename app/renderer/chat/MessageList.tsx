/**
 * The chat transcript.
 *
 * It renders whatever RenderedTurn[] it is handed and reports label clicks
 * upward. The only local state is brief feedback from the copy button.
 */

import { useEffect, useRef, useState, type JSX } from 'react';

import type { ClaudeUsage } from '../../../shared/types/claude';
import type { ChatTurnStatus, RenderedTurn } from './chatState';
import type { EntityPresentation } from '../shared/entityPresentation';
import Markdown from './markdown';
import styles from './MessageList.module.css';

export interface MessageListProps {
  turns: readonly RenderedTurn[];
  /** Node labels that should become links inside assistant text. */
  labels: readonly string[];
  entitiesByLabel?: ReadonlyMap<string, EntityPresentation>;
  onSelectLabel?: (label: string) => void;
  onHoverLabel?: (label: string | null) => void;
  relationships?: readonly RelationshipTraceItem[];
  /** Rendered when the transcript is empty. */
  emptyState?: JSX.Element;
  dismissedErrorIds?: ReadonlySet<string>;
  onRetry?: (turn: RenderedTurn) => void;
  onSwitchProvider?: (turn: RenderedTurn) => void;
  onDismissError?: (turnId: string) => void;
  /**
   * Turn this answer into proposed concepts, subnodes and relationships.
   *
   * The answer that says "your graph has no node for X" is the moment the
   * author most wants X on the map, and until now that meant leaving the
   * conversation, writing a cell by hand, and retyping what they just read.
   */
  onAddToMap?: (turn: RenderedTurn) => void;
  /** True while a proposal is already being drafted, so this cannot double-fire. */
  isAddingToMap?: boolean;
}

export interface RelationshipTraceItem {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  readonly note?: string;
}

const STATUS_LABELS: Record<ChatTurnStatus, string> = {
  pending: 'Waiting for the bridge',
  streaming: 'Thinking',
  complete: '',
  interrupted: 'Stopped before finishing',
  failed: 'Failed',
};

/**
 * Tokens only. `usage.notionalCostUsd` is a token weighting on a subscription,
 * not money leaving an account, so it is never shown as a price.
 */
function formatTokens(usage: ClaudeUsage): string {
  const cached = usage.cacheReadTokens + usage.cacheCreationTokens;
  const parts = [
    `${usage.inputTokens.toLocaleString()} in`,
    `${usage.outputTokens.toLocaleString()} out`,
  ];
  if (cached > 0) parts.push(`${cached.toLocaleString()} cached`);
  return parts.join(' · ');
}

function friendlyError(error: string): string {
  const clean = error.replace(/\s*\([A-Z_]+\)\s*$/, '').trim();
  if (/session limit|allowance|credits|maxed|rate limit/i.test(clean)) {
    return `${clean} You can retry with another detected local CLI.`;
  }
  if (/not found|ENOENT|not authenticated|logged in/i.test(clean)) {
    return `${clean} Check the CLI installation or switch providers.`;
  }
  return clean;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** Legacy fallback for Electron builds where the async Clipboard API is absent. */
function copyWithHiddenSelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  try {
    field.select();
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
}

async function copyResponse(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Packaged Electron builds can expose this API while denying the call.
      // The synchronous fallback below still keeps copying to one user click.
    }
  }
  if (!copyWithHiddenSelection(text)) throw new Error('Clipboard copy was refused');
}

function CopyResponseButton({ text }: { text: string }): JSX.Element {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy';

  return (
    <button
      type="button"
      className={state === 'copied' ? styles.copyCopied : styles.copy}
      aria-label={state === 'copied' ? 'Response copied' : 'Copy response'}
      title={state === 'failed' ? 'Could not access the clipboard' : 'Copy response'}
      onClick={() => {
        void copyResponse(text)
          .then(() => setState('copied'))
          .catch(() => setState('failed'))
          .finally(() => {
            if (resetTimer.current) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setState('idle'), 1800);
          });
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.25" y="5.25" width="8" height="8" rx="1.25" />
        <path d="M3.75 10.75h-1A1.25 1.25 0 0 1 1.5 9.5v-7A1.25 1.25 0 0 1 2.75 1.25h7A1.25 1.25 0 0 1 11 2.5v1" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

function AssistantBody({
  turn,
  labels,
  entitiesByLabel,
  onSelectLabel,
  onHoverLabel,
  isErrorDismissed,
  onRetry,
  onSwitchProvider,
  onDismissError,
}: {
  turn: RenderedTurn;
  labels: readonly string[];
  entitiesByLabel?: ReadonlyMap<string, EntityPresentation> | undefined;
  onSelectLabel?: ((label: string) => void) | undefined;
  onHoverLabel?: ((label: string | null) => void) | undefined;
  isErrorDismissed: boolean;
  onRetry?: ((turn: RenderedTurn) => void) | undefined;
  onSwitchProvider?: ((turn: RenderedTurn) => void) | undefined;
  onDismissError?: ((turnId: string) => void) | undefined;
}): JSX.Element {
  if (turn.error) {
    if (isErrorDismissed) return <p className={styles.placeholder}>Error dismissed</p>;
    return (
      <div className={styles.error} role="alert">
        <p>{friendlyError(turn.error)}</p>
        <div className={styles.errorActions}>
          {onRetry ? <button type="button" onClick={() => onRetry(turn)}>Retry</button> : null}
          {onSwitchProvider ? (
            <button type="button" onClick={() => onSwitchProvider(turn)}>Switch provider &amp; retry</button>
          ) : null}
          {onDismissError ? (
            <button type="button" onClick={() => onDismissError(turn.id)}>Dismiss</button>
          ) : null}
        </div>
      </div>
    );
  }

  if (turn.text.length === 0) {
    return <p className={styles.placeholder}>{STATUS_LABELS[turn.status] || 'No response'}</p>;
  }

  return (
    <div className={styles.body}>
      <Markdown
        text={turn.text}
        labels={labels}
        entitiesByLabel={entitiesByLabel}
        onSelectLabel={onSelectLabel}
        onHoverLabel={onHoverLabel}
      />
    </div>
  );
}

function relationshipTracesFor(
  text: string,
  relationships: readonly RelationshipTraceItem[],
): readonly RelationshipTraceItem[] {
  const normalized = text.toLocaleLowerCase();
  return relationships.filter((relationship) =>
    normalized.includes(relationship.source.toLocaleLowerCase()) &&
    normalized.includes(relationship.target.toLocaleLowerCase()),
  ).slice(0, 4);
}

function RelationshipTrace({
  text,
  relationships,
  onSelectLabel,
  onHoverLabel,
}: {
  text: string;
  relationships: readonly RelationshipTraceItem[];
  onSelectLabel?: ((label: string) => void) | undefined;
  onHoverLabel?: ((label: string | null) => void) | undefined;
}): JSX.Element | null {
  const traces = relationshipTracesFor(text, relationships);
  if (traces.length === 0) return null;
  const entityButton = (label: string): JSX.Element => (
    <button
      type="button"
      onClick={() => onSelectLabel?.(label)}
      onMouseEnter={() => onHoverLabel?.(label)}
      onMouseLeave={() => onHoverLabel?.(null)}
    >
      {label}
    </button>
  );
  return (
    <details className={styles.trace}>
      <summary>Graph trace · {traces.length} known relationship{traces.length === 1 ? '' : 's'}</summary>
      <ol>
        {traces.map((trace) => (
          <li key={trace.id}>
            <span>{entityButton(trace.source)}</span>
            <code>{trace.relation.replaceAll('_', ' ')}</code>
            <span>{entityButton(trace.target)}</span>
            {trace.note ? <p>{trace.note}</p> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function Turn({
  turn,
  labels,
  entitiesByLabel,
  onSelectLabel,
  onHoverLabel,
  relationships,
  isErrorDismissed,
  onRetry,
  onSwitchProvider,
  onDismissError,
  onAddToMap,
  isAddingToMap,
}: {
  turn: RenderedTurn;
  labels: readonly string[];
  entitiesByLabel?: ReadonlyMap<string, EntityPresentation> | undefined;
  onSelectLabel?: ((label: string) => void) | undefined;
  onHoverLabel?: ((label: string | null) => void) | undefined;
  relationships: readonly RelationshipTraceItem[];
  isErrorDismissed: boolean;
  onRetry?: ((turn: RenderedTurn) => void) | undefined;
  onSwitchProvider?: ((turn: RenderedTurn) => void) | undefined;
  onDismissError?: ((turnId: string) => void) | undefined;
  onAddToMap?: ((turn: RenderedTurn) => void) | undefined;
  isAddingToMap?: boolean | undefined;
}): JSX.Element {
  const statusLabel = STATUS_LABELS[turn.status];

  return (
    <li className={styles.turn} data-turn-id={turn.id} data-status={turn.status}>
      <article className={styles.userMessage}>
        <p className={styles.prompt}>{turn.prompt}</p>
      </article>

      <article className={styles.assistantMessage}>
        <header className={styles.answerHeader}>
          <span>{turn.provider === 'codex' ? 'ChatGPT' : turn.provider === 'claude' ? 'Claude' : 'Local LLM'}</span>
          <time dateTime={turn.askedAt}>
            {new Date(turn.askedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </time>
        </header>
        <AssistantBody
          turn={turn}
          labels={labels}
          entitiesByLabel={entitiesByLabel}
          onSelectLabel={onSelectLabel}
          onHoverLabel={onHoverLabel}
          isErrorDismissed={isErrorDismissed}
          onRetry={onRetry}
          onSwitchProvider={onSwitchProvider}
          onDismissError={onDismissError}
        />
        <RelationshipTrace
          text={turn.text}
          relationships={relationships}
          onSelectLabel={onSelectLabel}
          onHoverLabel={onHoverLabel}
        />

        <footer className={styles.meta}>
          {statusLabel ? (
            <span className={styles.status} data-status={turn.status}>
              {statusLabel}
            </span>
          ) : null}
          {turn.usage ? (
            <span className={styles.usage} title="Tokens drawn from the subscription allowance">
              {formatTokens(turn.usage)}
            </span>
          ) : null}
          {turn.text.length > 0 && !turn.error && turn.status !== 'pending' && turn.status !== 'streaming' ? (
            <>
              <CopyResponseButton text={turn.text} />
              {onAddToMap ? (
                <button
                  type="button"
                  className={styles.addToMap}
                  disabled={isAddingToMap}
                  onClick={() => onAddToMap(turn)}
                  title="Propose the concepts this answer names, with their descriptions and connections. Nothing is added until you approve it."
                >
                  {isAddingToMap ? 'Reading the answer…' : '✦ Add to map'}
                </button>
              ) : null}
            </>
          ) : null}
        </footer>
      </article>
    </li>
  );
}

export default function MessageList({
  turns,
  labels,
  entitiesByLabel,
  onSelectLabel,
  onHoverLabel,
  relationships = [],
  emptyState,
  dismissedErrorIds = new Set<string>(),
  onRetry,
  onSwitchProvider,
  onDismissError,
  onAddToMap,
  isAddingToMap,
}: MessageListProps): JSX.Element {
  if (turns.length === 0) {
    return <div className={styles.empty}>{emptyState ?? null}</div>;
  }

  return (
    <ol className={styles.list} data-testid="message-list">
      {turns.map((turn) => (
        <Turn
          key={turn.id}
          turn={turn}
          labels={labels}
          entitiesByLabel={entitiesByLabel}
          onSelectLabel={onSelectLabel}
          onHoverLabel={onHoverLabel}
          relationships={relationships}
          isErrorDismissed={dismissedErrorIds.has(turn.id)}
          onRetry={onRetry}
          onSwitchProvider={onSwitchProvider}
          onDismissError={onDismissError}
          onAddToMap={onAddToMap}
          isAddingToMap={isAddingToMap}
        />
      ))}
    </ol>
  );
}
