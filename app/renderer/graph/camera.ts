/** Small, interruptible camera transitions for pane resize and explicit fit. */

import type { InteractionState } from './interaction';
import type { Viewport } from './viewport';
import type { Point, Size } from './viewport';

const CAMERA_DURATION_MS = 220;

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

export function interpolateViewport(from: Viewport, to: Viewport, progress: number): Viewport {
  const amount = easeOutCubic(Math.min(1, Math.max(0, progress)));
  return {
    zoom: from.zoom + (to.zoom - from.zoom) * amount,
    panX: from.panX + (to.panX - from.panX) * amount,
    panY: from.panY + (to.panY - from.panY) * amount,
  };
}

/** Keep a selected entity clear of the docked inspector and canvas controls. */
export function revealSelection(
  state: InteractionState,
  world: Point,
  size: Size,
  inspectorWidth = 310,
): InteractionState {
  const screen = {
    x: world.x * state.viewport.zoom + state.viewport.panX,
    y: world.y * state.viewport.zoom + state.viewport.panY,
  };
  const minX = 64;
  const maxX = Math.max(minX + 40, size.width - inspectorWidth - 20);
  const minY = 58;
  const maxY = Math.max(minY + 40, size.height - 58);
  const shiftX = screen.x < minX ? minX - screen.x : screen.x > maxX ? maxX - screen.x : 0;
  const shiftY = screen.y < minY ? minY - screen.y : screen.y > maxY ? maxY - screen.y : 0;
  return {
    ...state,
    viewport: {
      ...state.viewport,
      panX: state.viewport.panX + shiftX,
      panY: state.viewport.panY + shiftY,
    },
  };
}

/** Returns a cancellation function; starting a new transition should cancel the old one. */
export function animateCamera(
  from: InteractionState,
  to: InteractionState,
  apply: (state: InteractionState) => void,
  durationMs = CAMERA_DURATION_MS,
): () => void {
  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (reduceMotion || typeof requestAnimationFrame !== 'function') {
    apply(to);
    return () => undefined;
  }

  let frame = 0;
  let cancelled = false;
  const startedAt = performance.now();
  const tick = (now: number): void => {
    if (cancelled) return;
    const progress = Math.min(1, (now - startedAt) / Math.max(1, durationMs));
    apply({ ...to, viewport: interpolateViewport(from.viewport, to.viewport, progress) });
    if (progress < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
