import { describe, expect, it } from 'vitest';

import { interpolateViewport, revealSelection } from '../camera';

describe('camera interpolation', () => {
  it('starts and ends exactly at the requested viewports', () => {
    const from = { zoom: 1, panX: 10, panY: 20 };
    const to = { zoom: 2, panX: 110, panY: -30 };

    expect(interpolateViewport(from, to, 0)).toEqual(from);
    expect(interpolateViewport(from, to, 1)).toEqual(to);
  });

  it('moves every camera axis monotonically during a resize', () => {
    const from = { zoom: 0.5, panX: 0, panY: 40 };
    const to = { zoom: 1, panX: 100, panY: -20 };
    const middle = interpolateViewport(from, to, 0.5);

    expect(middle.zoom).toBeGreaterThan(from.zoom);
    expect(middle.zoom).toBeLessThan(to.zoom);
    expect(middle.panX).toBeGreaterThan(from.panX);
    expect(middle.panY).toBeLessThan(from.panY);
  });

  it('keeps a selection clear of the docked inspector', () => {
    const state = {
      viewport: { zoom: 1, panX: 0, panY: 0 },
      mode: 'idle',
      dragNodeId: null,
      lastScreen: null,
      pressScreen: null,
      hasMoved: false,
      hoveredNodeId: null,
      connectFromId: null,
      connectScreen: null,
      connectTargetId: null,
    } as const;

    const revealed = revealSelection(state, { x: 900, y: 200 }, { width: 1000, height: 600 });
    expect(revealed.viewport.panX).toBeLessThan(0);
  });
});
