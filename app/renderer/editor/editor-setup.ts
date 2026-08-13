/**
 * Assembling one cell's CodeMirror instance.
 *
 * Markdown language, dark theme, wikilink decoration + `[[` autocomplete, and
 * the four cell-level bindings. Enter is deliberately left alone — it inserts a
 * newline, because a cell is a block of prose, not a chat input.
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { completionKeymap, closeBrackets } from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { isExternalUpdate } from './editor-annotations';
import { shouldMergeIntoPrevious } from './editor-keys';
import { cellEditorTheme } from './editor-theme';
import { wikilinkCompletionExtension } from './wikilink-complete';
import type { LabelCandidate } from './wikilink-suggest';
import { wikilinkExtension } from './wikilink-extension';

export const CELL_PLACEHOLDER = 'Write. Use [[brackets]] to name a concept.';

export interface CellEditorCallbacks {
  /** Fired on every document change. The host debounces before persisting. */
  onDocChanged(markdown: string): void;
  onFocusChanged(isFocused: boolean): void;
  /** The author clicked a `[[link]]`. Receives the authored label. */
  onOpenLink(label: string): void;
  /** Cmd/Ctrl+Enter. */
  onSparkle(): void;
  /** Cmd/Ctrl+Shift+Backspace. */
  onDeleteCell(): void;
  /** Backspace at the start of an empty cell. Return false to fall through. */
  onMergeIntoPrevious(): boolean;
  /** Current graph labels, read lazily so completions never go stale. */
  getNodeLabels(): readonly LabelCandidate[];
}

function cellKeymap(callbacks: CellEditorCallbacks): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: 'Mod-Enter',
        run: () => {
          callbacks.onSparkle();
          return true;
        },
      },
      {
        key: 'Mod-Shift-Backspace',
        run: () => {
          callbacks.onDeleteCell();
          return true;
        },
      },
      {
        key: 'Backspace',
        run: (view) =>
          shouldMergeIntoPrevious(view.state) ? callbacks.onMergeIntoPrevious() : false,
      },
    ]),
  );
}

function changeListener(callbacks: CellEditorCallbacks): Extension {
  return EditorView.updateListener.of((update: ViewUpdate) => {
    if (update.docChanged && !isExternalUpdate(update)) {
      callbacks.onDocChanged(update.state.doc.toString());
    }
    if (update.focusChanged) callbacks.onFocusChanged(update.view.hasFocus);
  });
}

export function createCellExtensions(callbacks: CellEditorCallbacks): Extension[] {
  return [
    history(),
    closeBrackets(),
    EditorView.lineWrapping,
    placeholder(CELL_PLACEHOLDER),
    markdown({ base: markdownLanguage }),
    cellEditorTheme,
    wikilinkExtension({ onOpenLink: callbacks.onOpenLink }),
    wikilinkCompletionExtension(callbacks.getNodeLabels),
    cellKeymap(callbacks),
    keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap]),
    changeListener(callbacks),
  ];
}
