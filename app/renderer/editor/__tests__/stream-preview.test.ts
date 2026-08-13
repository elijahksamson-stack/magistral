/**
 * The single most important guarantee in this pane: streamed text reaches the
 * author's cell only through an explicit Accept, and Reject leaves the cell
 * byte-for-byte as it was.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CELL_ACTION_MERGE_MODES,
  composeProposedMarkdown,
  hasPreviewableText,
  mergeModeFor,
  resolvePreview,
  type CellPreview,
} from '../stream-preview';
import { CELL_ACTIONS } from '../../../../shared/types/claude';

const BASE = 'Capital is the binding constraint.';

function preview(overrides: Partial<CellPreview> = {}): CellPreview {
  return { action: 'enhance', baseMarkdown: BASE, streamedText: '', ...overrides };
}

describe('merge modes', () => {
  it('defines a mode for every action in the contract', () => {
    for (const action of CELL_ACTIONS) {
      expect(CELL_ACTION_MERGE_MODES[action]).toBeDefined();
    }
  });

  it('never lets a critique replace the argument it critiques', () => {
    expect(mergeModeFor('critique')).toBe('append-quote');
  });
});

describe('composeProposedMarkdown', () => {
  it('replaces the cell for enhance', () => {
    const proposed = composeProposedMarkdown(
      preview({ action: 'enhance', streamedText: 'Capital, not ideas, is the constraint.' }),
    );
    expect(proposed).toBe('Capital, not ideas, is the constraint.');
  });

  it('replaces the cell for distill', () => {
    const proposed = composeProposedMarkdown(
      preview({ action: 'distill', streamedText: 'Capital is the constraint.' }),
    );
    expect(proposed).toBe('Capital is the constraint.');
  });

  it('appends for continue, keeping the original paragraph', () => {
    const proposed = composeProposedMarkdown(
      preview({ action: 'continue', streamedText: 'Ideas are abundant.' }),
    );
    expect(proposed).toBe(`${BASE}\n\nIdeas are abundant.`);
  });

  it('appends a critique as a blockquote below the author text', () => {
    const proposed = composeProposedMarkdown(
      preview({ action: 'critique', streamedText: 'Weakest link:\n\nno base rate.' }),
    );

    expect(proposed).toBe(`${BASE}\n\n> Weakest link:\n>\n> no base rate.`);
    expect(proposed.startsWith(BASE)).toBe(true);
  });

  it('returns the base unchanged when nothing streamed back', () => {
    expect(composeProposedMarkdown(preview({ streamedText: '   \n  ' }))).toBe(BASE);
  });

  it('drops the leading blank line when the cell was empty', () => {
    const proposed = composeProposedMarkdown(
      preview({ action: 'continue', baseMarkdown: '', streamedText: 'First words.' }),
    );
    expect(proposed).toBe('First words.');
  });
});

describe('resolvePreview', () => {
  it('accept yields the composed markdown', () => {
    const state = preview({ streamedText: 'Sharper.' });
    expect(resolvePreview('accept', state)).toBe('Sharper.');
  });

  it('reject yields nothing, so the cell is never written', () => {
    const state = preview({ streamedText: 'Sharper.' });
    expect(resolvePreview('reject', state)).toBeNull();
  });

  it('accept yields nothing when the proposal equals the current text', () => {
    expect(resolvePreview('accept', preview({ streamedText: BASE }))).toBeNull();
  });

  it('does not mutate the preview it was given', () => {
    const state = preview({ streamedText: 'Sharper.' });
    const snapshot = { ...state };

    resolvePreview('accept', state);
    resolvePreview('reject', state);

    expect(state).toEqual(snapshot);
  });
});

describe('applying a decision to the store', () => {
  it('accept calls upsertCell once with the composed markdown', async () => {
    const upsertCell = vi.fn(async (_cellId: string, _markdown: string) => undefined);
    const state = preview({ action: 'continue', streamedText: 'Ideas are abundant.' });

    const next = resolvePreview('accept', state);
    if (next !== null) await upsertCell('cell-1', next);

    expect(upsertCell).toHaveBeenCalledTimes(1);
    expect(upsertCell).toHaveBeenCalledWith('cell-1', `${BASE}\n\nIdeas are abundant.`);
  });

  it('reject never calls upsertCell', async () => {
    const upsertCell = vi.fn(async (_cellId: string, _markdown: string) => undefined);
    const state = preview({ action: 'enhance', streamedText: 'A rewrite the author refused.' });

    const next = resolvePreview('reject', state);
    if (next !== null) await upsertCell('cell-1', next);

    expect(upsertCell).not.toHaveBeenCalled();
  });
});

describe('hasPreviewableText', () => {
  it('is false while the stream is still empty', () => {
    expect(hasPreviewableText(preview({ streamedText: '' }))).toBe(false);
    expect(hasPreviewableText(preview({ streamedText: '\n \t' }))).toBe(false);
  });

  it('is true once real text has arrived', () => {
    expect(hasPreviewableText(preview({ streamedText: 'a' }))).toBe(true);
  });
});
