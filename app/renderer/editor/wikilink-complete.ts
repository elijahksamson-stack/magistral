/**
 * `[[` autocomplete over the labels already in the graph.
 *
 * Offering what exists is the whole point: it pushes the author toward a shared
 * vocabulary, so the graph converges instead of fragmenting into a dozen
 * near-identical concepts the core cannot dedup.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  buildSuggestions,
  buildWikilinkInsertion,
  findWikilinkQuery,
  type LabelCandidate,
  type LabelSuggestion,
} from './wikilink-suggest';

/** A link body never spans lines, so this window is always more than enough. */
const QUERY_SCAN_WINDOW = 256;

/** Chars that may follow the caret and still be part of the closing brackets. */
const CLOSING_LOOKAHEAD = 2;

/** Keeps the popup open while the author is still typing the label. */
const VALID_FOR = /^[^[\]\n]*$/;

function applyCompletion(label: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    const lookaheadEnd = Math.min(view.state.doc.length, to + CLOSING_LOOKAHEAD);
    const textAfter = view.state.sliceDoc(to, lookaheadEnd);
    const { insert, cursorOffset } = buildWikilinkInsertion(label, textAfter);

    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + cursorOffset },
    });
  };
}

/**
 * Link count is surfaced as the completion's detail text so the author can see
 * which concept the graph already leans on — "Accounting · 7 links" is a much
 * stronger pull toward reuse than a bare label.
 */
function describe(suggestion: LabelSuggestion): string {
  if (suggestion.isNew) return 'new concept';
  if (suggestion.linkCount === 0) return 'unlinked';
  return suggestion.linkCount === 1 ? '1 link' : `${suggestion.linkCount} links`;
}

function toCompletion(suggestion: LabelSuggestion, index: number): Completion {
  return {
    label: suggestion.label,
    type: suggestion.isNew ? 'keyword' : 'variable',
    detail: describe(suggestion),
    // Preserve the caller's ordering (match tier, then link count) against
    // CodeMirror's own alphabetical sort.
    boost: -index,
    apply: applyCompletion(suggestion.label),
  };
}

/**
 * `getCandidates` is read at completion time, so the source never holds a stale
 * snapshot of the graph.
 */
export function createWikilinkCompletionSource(
  getCandidates: () => readonly LabelCandidate[],
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const scanStart = Math.max(0, context.pos - QUERY_SCAN_WINDOW);
    const textBefore = context.state.sliceDoc(scanStart, context.pos);

    const active = findWikilinkQuery(textBefore);
    if (active === null) return null;

    const suggestions = buildSuggestions(active.query, getCandidates());
    if (suggestions.length === 0) return null;

    return {
      from: scanStart + active.from,
      options: suggestions.map(toCompletion),
      validFor: VALID_FOR,
    };
  };
}

export function wikilinkCompletionExtension(
  getCandidates: () => readonly LabelCandidate[],
): Extension {
  return autocompletion({
    override: [createWikilinkCompletionSource(getCandidates)],
    icons: false,
    activateOnTyping: true,
  });
}
