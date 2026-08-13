/**
 * CodeMirror decoration for `[[wikilinks]]`.
 *
 * Decorations are derived from `parseWikilinks`, the same function that mirrors
 * the core's parser — so what is underlined is exactly what becomes a node.
 * Clicking one hands the label back to the host, which resolves it to a node id
 * and selects it in the graph pane.
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { parseWikilinks, type WikilinkRef } from './wikilink';

export const WIKILINK_CLASS = 'cm-bd-wikilink';
export const WIKILINK_LABEL_ATTR = 'data-bd-wikilink';

const wikilinkMark = (ref: WikilinkRef) =>
  Decoration.mark({
    class: WIKILINK_CLASS,
    attributes: {
      [WIKILINK_LABEL_ATTR]: ref.label,
      title: `Select “${ref.label}” in the graph`,
    },
  });

/**
 * Decorate every wikilink in `text`.
 *
 * Exported on its own so the fenced-code-block rule is testable without a DOM.
 */
export function buildWikilinkDecorations(text: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const ref of parseWikilinks(text)) {
    builder.add(ref.from, ref.to, wikilinkMark(ref));
  }
  return builder.finish();
}

/** Walk up from an event target to the enclosing wikilink, if any. */
function readLabelFromEvent(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest(`.${WIKILINK_CLASS}`);
  return element?.getAttribute(WIKILINK_LABEL_ATTR) ?? null;
}

export interface WikilinkHandlers {
  /** Fired with the authored label — never a node id; the host resolves that. */
  onOpenLink(label: string): void;
}

const decorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildWikilinkDecorations(view.state.doc.toString());
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged) return;
      this.decorations = buildWikilinkDecorations(update.state.doc.toString());
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * The click is deliberately not `preventDefault`ed: selecting the node in the
 * graph must not stop the author placing a caret inside the link to edit it.
 */
function clickHandler(handlers: WikilinkHandlers): Extension {
  return EditorView.domEventHandlers({
    mousedown(event) {
      const label = readLabelFromEvent(event.target);
      if (label === null) return false;
      handlers.onOpenLink(label);
      return false;
    },
  });
}

export function wikilinkExtension(handlers: WikilinkHandlers): Extension {
  return [decorationPlugin, clickHandler(handlers)];
}
