/**
 * Autocomplete source logic for `[[`.
 *
 * Suggesting EXISTING node labels is what stops the graph fragmenting into
 * near-duplicate concepts ("binding constraint" vs "the binding constraints").
 * The core dedups on normalizedLabel, so a suggestion accepted here collapses
 * onto the node that already exists rather than minting a new one.
 *
 * Matching is deliberately forgiving. A strict prefix match only helps an
 * author who already remembers the exact label; the fragmentation this exists
 * to prevent happens precisely when they do not. So an abbreviation
 * ("bc" -> "Binding Constraint") and a typo ("Accsdounting" -> "Accounting")
 * both have to surface the existing node.
 *
 * Pure — no CodeMirror. `wikilink-complete.ts` wraps it in a CompletionSource.
 */

import { normalizeLabel } from './wikilink';

export const SUGGESTION_LIMIT = 8;

/** Match tiers, best first. Lower sorts higher. */
const SCORE_PREFIX = 0;
const SCORE_SUBSTRING = 1;
const SCORE_SUBSEQUENCE = 2;
const SCORE_TYPO = 3;
const SCORE_NONE = -1;

/**
 * Typo tolerance scales with length so short words stay strict — at 1 edit on a
 * 3-letter query, "cat" would match "car" and the suggestions become noise.
 */
const MIN_LENGTH_FOR_TYPO_MATCH = 5;
const MAX_EDIT_DISTANCE_RATIO = 0.34;

/** A candidate label plus how heavily the graph already leans on it. */
export interface LabelCandidate {
  label: string;
  /** Cells + edges referencing this node. Shown so the author can prefer hubs. */
  linkCount: number;
}

export interface LabelSuggestion extends LabelCandidate {
  /** True when this is the "create a new concept" entry, not an existing node. */
  isNew: boolean;
}

/** An in-progress `[[query` the caret currently sits inside. */
export interface WikilinkQuery {
  /** Document offset of the first character after `[[`. */
  from: number;
  /** Text typed since `[[`. May be empty. */
  query: string;
}

const OPEN_BRACKETS = '[[';
const CLOSE_BRACKETS = ']]';

/**
 * Locate an unterminated `[[` before the caret.
 *
 * Returns null when the caret is not inside a link body — because there is no
 * `[[`, because it was already closed, or because a newline intervened (a link
 * never spans lines, matching `parseWikilinks`).
 */
export function findWikilinkQuery(textBeforeCursor: string): WikilinkQuery | null {
  const openIndex = textBeforeCursor.lastIndexOf(OPEN_BRACKETS);
  if (openIndex === -1) return null;

  const query = textBeforeCursor.slice(openIndex + OPEN_BRACKETS.length);
  if (query.includes(CLOSE_BRACKETS) || query.includes('\n')) return null;
  if (query.includes('[')) return null;

  return { from: openIndex + OPEN_BRACKETS.length, query };
}

/** True when every char of `query` appears in `label`, in order. */
function isSubsequence(label: string, query: string): boolean {
  let cursor = 0;
  for (const char of label) {
    if (char === query[cursor]) cursor += 1;
    if (cursor === query.length) return true;
  }
  return query.length === 0;
}

/**
 * Levenshtein distance, abandoned early once it exceeds `max`.
 *
 * Two rolling rows rather than a full matrix — labels are short, but this runs
 * on every keystroke against every node in the graph.
 */
function editDistanceWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowBest = current[0] as number;

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      const best = Math.min(substitution, deletion, insertion);
      current[j] = best;
      if (best < rowBest) rowBest = best;
    }
    if (rowBest > max) return max + 1;

    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] as number;
}

function typoTolerance(queryLength: number): number {
  if (queryLength < MIN_LENGTH_FOR_TYPO_MATCH) return 0;
  return Math.max(1, Math.floor(queryLength * MAX_EDIT_DISTANCE_RATIO));
}

/** Match tier for a label against a query, or SCORE_NONE when unrelated. */
function scoreLabel(normalizedLabel: string, normalizedQuery: string): number {
  if (normalizedQuery.length === 0) return SCORE_PREFIX;
  if (normalizedLabel.startsWith(normalizedQuery)) return SCORE_PREFIX;
  if (normalizedLabel.includes(normalizedQuery)) return SCORE_SUBSTRING;
  if (isSubsequence(normalizedLabel, normalizedQuery)) return SCORE_SUBSEQUENCE;

  const tolerance = typoTolerance(normalizedQuery.length);
  if (tolerance > 0 && editDistanceWithin(normalizedLabel, normalizedQuery, tolerance) <= tolerance) {
    return SCORE_TYPO;
  }
  return SCORE_NONE;
}

/**
 * Existing labels matching `query`, best first, deduped by normalized form.
 *
 * Within a tier, the more-linked node wins — the author is more likely to mean
 * the concept the graph already leans on. An empty query returns the caller's
 * order untouched (they hand these over highest-centrality first).
 */
export function rankLabelSuggestions(
  query: string,
  candidates: readonly LabelCandidate[],
  limit: number = SUGGESTION_LIMIT,
): readonly LabelCandidate[] {
  const normalizedQuery = normalizeLabel(query);
  const seen = new Set<string>();
  const scored: { candidate: LabelCandidate; score: number; index: number }[] = [];

  candidates.forEach((candidate, index) => {
    const normalized = normalizeLabel(candidate.label);
    if (normalized.length === 0 || seen.has(normalized)) return;

    const score = scoreLabel(normalized, normalizedQuery);
    if (score === SCORE_NONE) return;

    seen.add(normalized);
    scored.push({ candidate, score, index });
  });

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.candidate.linkCount !== b.candidate.linkCount) {
        return b.candidate.linkCount - a.candidate.linkCount;
      }
      return a.index - b.index;
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.candidate);
}

/**
 * Suggestions to show, with a trailing "create it" entry when the query does
 * not already name an existing node.
 *
 * That entry is the point: it makes minting a new concept a visible choice
 * rather than the silent default of typing on past the popup. Every stranded
 * near-duplicate in a graph got there because nothing marked that moment.
 */
export function buildSuggestions(
  query: string,
  candidates: readonly LabelCandidate[],
  limit: number = SUGGESTION_LIMIT,
): readonly LabelSuggestion[] {
  const matches = rankLabelSuggestions(query, candidates, limit);
  const suggestions: LabelSuggestion[] = matches.map((candidate) => ({
    ...candidate,
    isNew: false,
  }));

  const trimmed = query.trim();
  if (trimmed.length === 0) return suggestions;

  const normalizedQuery = normalizeLabel(query);
  const alreadyExists = candidates.some(
    (candidate) => normalizeLabel(candidate.label) === normalizedQuery,
  );
  if (alreadyExists) return suggestions;

  return [...suggestions, { label: trimmed, linkCount: 0, isNew: true }];
}

/** What to insert when a suggestion is accepted, given the text after the caret. */
export interface WikilinkInsertion {
  insert: string;
  /** Where the caret lands, relative to the start of `insert`. */
  cursorOffset: number;
}

/**
 * Close the brackets for the author, unless they are already there — otherwise
 * accepting a completion inside `[[|]]` would produce `[[label]]]]`.
 */
export function buildWikilinkInsertion(
  label: string,
  textAfterCursor: string,
): WikilinkInsertion {
  const hasClosingBrackets = textAfterCursor.startsWith(CLOSE_BRACKETS);
  if (hasClosingBrackets) {
    return { insert: label, cursorOffset: label.length + CLOSE_BRACKETS.length };
  }

  const insert = `${label}${CLOSE_BRACKETS}`;
  return { insert, cursorOffset: insert.length };
}
