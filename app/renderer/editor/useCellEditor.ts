/**
 * CodeMirror lifecycle for one cell, wrapped as a hook.
 *
 * The view is created once. Callbacks are read through a ref on every event, so
 * re-rendering the cell never tears down and rebuilds the editor — which would
 * lose the caret, the undo history and the completion state mid-sentence.
 */

import { useCallback, useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { EXTERNAL_UPDATE } from './editor-annotations';
import { createCellExtensions, type CellEditorCallbacks } from './editor-setup';

/**
 * Where the caret lands. A number is a document offset, used when the Editor is
 * following a concept in from the map: the cell is not the destination, the
 * line that names the concept is.
 */
export type FocusPosition = 'start' | 'end' | number;

/** Breathing room above a revealed heading, so it is not flush to the edge. */
const REVEAL_TOP_MARGIN_PX = 12;

export interface CellEditorHandle {
  /** Ref callback for the element the editor mounts into. */
  hostRef: (node: HTMLDivElement | null) => void;
  focus(position?: FocusPosition): void;
  /** The author's current selection, or '' when the caret is collapsed. */
  getSelectionText(): string;
  /**
   * The live document — including keystrokes still inside the debounce window
   * that the store has not seen yet. Returns null before the view exists.
   */
  getDocument(): string | null;
  /** Replace the document without emitting an onDocChanged callback. */
  setDocument(markdown: string): void;
}

export function useCellEditor(
  initialDoc: string,
  callbacks: CellEditorCallbacks,
): CellEditorHandle {
  const viewRef = useRef<EditorView | null>(null);
  const callbacksRef = useRef<CellEditorCallbacks>(callbacks);
  const initialDocRef = useRef<string>(initialDoc);

  callbacksRef.current = callbacks;

  /** Stable indirection: identity never changes, target is always current. */
  const forwardingRef = useRef<CellEditorCallbacks>({
    onDocChanged: (markdown) => callbacksRef.current.onDocChanged(markdown),
    onFocusChanged: (isFocused) => callbacksRef.current.onFocusChanged(isFocused),
    onOpenLink: (label) => callbacksRef.current.onOpenLink(label),
    onSparkle: () => callbacksRef.current.onSparkle(),
    onDeleteCell: () => callbacksRef.current.onDeleteCell(),
    onMergeIntoPrevious: () => callbacksRef.current.onMergeIntoPrevious(),
    getNodeLabels: () => callbacksRef.current.getNodeLabels(),
  });

  const hostRef = useCallback((node: HTMLDivElement | null): void => {
    if (node === null) {
      viewRef.current?.destroy();
      viewRef.current = null;
      return;
    }
    if (viewRef.current !== null) return;

    viewRef.current = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: initialDocRef.current,
        extensions: createCellExtensions(forwardingRef.current),
      }),
    });
  }, []);

  useEffect(
    () => () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    },
    [],
  );

  const focus = useCallback((position: FocusPosition = 'end'): void => {
    const view = viewRef.current;
    if (view === null) return;

    const anchor =
      position === 'start'
        ? 0
        : position === 'end'
          ? view.state.doc.length
          : Math.min(Math.max(0, Math.trunc(position)), view.state.doc.length);
    /*
     * `scrollIntoView: true` scrolls the MINIMUM distance, which leaves a
     * heading pinned to the bottom edge with its whole section still below the
     * fold — the author arrives at the name and none of what it says. An
     * explicit y:'start' puts the heading at the top, so its prose reads
     * downward from it.
     */
    if (typeof position === 'number') {
      view.dispatch({
        selection: { anchor },
        effects: EditorView.scrollIntoView(anchor, { y: 'start', yMargin: REVEAL_TOP_MARGIN_PX }),
      });
    } else {
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
    }

    /*
     * An offset means "reveal this", not "type here" — the Editor is following
     * a concept in from the map. Taking the caret would fire onFocusChanged,
     * which selects the cell's own node and so closes the sub-concept panel the
     * author is reading; the line would scroll into view and the panel they
     * clicked would vanish in the same frame. Clicking into the cell still
     * focuses it, and still switches the panel, because that IS the author
     * moving. Only start/end — a new or newly split cell — takes focus here.
     */
    if (typeof position !== 'number') view.focus();
  }, []);

  const getSelectionText = useCallback((): string => {
    const view = viewRef.current;
    if (view === null) return '';

    const { from, to } = view.state.selection.main;
    return from === to ? '' : view.state.sliceDoc(from, to);
  }, []);

  const getDocument = useCallback((): string | null => {
    const view = viewRef.current;
    return view === null ? null : view.state.doc.toString();
  }, []);

  const setDocument = useCallback((markdown: string): void => {
    const view = viewRef.current;
    if (view === null) return;
    if (view.state.doc.toString() === markdown) return;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: markdown },
      annotations: EXTERNAL_UPDATE.of(true),
    });
  }, []);

  return { hostRef, focus, getSelectionText, getDocument, setDocument };
}
