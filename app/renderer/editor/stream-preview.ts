/**
 * How a completed ✦ run becomes (or fails to become) new cell text.
 *
 * The rule this module exists to enforce: nothing Claude produced is ever
 * written back without an explicit Accept. An unrequested overwrite of the
 * author's thinking is the worst failure this app can have, so the composition
 * step is pure, isolated, and tested.
 */

import type { CellAction } from '../../../shared/types/claude';

/** What Accept does with the streamed text. */
export type MergeMode =
  /** Streamed text stands in for the cell. */
  | 'replace'
  /** Streamed text is added after the cell's existing prose. */
  | 'append'
  /** Streamed text is added as a blockquote, leaving the prose untouched. */
  | 'append-quote'
  /**
   * Not prose at all. No action uses this any more — `extract-concepts` was
   * the only one, and it is gone. Kept so the type still describes the shape
   * of the decision rather than pretending there was never a third option.
   */
  | 'structured';

/**
 * `critique` appends rather than replaces on purpose: an attack on the
 * reasoning is a margin note, not a rewrite. Replacing the argument with its
 * own critique would destroy the thing being critiqued.
 */
export const CELL_ACTION_MERGE_MODES: Record<CellAction, MergeMode> = {
  enhance: 'replace',
  continue: 'append',
  critique: 'append-quote',
  distill: 'replace',
  // The cell is created empty for the import, so there is nothing to preserve.
  'distill-import': 'replace',
};

const PARAGRAPH_BREAK = '\n\n';
const QUOTE_PREFIX = '> ';

export function mergeModeFor(action: CellAction): MergeMode {
  return CELL_ACTION_MERGE_MODES[action];
}

function toBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '>' : `${QUOTE_PREFIX}${line}`))
    .join('\n');
}

function appendBlock(base: string, block: string): string {
  const trimmedBase = base.trimEnd();
  if (trimmedBase.length === 0) return block;
  return `${trimmedBase}${PARAGRAPH_BREAK}${block}`;
}

export interface CellPreview {
  action: CellAction;
  /** The cell's markdown at the moment the run started. */
  baseMarkdown: string;
  /** Everything streamed back so far. */
  streamedText: string;
}

/**
 * The markdown the cell would hold if the author accepted right now.
 *
 * Returns `baseMarkdown` unchanged for structured actions — those never touch
 * the prose.
 */
export function composeProposedMarkdown(preview: CellPreview): string {
  const streamed = preview.streamedText.trim();
  if (streamed.length === 0) return preview.baseMarkdown;

  switch (mergeModeFor(preview.action)) {
    case 'replace':
      return streamed;
    case 'append':
      return appendBlock(preview.baseMarkdown, streamed);
    case 'append-quote':
      return appendBlock(preview.baseMarkdown, toBlockquote(streamed));
    case 'structured':
      return preview.baseMarkdown;
  }
}

export type PreviewDecision = 'accept' | 'reject';

/**
 * The markdown to persist for a decision, or null when nothing should be
 * written — a rejection, a structured action, or a proposal identical to what
 * is already there.
 */
export function resolvePreview(
  decision: PreviewDecision,
  preview: CellPreview,
): string | null {
  if (decision === 'reject') return null;
  if (mergeModeFor(preview.action) === 'structured') return null;

  const proposed = composeProposedMarkdown(preview);
  return proposed === preview.baseMarkdown ? null : proposed;
}

/**
 * True when the run produced something worth showing an Accept button for.
 * Guards against offering a decision on an empty stream.
 */
export function hasPreviewableText(preview: CellPreview): boolean {
  return preview.streamedText.trim().length > 0;
}
