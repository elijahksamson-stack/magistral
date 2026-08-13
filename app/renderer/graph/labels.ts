/**
 * Label placement. This graph is mostly text, so legibility of the labels IS
 * the render quality: below a zoom threshold they all go away, and above it the
 * ones that would overlap are suppressed, highest centrality winning.
 *
 * Collision testing runs against a uniform grid rather than every accepted box,
 * so a few hundred labels per frame stay cheap.
 */

import {
  LABEL_CENTRALITY_FAR,
  LABEL_CENTRALITY_MEDIUM,
  LABEL_FONT_SIZE_PX,
  LABEL_GAP_PX,
  LABEL_GRID_CELL_PX,
  LABEL_ZOOM_CLOSE,
  LABEL_ZOOM_MEDIUM,
  MAX_LABEL_CANDIDATES,
} from './constants';

/** Average glyph width as a fraction of font size, for measure-free estimates. */
const AVERAGE_GLYPH_RATIO = 0.55;

export interface LabelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LabelCandidate {
  readonly nodeId: string;
  readonly text: string;
  readonly box: LabelBox;
  /** Higher wins a collision. Infinity forces the label through. */
  readonly priority: number;
}

/** How much of the map is named at the current scale. */
export type LabelTier = 'far' | 'medium' | 'close';

export function labelTier(zoom: number): LabelTier {
  if (zoom < LABEL_ZOOM_MEDIUM) return 'far';
  if (zoom < LABEL_ZOOM_CLOSE) return 'medium';
  return 'close';
}

/**
 * Whether an ordinary concept earns a name at this tier.
 *
 * Deliberately monotonic: zooming in only ever adds names. A tier that dropped
 * a label the previous one showed would make the map flicker while the author
 * zooms, which reads as instability rather than detail.
 *
 * Selected, hovered and expanded concepts bypass this entirely — they are
 * forced through by the renderer, which is why "no ordinary labels" far out
 * still leaves the thing you are actually looking at named.
 */
export function earnsLabel(tier: LabelTier, centrality: number): boolean {
  if (tier === 'close') return true;
  const floor = tier === 'far' ? LABEL_CENTRALITY_FAR : LABEL_CENTRALITY_MEDIUM;
  return centrality >= floor;
}

/** Used where no measuring context exists (export bounds, tests). */
export function estimateLabelWidth(
  text: string,
  fontSize: number = LABEL_FONT_SIZE_PX,
): number {
  return text.length * fontSize * AVERAGE_GLYPH_RATIO;
}

export function labelBoxAt(
  centerX: number,
  top: number,
  width: number,
  height: number = LABEL_FONT_SIZE_PX,
): LabelBox {
  return { x: centerX - width / 2, y: top, width, height };
}

function isOverlapping(a: LabelBox, b: LabelBox): boolean {
  return (
    a.x < b.x + b.width + LABEL_GAP_PX &&
    b.x < a.x + a.width + LABEL_GAP_PX &&
    a.y < b.y + b.height + LABEL_GAP_PX &&
    b.y < a.y + a.height + LABEL_GAP_PX
  );
}

function cellKey(col: number, row: number): string {
  return `${col}:${row}`;
}

function cellsFor(box: LabelBox): readonly string[] {
  const minCol = Math.floor((box.x - LABEL_GAP_PX) / LABEL_GRID_CELL_PX);
  const maxCol = Math.floor((box.x + box.width + LABEL_GAP_PX) / LABEL_GRID_CELL_PX);
  const minRow = Math.floor((box.y - LABEL_GAP_PX) / LABEL_GRID_CELL_PX);
  const maxRow = Math.floor((box.y + box.height + LABEL_GAP_PX) / LABEL_GRID_CELL_PX);

  const keys: string[] = [];
  for (let col = minCol; col <= maxCol; col += 1) {
    for (let row = minRow; row <= maxRow; row += 1) {
      keys.push(cellKey(col, row));
    }
  }
  return keys;
}

/**
 * Greedy, priority-ordered placement. Returns the ids whose labels may be
 * drawn. Input is never mutated.
 */
export function selectVisibleLabels(
  candidates: readonly LabelCandidate[],
  maxLabels: number = MAX_LABEL_CANDIDATES,
): ReadonlySet<string> {
  const ranked = [...candidates]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.max(0, maxLabels));

  const grid = new Map<string, LabelBox[]>();
  const accepted = new Set<string>();

  for (const candidate of ranked) {
    const keys = cellsFor(candidate.box);
    const collides = keys.some((key) =>
      (grid.get(key) ?? []).some((box) => isOverlapping(box, candidate.box)),
    );
    if (collides) continue;

    accepted.add(candidate.nodeId);
    for (const key of keys) {
      const bucket = grid.get(key);
      if (bucket) bucket.push(candidate.box);
      else grid.set(key, [candidate.box]);
    }
  }

  return accepted;
}
