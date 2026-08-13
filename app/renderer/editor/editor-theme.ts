/**
 * The CodeMirror half of the visual language.
 *
 * Near-black canvas, restrained type, generous line-height, comfortable
 * measure. Colours are read from the CSS custom properties the pane defines so
 * the editor and the surrounding chrome can never drift apart.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import { WIKILINK_CLASS } from './wikilink-extension';

const TOKEN = {
  text: 'var(--bd-text, #d7d7de)',
  dim: 'var(--bd-text-dim, #8b8b98)',
  faint: 'var(--bd-text-faint, #61616e)',
  link: 'var(--bd-link, #9db9ff)',
  accent: 'var(--bd-accent, #c9b6ff)',
  code: 'var(--bd-code, #93d0b8)',
  surface: 'var(--bd-surface, #131317)',
  border: 'var(--bd-border, #26262e)',
  selection: 'var(--bd-selection, #2a3350)',
} as const;

const TYPE = {
  family: 'var(--bd-font-body, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif)',
  mono: 'var(--bd-font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
  size: 'var(--bd-font-size, 15px)',
  lineHeight: 'var(--bd-line-height, 1.7)',
  display: 'var(--bd-font-display, "Avenir Next", Avenir, "Helvetica Neue", sans-serif)',
} as const;

const cellTheme = EditorView.theme(
  {
    '&': {
      color: TOKEN.text,
      backgroundColor: 'transparent',
      fontFamily: TYPE.family,
      fontSize: TYPE.size,
    },
    '.cm-content': {
      padding: '0',
      lineHeight: TYPE.lineHeight,
      caretColor: TOKEN.accent,
    },
    '.cm-line': { padding: '0' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: TOKEN.accent, borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: TOKEN.selection,
    },
    '.cm-scroller': { fontFamily: TYPE.family, lineHeight: TYPE.lineHeight },
    '.cm-placeholder': { color: TOKEN.faint },

    [`.${WIKILINK_CLASS}`]: {
      color: TOKEN.link,
      textDecoration: 'underline',
      textDecorationColor: 'color-mix(in srgb, var(--bd-link, #9db9ff) 40%, transparent)',
      textUnderlineOffset: '3px',
      cursor: 'pointer',
    },
    [`.${WIKILINK_CLASS}:hover`]: {
      textDecorationColor: TOKEN.link,
    },

    '.cm-tooltip': {
      backgroundColor: TOKEN.surface,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: '8px',
      overflow: 'hidden',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: TYPE.family,
      fontSize: '13px',
      maxHeight: '13em',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      padding: '4px 10px',
      color: TOKEN.text,
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: TOKEN.selection,
      color: TOKEN.link,
    },
    '.cm-completionDetail': { color: TOKEN.faint, fontStyle: 'normal', marginLeft: '8px' },
  },
  { dark: true },
);

const markdownHighlight = HighlightStyle.define(
  [
    { tag: tags.heading1, color: TOKEN.text, fontFamily: TYPE.display, fontWeight: '600', fontSize: '1.35em' },
    { tag: tags.heading2, color: TOKEN.text, fontFamily: TYPE.display, fontWeight: '600', fontSize: '1.18em' },
    { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: TOKEN.text, fontFamily: TYPE.display, fontWeight: '600' },
    { tag: tags.strong, color: TOKEN.text, fontWeight: '600' },
    { tag: tags.emphasis, color: TOKEN.text, fontStyle: 'italic' },
    { tag: tags.strikethrough, color: TOKEN.dim, textDecoration: 'line-through' },
    { tag: tags.link, color: TOKEN.link },
    { tag: tags.url, color: TOKEN.dim },
    { tag: tags.quote, color: TOKEN.dim, fontStyle: 'italic' },
    { tag: [tags.monospace, tags.literal], color: TOKEN.code, fontFamily: TYPE.mono },
    { tag: [tags.processingInstruction, tags.meta], color: TOKEN.faint },
    { tag: tags.list, color: TOKEN.accent },
  ],
  { all: { fontFamily: TYPE.family } },
);

export const cellEditorTheme: Extension = [cellTheme, syntaxHighlighting(markdownHighlight)];
