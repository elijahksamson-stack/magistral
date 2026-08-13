/**
 * One cell's ✦ run: start, stream, decide.
 *
 * Holds the cell's markdown as it was when the run began, so the preview always
 * diffs against a stable base even if the stream takes a while. Nothing is
 * written back until `accept()` is called.
 */

import { useCallback, useMemo, useState } from 'react';
import type { CellAction, ClaudeUsage, SourceDocument } from '../../../shared/types/claude';
import type { Cell, ExtractionResult } from '../../../shared/types/graph';
import { useGraphStore } from '../shared/store';
import { useClaude } from '../shared/useClaude';
import { buildCellInvokeRequest } from './cell-request';
import { diffLines, summarizeDiff, type DiffLine, type DiffStats } from './diff';
import { getErrorMessage } from './errors';
import {
  composeProposedMarkdown,
  hasPreviewableText,
  resolvePreview,
  type CellPreview,
} from './stream-preview';

interface ActiveRun {
  requestId: string;
  action: CellAction;
  /** The cell's markdown at the instant the run started. */
  baseMarkdown: string;
}

export interface CellRunView {
  requestId: string;
  action: CellAction;
  isStreaming: boolean;
  packs: readonly string[];
  streamedText: string;
  usage: ClaudeUsage | null;
  /** A transport or CLI failure reported by the bridge. */
  error: string | null;
  preview: CellPreview;
  proposedMarkdown: string;
  diff: readonly DiffLine[];
  diffStats: DiffStats;
  canDecide: boolean;
}

export interface CellRunController {
  active: CellRunView | null;
  /** A failure raised by this pane, e.g. invoke or accept threw. */
  localError: string | null;
  /**
   * `liveMarkdown` is the editor's current document. Pass it whenever one is
   * available: `cell.markdown` lags by the upsert debounce, and running against
   * the lagged text would drop the author's last keystrokes on accept.
   */
  start(
    action: CellAction,
    selectionText: string,
    liveMarkdown?: string,
    sourceDocument?: SourceDocument,
  ): Promise<void>;
  cancelRun(): Promise<void>;
  /** Returns the markdown that was written, or null when nothing changed. */
  accept(): Promise<string | null>;
  reject(): void;
  dismissError(): void;
}


export function useCellRun(cell: Cell): CellRunController {
  const { graph, upsertCell } = useGraphStore();
  const { runs, invoke, cancel } = useClaude();
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const run = active === null ? undefined : runs[active.requestId];

  const view = useMemo<CellRunView | null>(() => {
    if (active === null) return null;

    const streamedText = run?.text ?? '';
    const isStreaming = run?.streaming ?? true;
    const preview: CellPreview = {
      action: active.action,
      baseMarkdown: active.baseMarkdown,
      streamedText,
    };

    const proposedMarkdown = composeProposedMarkdown(preview);
    const diff = diffLines(active.baseMarkdown, proposedMarkdown);

    return {
      requestId: active.requestId,
      action: active.action,
      isStreaming,
      packs: run?.packs ?? [],
      streamedText,
      usage: run?.usage ?? null,
      error: run?.error ?? null,
      preview,
      proposedMarkdown,
      diff,
      diffStats: summarizeDiff(diff),
      canDecide: !isStreaming && (run?.error ?? null) === null && hasPreviewableText(preview),
    };
  }, [active, run]);

  const start = useCallback(
    async (
      action: CellAction,
      selectionText: string,
      liveMarkdown?: string,
      sourceDocument?: SourceDocument,
    ): Promise<void> => {
      // One CLI process per cell at a time. Replacing `active` mid-stream would
      // orphan the running child: nothing would ever cancel it, and its output
      // would land on a requestId no component reads.
      if (view !== null && view.isStreaming) return;

      const baseMarkdown = liveMarkdown ?? cell.markdown;
      const source = baseMarkdown === cell.markdown ? cell : { ...cell, markdown: baseMarkdown };

      setLocalError(null);
      try {
        const requestId = await invoke(
          buildCellInvokeRequest({
            action,
            cell: source,
            selectionText,
            graph,
            ...(sourceDocument ? { sourceDocument } : {}),
          }),
        );
        setActive({ requestId, action, baseMarkdown });
      } catch (error: unknown) {
        setLocalError(getErrorMessage(error));
      }
    },
    [cell, graph, invoke, view],
  );

  const cancelRun = useCallback(async (): Promise<void> => {
    if (active === null) return;
    try {
      await cancel(active.requestId);
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error));
    }
  }, [active, cancel]);

  const reject = useCallback((): void => {
    setActive(null);
    setLocalError(null);
  }, []);

  const accept = useCallback(async (): Promise<string | null> => {
    if (view === null) return null;

    try {
      const nextMarkdown = resolvePreview('accept', view.preview);
      if (nextMarkdown === null) {
        setActive(null);
        return null;
      }

      await upsertCell(cell.id, nextMarkdown);
      setActive(null);
      return nextMarkdown;
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error));
      return null;
    }
  }, [cell.id, upsertCell, view]);

  const dismissError = useCallback((): void => setLocalError(null), []);

  return { active: view, localError, start, cancelRun, accept, reject, dismissError };
}
