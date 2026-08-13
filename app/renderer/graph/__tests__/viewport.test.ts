import { describe, expect, test } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM } from '../constants';
import {
  IDENTITY_VIEWPORT,
  centerOn,
  clampZoom,
  fitToBounds,
  panBy,
  screenToWorld,
  visibleWorldBounds,
  worldToScreen,
  zoomAt,
  type Viewport,
} from '../viewport';

const VIEWPORT: Viewport = { zoom: 2.5, panX: -140, panY: 88 };
const SIZE = { width: 800, height: 600 };

describe('screen <-> world', () => {
  test('worldToScreen applies zoom then pan', () => {
    // Arrange / Act
    const screen = worldToScreen(VIEWPORT, 100, 40);

    // Assert
    expect(screen).toEqual({ x: 100 * 2.5 - 140, y: 40 * 2.5 + 88 });
  });

  test('screenToWorld is the exact inverse of worldToScreen', () => {
    const samples = [
      { x: 0, y: 0 },
      { x: 12.5, y: -400 },
      { x: -1337.25, y: 991.75 },
    ];

    for (const point of samples) {
      const screen = worldToScreen(VIEWPORT, point.x, point.y);
      const roundTripped = screenToWorld(VIEWPORT, screen.x, screen.y);
      expect(roundTripped.x).toBeCloseTo(point.x, 10);
      expect(roundTripped.y).toBeCloseTo(point.y, 10);
    }
  });

  test('round-trips through several viewports', () => {
    const viewports: Viewport[] = [
      IDENTITY_VIEWPORT,
      { zoom: 0.08, panX: 4000, panY: -3000 },
      { zoom: 7.9, panX: -0.5, panY: 0.25 },
    ];

    for (const viewport of viewports) {
      const world = screenToWorld(viewport, 321, 654);
      const screen = worldToScreen(viewport, world.x, world.y);
      expect(screen.x).toBeCloseTo(321, 8);
      expect(screen.y).toBeCloseTo(654, 8);
    }
  });
});

describe('panBy', () => {
  test('returns a new viewport and leaves the original untouched', () => {
    const panned = panBy(VIEWPORT, 10, -20);

    expect(panned).not.toBe(VIEWPORT);
    expect(panned).toEqual({ zoom: 2.5, panX: -130, panY: 68 });
    expect(VIEWPORT).toEqual({ zoom: 2.5, panX: -140, panY: 88 });
  });
});

describe('zoomAt', () => {
  test('keeps the world point under the cursor pinned to the cursor', () => {
    const anchor = { x: 512, y: 133 };
    const before = screenToWorld(VIEWPORT, anchor.x, anchor.y);

    const zoomed = zoomAt(VIEWPORT, 1.75, anchor);
    const after = screenToWorld(zoomed, anchor.x, anchor.y);

    expect(zoomed.zoom).toBeCloseTo(2.5 * 1.75, 10);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  test('clamps to the zoom limits and returns the same object when clamped', () => {
    const anchor = { x: 100, y: 100 };
    const maxed = zoomAt({ zoom: MAX_ZOOM, panX: 0, panY: 0 }, 4, anchor);
    const floored = zoomAt({ zoom: MIN_ZOOM, panX: 0, panY: 0 }, 0.01, anchor);

    expect(maxed.zoom).toBe(MAX_ZOOM);
    expect(floored.zoom).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe('fitToBounds', () => {
  test('frames the bounds inside the pane with padding and centres them', () => {
    const bounds = { minX: -100, minY: -50, maxX: 100, maxY: 50 };
    const padding = 40;

    const viewport = fitToBounds(bounds, SIZE, padding);
    const topLeft = worldToScreen(viewport, bounds.minX, bounds.minY);
    const bottomRight = worldToScreen(viewport, bounds.maxX, bounds.maxY);

    expect(topLeft.x).toBeGreaterThanOrEqual(padding - 0.001);
    expect(topLeft.y).toBeGreaterThanOrEqual(padding - 0.001);
    expect(bottomRight.x).toBeLessThanOrEqual(SIZE.width - padding + 0.001);
    expect(bottomRight.y).toBeLessThanOrEqual(SIZE.height - padding + 0.001);

    const center = worldToScreen(viewport, 0, 0);
    expect(center.x).toBeCloseTo(SIZE.width / 2, 8);
    expect(center.y).toBeCloseTo(SIZE.height / 2, 8);
  });

  test('a single point does not blow the zoom up to the limit', () => {
    const viewport = fitToBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, SIZE, 40);

    expect(viewport.zoom).toBe(1);
    expect(worldToScreen(viewport, 5, 5)).toEqual({ x: 400, y: 300 });
  });
});

describe('visibleWorldBounds', () => {
  test('describes exactly the rectangle the pane shows', () => {
    const viewport = centerOn({ zoom: 2, panX: 0, panY: 0 }, { x: 0, y: 0 }, SIZE);
    const bounds = visibleWorldBounds(viewport, SIZE);

    expect(bounds.minX).toBeCloseTo(-200, 8);
    expect(bounds.maxX).toBeCloseTo(200, 8);
    expect(bounds.minY).toBeCloseTo(-150, 8);
    expect(bounds.maxY).toBeCloseTo(150, 8);
  });
});
