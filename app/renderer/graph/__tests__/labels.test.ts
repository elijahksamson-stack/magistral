import { describe, expect, test } from 'vitest';
import { LABEL_ZOOM_CLOSE, LABEL_ZOOM_MEDIUM } from '../constants';
import {
  earnsLabel,
  estimateLabelWidth,
  labelBoxAt,
  labelTier,
  selectVisibleLabels,
  type LabelCandidate,
} from '../labels';

function candidate(
  nodeId: string,
  x: number,
  y: number,
  priority: number,
  width = 50,
): LabelCandidate {
  return { nodeId, text: nodeId, box: { x, y, width, height: 12 }, priority };
}

describe('semantic zoom', () => {
  test('reads the tier off the viewport zoom', () => {
    expect(labelTier(LABEL_ZOOM_MEDIUM - 0.01)).toBe('far');
    expect(labelTier(LABEL_ZOOM_MEDIUM)).toBe('medium');
    expect(labelTier(LABEL_ZOOM_CLOSE - 0.01)).toBe('medium');
    expect(labelTier(LABEL_ZOOM_CLOSE)).toBe('close');
  });

  test('far names only the most important concepts, not the ordinary ones', () => {
    expect(earnsLabel('far', 1)).toBe(true);
    expect(earnsLabel('far', 0.3)).toBe(false);
  });

  test('medium adds significant concepts while the long tail stays quiet', () => {
    expect(earnsLabel('medium', 0.3)).toBe(true);
    expect(earnsLabel('medium', 0.02)).toBe(false);
  });

  test('close names everything, however peripheral', () => {
    expect(earnsLabel('close', 0)).toBe(true);
  });

  /*
   * The point of the tiers is that zooming in only ever ADDS names. A tier that
   * dropped a label the previous one showed would make the map flicker as the
   * author zooms, which is worse than showing too few.
   */
  test('each tier is at least as permissive as the one before it', () => {
    for (const centrality of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      if (earnsLabel('far', centrality)) expect(earnsLabel('medium', centrality)).toBe(true);
      if (earnsLabel('medium', centrality)) expect(earnsLabel('close', centrality)).toBe(true);
    }
  });
});

describe('selectVisibleLabels', () => {
  test('keeps labels that do not touch', () => {
    const accepted = selectVisibleLabels([
      candidate('a', 0, 0, 0.5),
      candidate('b', 60, 0, 0.5),
    ]);

    expect(accepted.size).toBe(2);
  });

  test('suppresses a colliding label, keeping the higher priority one', () => {
    const accepted = selectVisibleLabels([
      candidate('low', 52, 0, 0.1),
      candidate('high', 0, 0, 0.9),
    ]);

    expect([...accepted]).toEqual(['high']);
  });

  test('suppresses vertical collisions too', () => {
    const accepted = selectVisibleLabels([
      candidate('top', 0, 0, 0.9),
      candidate('under', 0, 13, 0.2),
      candidate('clear', 0, 400, 0.2),
    ]);

    expect(accepted.has('top')).toBe(true);
    expect(accepted.has('under')).toBe(false);
    expect(accepted.has('clear')).toBe(true);
  });

  test('a forced label always wins its collision', () => {
    const accepted = selectVisibleLabels([
      candidate('normal', 0, 0, 0.99),
      candidate('forced', 4, 0, Number.POSITIVE_INFINITY),
    ]);

    expect([...accepted]).toEqual(['forced']);
  });

  test('caps how many labels it will consider, highest priority first', () => {
    const accepted = selectVisibleLabels(
      [
        candidate('a', 0, 0, 0.1),
        candidate('b', 0, 200, 0.9),
        candidate('c', 0, 400, 0.5),
      ],
      2,
    );

    expect([...accepted].sort()).toEqual(['b', 'c']);
  });

  test('does not mutate the candidate list it is given', () => {
    const candidates = [candidate('a', 0, 0, 0.1), candidate('b', 0, 200, 0.9)];
    const snapshot = [...candidates];

    selectVisibleLabels(candidates);

    expect(candidates).toEqual(snapshot);
    expect(candidates[0]?.nodeId).toBe('a');
  });
});

describe('label text', () => {
  test('estimates width from the character count', () => {
    expect(estimateLabelWidth('')).toBe(0);
    expect(estimateLabelWidth('abcd')).toBeGreaterThan(0);
    expect(estimateLabelWidth('abcdefgh')).toBeCloseTo(estimateLabelWidth('abcd') * 2, 8);
  });

  test('labelBoxAt centres the box on the node', () => {
    const box = labelBoxAt(100, 40, 50, 12);

    expect(box).toEqual({ x: 75, y: 40, width: 50, height: 12 });
  });
});
