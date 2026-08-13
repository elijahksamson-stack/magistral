/**
 * Safe markdown rendering for model output.
 *
 * Model output is untrusted text. It is never turned into HTML — there is no
 * `dangerouslySetInnerHTML` in this file and there must never be one. Everything
 * becomes React elements, so any `<script>`, `<img onerror>` or stray angle
 * bracket in a response is escaped by React and rendered as the characters the
 * model actually wrote.
 *
 * The subset is deliberate: headings, lists, blockquotes, fenced and inline
 * code, bold, italic, and node links. Anything else renders as literal text,
 * which is the correct failure mode for a tool that records what was said.
 */

import { Fragment, type CSSProperties, type JSX, type ReactNode } from 'react';
import type { EntityPresentation } from '../shared/entityPresentation';
import { normalizeLabel } from '../../../shared/labels';

import styles from './markdown.module.css';

const MAX_HEADING_LEVEL = 4;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const FENCE_PATTERN = /^\s*(?:```|~~~)/;
const UNORDERED_ITEM_PATTERN = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_PATTERN = /^\s*>\s?(.*)$/;
const RULE_PATTERN = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/**
 * Inline tokens, matched in priority order: code spans first so nothing inside
 * them is re-interpreted, then wikilinks, then emphasis.
 *
 * The emphasis alternatives require a non-space immediately inside the markers,
 * which is what stops `2 * 3 * 4` from rendering as italics. The underscore
 * forms additionally refuse to start or end mid-word, so `snake_case_name`
 * survives intact.
 */
const INLINE_PATTERN = new RegExp(
  [
    '(`[^`]+`)',
    '(\\[\\[[^\\][]+\\]\\])',
    '(\\*\\*(?!\\s)[^*]*?(?<!\\s)\\*\\*)',
    '(\\*(?!\\s)[^*\\n]*?(?<!\\s)\\*)',
    '((?<![A-Za-z0-9])__(?!\\s)[^_]*?(?<!\\s)__)',
    '((?<![A-Za-z0-9])_(?!\\s)[^_\\n]*?(?<!\\s)_(?![A-Za-z0-9]))',
  ].join('|'),
  'g',
);

export interface MarkdownProps {
  text: string;
  /** Node labels to turn into clickable links. Longest-first. */
  labels?: readonly string[];
  entitiesByLabel?: ReadonlyMap<string, EntityPresentation>;
  onSelectLabel?: (label: string) => void;
  onHoverLabel?: (label: string | null) => void;
}

/** Escape a label for literal use inside a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One alternation over every linkable label, longest first so the most specific
 * label wins. Returns null when there is nothing to link.
 */
export function buildLabelPattern(labels: readonly string[]): RegExp | null {
  const usable = labels.filter((label) => label.trim().length > 0);
  if (usable.length === 0) return null;

  const alternation = usable.map(escapeForRegExp).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(${alternation})(?![\\p{L}\\p{N}])`, 'giu');
}

interface InlineContext {
  labelPattern: RegExp | null;
  onSelectLabel?: ((label: string) => void) | undefined;
  onHoverLabel?: ((label: string | null) => void) | undefined;
  entitiesByLabel?: ReadonlyMap<string, EntityPresentation> | undefined;
}

function NodeLink({
  label,
  onSelect,
  onHover,
  presentation,
}: {
  label: string;
  onSelect?: ((label: string) => void) | undefined;
  onHover?: ((label: string | null) => void) | undefined;
  presentation?: EntityPresentation | undefined;
}): JSX.Element {
  if (!onSelect) return <span className={styles.nodeLabel}>{label}</span>;
  return (
    <button
      type="button"
      className={styles.nodeLink}
      data-node-label={label}
      data-category={presentation?.category}
      data-selection={presentation?.selectionState}
      style={presentation
        ? ({ '--bd-entity-color': presentation.categoryColor } as CSSProperties)
        : undefined}
      title={presentation
        ? `${presentation.categoryLabel} · ${presentation.relationshipCount} relationship${presentation.relationshipCount === 1 ? '' : 's'}`
        : `Open ${label} on the map`}
      onClick={() => onSelect(label)}
      onMouseEnter={() => onHover?.(label)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(label)}
      onBlur={() => onHover?.(null)}
    >
      <span className={styles.nodeGlyph} aria-hidden="true">
        {presentation?.glyph ?? '●'}
      </span>
      {label}
    </button>
  );
}

/** Split plain text on known node labels. Text only — never markup. */
function renderLabels(text: string, context: InlineContext, keyPrefix: string): ReactNode[] {
  const { labelPattern } = context;
  if (!labelPattern) return [text];

  labelPattern.lastIndex = 0;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match = labelPattern.exec(text);

  while (match !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      <NodeLink
        key={`${keyPrefix}-label-${match.index}`}
        label={match[0]}
        onSelect={context.onSelectLabel}
        onHover={context.onHoverLabel}
        presentation={context.entitiesByLabel?.get(normalizeLabel(match[0]))}
      />,
    );
    cursor = match.index + match[0].length;
    match = labelPattern.exec(text);
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/**
 * Inline markdown. Code spans are matched first so their contents are never
 * re-interpreted as emphasis or as a node label.
 */
export function renderInline(
  text: string,
  context: InlineContext,
  keyPrefix: string,
): ReactNode[] {
  INLINE_PATTERN.lastIndex = 0;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match = INLINE_PATTERN.exec(text);

  const pushPlain = (value: string, at: number) => {
    if (value.length > 0) parts.push(...renderLabels(value, context, `${keyPrefix}-${at}`));
  };

  while (match !== null) {
    pushPlain(text.slice(cursor, match.index), cursor);
    parts.push(renderInlineToken(match, context, `${keyPrefix}-${match.index}`));
    cursor = match.index + match[0].length;
    match = INLINE_PATTERN.exec(text);
  }

  pushPlain(text.slice(cursor), cursor);
  return parts;
}

function renderInlineToken(
  match: RegExpExecArray,
  context: InlineContext,
  key: string,
): ReactNode {
  const [, code, wikilink, strong, emphasis, strongUnderscore, emphasisUnderscore] = match;

  if (code !== undefined) {
    return (
      <code key={key} className={styles.code}>
        {code.slice(1, -1)}
      </code>
    );
  }

  if (wikilink !== undefined) {
    const label = wikilink.slice(2, -2).trim();
    return (
      <NodeLink
        key={key}
        label={label}
        onSelect={context.onSelectLabel}
        onHover={context.onHoverLabel}
        presentation={context.entitiesByLabel?.get(normalizeLabel(label))}
      />
    );
  }

  const strongToken = strong ?? strongUnderscore;
  if (strongToken !== undefined) {
    const value = strongToken.slice(2, -2);
    return <strong key={key}>{renderLabels(value, context, key)}</strong>;
  }

  const value = (emphasis ?? emphasisUnderscore ?? '').slice(1, -1);
  return <em key={key}>{renderLabels(value, context, key)}</em>;
}

type Block =
  | { kind: 'code'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'rule' }
  | { kind: 'paragraph'; lines: string[] };

/** Group lines into blocks. Pure, so block segmentation is testable alone. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (FENCE_PATTERN.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_PATTERN.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence, or past the end
      blocks.push({ kind: 'code', lines: body });
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (RULE_PATTERN.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: Math.min((heading[1] ?? '#').length, MAX_HEADING_LEVEL),
        text: heading[2] ?? '',
      });
      index += 1;
      continue;
    }

    const consumed = consumeGroup(lines, index);
    blocks.push(consumed.block);
    index = consumed.next;
  }

  return blocks;
}

function consumeGroup(lines: string[], start: number): { block: Block; next: number } {
  const first = lines[start] ?? '';

  if (QUOTE_PATTERN.test(first)) {
    const body: string[] = [];
    let index = start;
    while (index < lines.length) {
      const quoted = QUOTE_PATTERN.exec(lines[index] ?? '');
      if (!quoted) break;
      body.push(quoted[1] ?? '');
      index += 1;
    }
    return { block: { kind: 'quote', lines: body }, next: index };
  }

  const isOrdered = ORDERED_ITEM_PATTERN.test(first);
  const itemPattern = isOrdered ? ORDERED_ITEM_PATTERN : UNORDERED_ITEM_PATTERN;

  if (itemPattern.test(first) && !RULE_PATTERN.test(first)) {
    const items: string[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index] ?? '';
      if (RULE_PATTERN.test(line)) break;
      const item = itemPattern.exec(line);
      if (!item) break;
      items.push(item[1] ?? '');
      index += 1;
    }
    return { block: { kind: 'list', ordered: isOrdered, items }, next: index };
  }

  const body: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || FENCE_PATTERN.test(line) || HEADING_PATTERN.test(line)) break;
    if (UNORDERED_ITEM_PATTERN.test(line) || ORDERED_ITEM_PATTERN.test(line)) break;
    if (QUOTE_PATTERN.test(line) || RULE_PATTERN.test(line)) break;
    body.push(line);
    index += 1;
  }
  return { block: { kind: 'paragraph', lines: body }, next: index };
}

function renderBlock(block: Block, context: InlineContext, key: string): ReactNode {
  switch (block.kind) {
    case 'code':
      return (
        <pre key={key} className={styles.pre}>
          <code>{block.lines.join('\n')}</code>
        </pre>
      );
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4';
      return (
        <Tag key={key} className={styles.heading}>
          {renderInline(block.text, context, key)}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote key={key} className={styles.quote}>
          {renderInline(block.lines.join(' '), context, key)}
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((item, position) => (
        <li key={`${key}-${position}`}>{renderInline(item, context, `${key}-${position}`)}</li>
      ));
      return block.ordered ? (
        <ol key={key} className={styles.list}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={styles.list}>
          {items}
        </ul>
      );
    }
    case 'rule':
      return <hr key={key} className={styles.rule} />;
    default:
      return (
        <p key={key} className={styles.paragraph}>
          {renderInline(block.lines.join('\n'), context, key)}
        </p>
      );
  }
}

export default function Markdown({
  text,
  labels = [],
  entitiesByLabel,
  onSelectLabel,
  onHoverLabel,
}: MarkdownProps): JSX.Element {
  const context: InlineContext = {
    labelPattern: buildLabelPattern(labels),
    onSelectLabel,
    onHoverLabel,
    entitiesByLabel,
  };

  return (
    <Fragment>
      {parseBlocks(text).map((block, position) =>
        renderBlock(block, context, `block-${position}`),
      )}
    </Fragment>
  );
}
