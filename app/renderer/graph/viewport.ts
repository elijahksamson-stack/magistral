/**
 * Screen <-> world transform. Pure, immutable, no DOM.
 *
 * The transform is uniform scale + translation:
 *   screen = world * zoom + pan
 * Device pixel ratio is deliberately NOT part of it — the renderer applies dpr
 * once via setTransform, so every value here is in CSS pixels.
 */

import { EPSILON, MAX_ZOOM, MIN_ZOOM } from './constants';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export const IDENTITY_VIEWPORT: Viewport = { zoom: 1, panX: 0, panY: 0 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToScreen(viewport: Viewport, x: number, y: number): Point {
  return {
    x: x * viewport.zoom + viewport.panX,
    y: y * viewport.zoom + viewport.panY,
  };
}

export function screenToWorld(viewport: Viewport, x: number, y: number): Point {
  return {
    x: (x - viewport.panX) / viewport.zoom,
    y: (y - viewport.panY) / viewport.zoom,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, panX: viewport.panX + dx, panY: viewport.panY + dy };
}

/**
 * Scale by `factor` while keeping the world point under `anchor` (a screen
 * point) exactly where it is. This is what makes wheel zoom feel anchored to
 * the cursor rather than to the middle of the pane.
 */
export function zoomAt(viewport: Viewport, factor: number, anchor: Point): Viewport {
  const nextZoom = clampZoom(viewport.zoom * factor);
  if (nextZoom === viewport.zoom) return viewport;

  const world = screenToWorld(viewport, anchor.x, anchor.y);
  return {
    zoom: nextZoom,
    panX: anchor.x - world.x * nextZoom,
    panY: anchor.y - world.y * nextZoom,
  };
}

/** Centre `world` in a pane of `size` at the current zoom. */
export function centerOn(viewport: Viewport, world: Point, size: Size): Viewport {
  return {
    zoom: viewport.zoom,
    panX: size.width / 2 - world.x * viewport.zoom,
    panY: size.height / 2 - world.y * viewport.zoom,
  };
}

/** The rectangle of world space currently visible in a pane of `size`. */
export function visibleWorldBounds(viewport: Viewport, size: Size): Bounds {
  const topLeft = screenToWorld(viewport, 0, 0);
  const bottomRight = screenToWorld(viewport, size.width, size.height);
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

/**
 * The viewport that frames `bounds` inside `size` with `padding` screen pixels
 * of margin. Degenerate bounds (a single node) keep zoom at 1 rather than
 * blowing up to MAX_ZOOM.
 */
export function fitToBounds(bounds: Bounds, size: Size, padding: number): Viewport {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);

  const isDegenerate = width < EPSILON && height < EPSILON;
  const rawZoom = Math.min(
    width < EPSILON ? MAX_ZOOM : availableWidth / width,
    height < EPSILON ? MAX_ZOOM : availableHeight / height,
  );
  const zoom = isDegenerate ? 1 : clampZoom(rawZoom);

  const center: Point = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  return centerOn({ zoom, panX: 0, panY: 0 }, center, size);
}
