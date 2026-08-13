import { describe, expect, test } from 'vitest';
import { FLOW_CYCLE_MS, flowOffsets, flowPhase } from '../flow';

describe('flowPhase', () => {
  test('runs from the start of the cycle to its end', () => {
    expect(flowPhase(0)).toBe(0);
    expect(flowPhase(FLOW_CYCLE_MS / 2)).toBeCloseTo(0.5, 8);
  });

  /*
   * Derived from the clock, not accumulated per frame: a dropped frame must not
   * let one edge fall out of step with the rest of the map.
   */
  test('wraps rather than growing without bound', () => {
    expect(flowPhase(FLOW_CYCLE_MS)).toBe(0);
    expect(flowPhase(FLOW_CYCLE_MS * 7 + FLOW_CYCLE_MS / 4)).toBeCloseTo(0.25, 8);
  });

  test('stays within the cycle for a clock behind the epoch', () => {
    const phase = flowPhase(-FLOW_CYCLE_MS / 4);

    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
  });
});

describe('flowOffsets', () => {
  test('spaces the travellers evenly along the edge', () => {
    expect(flowOffsets(0, 4)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  test('every traveller stays on the edge as the phase advances', () => {
    for (const phase of [0, 0.1, 0.49, 0.5, 0.99]) {
      for (const offset of flowOffsets(phase)) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(1);
      }
    }
  });

  test('the pattern repeats once per cycle', () => {
    expect(flowOffsets(0.25)).toEqual(flowOffsets(1.25));
  });

  test('always yields at least one traveller', () => {
    expect(flowOffsets(0.5, 0)).toHaveLength(1);
  });
});
