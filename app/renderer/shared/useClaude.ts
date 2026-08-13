/**
 * Subscribes to the Claude stream and keeps one ClaudeRun per requestId.
 *
 * Runs are keyed rather than singular because the editor can have several ✦
 * actions in flight on different cells while the chat pane is also streaming.
 * Each caller keeps the requestId `invoke` returns and reads `runs[requestId]`.
 *
 * Consumed by app/renderer/editor and app/renderer/chat.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  CellInvokeRequest,
  DescribeInvokeRequest,
  ChatInvokeRequest,
  ClaudeStreamEvent,
  ClaudeUsage,
  MapCompletionRequest,
  CliProvider,
} from '../../../shared/types/claude';
import type { ValidatedCompletion } from '../../../shared/types/completion';
import { getApi, invoke, toMessage } from './api';

export interface ClaudeRun {
  requestId: string;
  streaming: boolean;
  text: string;
  error: string | null;
  usage: ClaudeUsage | null;
  packs: string[];
  // -- additive: the pane contract above is the minimum, not the ceiling ---
  sessionId: string | null;
  thinking: string;
  tools: string[];
  /** A "Complete the map" proposal, already validated. Never auto-applied. */
  completion: ValidatedCompletion | null;
  cancelled: boolean;
  /** The CLI that actually answered, including an automatic fallback. */
  provider: CliProvider | null;
}

export type ClaudeInvokeInput =
  | Omit<CellInvokeRequest, 'requestId'>
  | Omit<ChatInvokeRequest, 'requestId'>
  | Omit<MapCompletionRequest, 'requestId'>
  | Omit<DescribeInvokeRequest, 'requestId'>;

export interface UseClaude {
  runs: Record<string, ClaudeRun>;
  invoke(req: ClaudeInvokeInput): Promise<string>;
  cancel(requestId: string): Promise<void>;
}

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyRun(requestId: string): ClaudeRun {
  return {
    requestId,
    streaming: true,
    text: '',
    error: null,
    usage: null,
    packs: [],
    sessionId: null,
    thinking: '',
    tools: [],
    completion: null,
    cancelled: false,
    provider: null,
  };
}

/** Every branch returns a NEW run object; nothing here mutates in place. */
function reduce(run: ClaudeRun, event: ClaudeStreamEvent): ClaudeRun {
  switch (event.type) {
    case 'started':
      return {
        ...run,
        streaming: true,
        sessionId: event.sessionId || run.sessionId,
        provider: event.provider ?? run.provider,
      };
    case 'packs':
      return { ...run, packs: event.sections };
    case 'delta':
      return { ...run, text: run.text + event.text };
    case 'thinking':
      return { ...run, thinking: run.thinking + event.text };
    case 'tool':
      return run.tools.includes(event.name) ? run : { ...run, tools: [...run.tools, event.name] };
    case 'done':
      return {
        ...run,
        streaming: false,
        text: event.fullText || run.text,
        usage: event.usage,
        sessionId: event.sessionId || run.sessionId,
        completion: event.completion ?? null,
      };
    case 'error':
      return run.cancelled
        ? { ...run, streaming: false, error: null }
        : { ...run, streaming: false, error: `${event.message} (${event.code})` };
    case 'cancelled':
      return { ...run, streaming: false, cancelled: true };
    default:
      return run;
  }
}

/**
 * Run state lives OUTSIDE React, in one module-level store.
 *
 * It used to be `useState` inside this hook, which meant every component
 * calling it kept a private copy that died with the component. Switching from
 * Chat to Editor and back unmounted the pane, threw its runs away, and left
 * every turn reading as 'pending' — "Waiting for the bridge" forever, with the
 * Stop button stuck up because pending counts as busy. The process was fine
 * the whole time; only the UI's memory of it was gone.
 *
 * The stream subscription is likewise registered once, not per mount, so
 * events that arrive while no pane is mounted are still recorded.
 */
const store: { runs: Record<string, ClaudeRun> } = { runs: {} };
const listeners = new Set<() => void>();
let unsubscribeStream: (() => void) | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function applyEvent(event: ClaudeStreamEvent): void {
  const existing = store.runs[event.requestId] ?? emptyRun(event.requestId);
  store.runs = { ...store.runs, [event.requestId]: reduce(existing, event) };
  notify();
}

function patchRun(requestId: string, patch: Partial<ClaudeRun>): void {
  const existing = store.runs[requestId] ?? emptyRun(requestId);
  store.runs = { ...store.runs, [requestId]: { ...existing, ...patch } };
  notify();
}

/**
 * Forget every recorded run.
 *
 * Called when the open vault changes: a run belongs to the graph it was asked
 * about, and letting an answer for one graph land in another would attach it
 * to concepts it never saw.
 */
export function clearClaudeRuns(): void {
  if (Object.keys(store.runs).length === 0) return;
  store.runs = {};
  notify();
}

function ensureSubscribed(): void {
  if (unsubscribeStream) return;
  const api = window.braindump;
  if (!api) return;
  unsubscribeStream = api.on('claude:stream', applyEvent);
}

/**
 * Settle anything the UI believes is running that the bridge does not.
 *
 * The bridge is the authority on what is actually alive. Without this a run
 * lost to a crash, a reload, or a cancel the bridge had already forgotten
 * leaves its turn spinning with no way out.
 */
async function reconcileWithBridge(): Promise<void> {
  const api = window.braindump;
  if (!api) return;

  // Only runs that already existed when we ASKED can be judged by the answer.
  // The query is async, and a run started while it was in flight is obviously
  // not in a list compiled before it existed — settling it would cancel a turn
  // the author had only just sent.
  const asked = new Set(
    Object.entries(store.runs)
      .filter(([, run]) => run.streaming)
      .map(([requestId]) => requestId),
  );
  if (asked.size === 0) return;

  let active: readonly string[];
  try {
    ({ requestIds: active } = await api.invoke('claude:active', undefined));
  } catch {
    // If we cannot ask, leave state alone rather than falsely stopping a run.
    return;
  }

  const alive = new Set(active);
  let changed = false;
  const next = { ...store.runs };
  for (const requestId of asked) {
    const run = next[requestId];
    if (!run || !run.streaming || alive.has(requestId)) continue;
    next[requestId] = { ...run, streaming: false, cancelled: true };
    changed = true;
  }
  if (!changed) return;
  store.runs = next;
  notify();
}

export function useClaude(): UseClaude {
  const [runs, setRuns] = useState<Record<string, ClaudeRun>>(store.runs);

  useEffect(() => {
    ensureSubscribed();
    const listener = (): void => setRuns(store.runs);
    listeners.add(listener);
    // Adopt whatever arrived while this component was unmounted.
    listener();
    void reconcileWithBridge();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const start = useCallback(async (req: ClaudeInvokeInput): Promise<string> => {
    const requestId = newRequestId();
    ensureSubscribed();
    patchRun(requestId, { streaming: true });

    try {
      await invoke('claude:invoke', { ...req, requestId });
    } catch (cause: unknown) {
      patchRun(requestId, { streaming: false, error: toMessage(cause) });
    }
    return requestId;
  }, []);

  const cancel = useCallback(async (requestId: string): Promise<void> => {
    try {
      await getApi().invoke('claude:cancel', { requestId });
      // Settle immediately. The bridge also emits `cancelled` after the child
      // closes, but the UI should respond to Stop rather than wait for SIGTERM.
      patchRun(requestId, { streaming: false, cancelled: true, error: null });
    } catch (cause: unknown) {
      patchRun(requestId, { streaming: false, error: toMessage(cause) });
    }
  }, []);

  return { runs, invoke: start, cancel };
}
