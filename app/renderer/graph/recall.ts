/**
 * Which concepts a streaming answer has just recalled.
 *
 * As Claude writes, every mention of a concept in the graph fires that node —
 * a green pulse that decays. Watching a chain of them light up is the point:
 * it shows the path the answer actually took through the author's own
 * framework, rather than presenting the reply as if it came from nowhere.
 *
 * Pure and DOM-free, so the matching and the decay are both testable.
 */

import type { GraphNode } from '../../../shared/types/graph';

/** How long a fired node stays lit. Long enough to see, short enough to read as a pulse. */
export const RECALL_PULSE_MS = 1400;

/** A node fires at most this often, so a repeated term does not strobe. */
export const RECALL_REFRACTORY_MS = 600;

/** Shortest label worth matching. Below this, false positives swamp the signal. */
const MIN_LABEL_LENGTH = 3;

export interface RecallEvent {
  nodeId: string;
  /** Timestamp the node last fired. */
  firedAt: number;
}

/** nodeId -> when it last fired. */
export type RecallState = ReadonlyMap<string, number>;

export const EMPTY_RECALL: RecallState = new Map();

/**
 * Index of matchable labels, longest first.
 *
 * Longest-first matters: with "power" and "power market" both in the graph,
 * scanning shortest-first would fire "power" on every occurrence of the longer
 * term and never fire the specific one.
 */
export interface RecallIndex {
  readonly entries: readonly { readonly nodeId: string; readonly needle: string }[];
}

export function buildRecallIndex(nodes: readonly GraphNode[]): RecallIndex {
  const entries = nodes
    .filter((node) => node.label.trim().length >= MIN_LABEL_LENGTH)
    .map((node) => ({ nodeId: node.id, needle: node.label.trim().toLowerCase() }))
    .sort((a, b) => b.needle.length - a.needle.length);

  return { entries };
}

/**
 * Nodes named anywhere in `text`.
 *
 * Matches on a word boundary so "ISO" does not fire inside "isolation". The
 * whole text is rescanned each time rather than only the newest delta: a
 * concept's name routinely arrives split across two stream chunks, and a
 * delta-only scan misses exactly those.
 */
export function findRecalled(index: RecallIndex, text: string): string[] {
  if (text.length === 0) return [];
  const haystack = text.toLowerCase();
  const found: string[] = [];

  for (const entry of index.entries) {
    if (containsWord(haystack, entry.needle)) found.push(entry.nodeId);
  }
  return found;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

function containsWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;

    const before = at === 0 ? undefined : haystack[at - 1];
    const after = haystack[at + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

/**
 * Fire the given nodes, respecting the refractory period.
 *
 * Returns the same map when nothing changed, so a render can bail out cheaply
 * on the many stream chunks that mention no concept at all.
 */
export function fireNodes(
  state: RecallState,
  nodeIds: readonly string[],
  now: number,
): RecallState {
  let next: Map<string, number> | null = null;

  for (const nodeId of nodeIds) {
    const last = state.get(nodeId);
    if (last !== undefined && now - last < RECALL_REFRACTORY_MS) continue;
    next ??= new Map(state);
    next.set(nodeId, now);
  }
  return next ?? state;
}

/** Drop nodes whose pulse has fully decayed. */
export function pruneRecall(state: RecallState, now: number): RecallState {
  let next: Map<string, number> | null = null;

  for (const [nodeId, firedAt] of state) {
    if (now - firedAt < RECALL_PULSE_MS) continue;
    next ??= new Map(state);
    next.delete(nodeId);
  }
  return next ?? state;
}

/**
 * Pulse strength for a node, 1 at the moment of firing decaying to 0.
 *
 * Eased rather than linear so the flash reads as a discharge — bright
 * immediately, fading off — instead of a uniform dimmer.
 */
export function recallIntensity(state: RecallState, nodeId: string, now: number): number {
  const firedAt = state.get(nodeId);
  if (firedAt === undefined) return 0;

  const elapsed = now - firedAt;
  if (elapsed < 0 || elapsed >= RECALL_PULSE_MS) return 0;

  const remaining = 1 - elapsed / RECALL_PULSE_MS;
  return remaining * remaining;
}
