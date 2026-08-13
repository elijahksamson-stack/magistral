import { describe, expect, it } from 'vitest';

import {
  EMPTY_RECALL,
  RECALL_PULSE_MS,
  RECALL_REFRACTORY_MS,
  buildRecallIndex,
  findRecalled,
  fireNodes,
  pruneRecall,
  recallIntensity,
} from '../recall';
import { makeNode } from './fixtures';

const NODES = [
  makeNode('n1', { label: 'power market' }),
  makeNode('n2', { label: 'heat rate' }),
  makeNode('n3', { label: 'ISO' }),
  makeNode('n4', { label: 'power' }),
];

const INDEX = buildRecallIndex(NODES);

describe('findRecalled', () => {
  it('fires a concept the answer names', () => {
    expect(findRecalled(INDEX, 'The power market clears at the margin.')).toContain('n1');
  });

  it('is case-insensitive, as prose is', () => {
    expect(findRecalled(INDEX, 'HEAT RATE defines the cost.')).toContain('n2');
  });

  it('does not fire on a substring inside another word', () => {
    // "ISO" must not fire inside "isolation" — the classic false positive.
    expect(findRecalled(INDEX, 'in isolation this means little')).not.toContain('n3');
  });

  it('fires on a genuine standalone mention', () => {
    expect(findRecalled(INDEX, 'the ISO balances the grid')).toContain('n3');
  });

  it('prefers the longest matching concept but still fires the shorter one', () => {
    // "power market" appears; "power" is genuinely present too.
    const hits = findRecalled(INDEX, 'the power market sets prices');
    expect(hits).toContain('n1');
    expect(hits.indexOf('n1')).toBeLessThan(hits.indexOf('n4'));
  });

  it('fires nothing on text naming no concept', () => {
    expect(findRecalled(INDEX, 'nothing relevant here at all')).toEqual([]);
  });

  it('ignores labels too short to match safely', () => {
    const short = buildRecallIndex([makeNode('x', { label: 'AI' })]);
    expect(findRecalled(short, 'AI matters')).toEqual([]);
  });
});

describe('fireNodes', () => {
  it('records when a node fired', () => {
    const state = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    expect(state.get('n1')).toBe(1000);
  });

  it('will not re-fire inside the refractory period, so it cannot strobe', () => {
    const first = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    const again = fireNodes(first, ['n1'], 1000 + RECALL_REFRACTORY_MS - 1);
    expect(again).toBe(first);
    expect(again.get('n1')).toBe(1000);
  });

  it('re-fires once the refractory period has passed', () => {
    const first = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    const again = fireNodes(first, ['n1'], 1000 + RECALL_REFRACTORY_MS + 1);
    expect(again.get('n1')).toBe(1000 + RECALL_REFRACTORY_MS + 1);
  });

  it('returns the same map when nothing changed, so a render can bail out', () => {
    const first = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    expect(fireNodes(first, [], 2000)).toBe(first);
  });
});

describe('recallIntensity', () => {
  it('is full at the instant of firing', () => {
    const state = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    expect(recallIntensity(state, 'n1', 1000)).toBe(1);
  });

  it('decays to nothing over the pulse window', () => {
    const state = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    const mid = recallIntensity(state, 'n1', 1000 + RECALL_PULSE_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(recallIntensity(state, 'n1', 1000 + RECALL_PULSE_MS)).toBe(0);
  });

  it('is zero for a node that never fired', () => {
    expect(recallIntensity(EMPTY_RECALL, 'n1', 1000)).toBe(0);
  });
});

describe('pruneRecall', () => {
  it('drops fully decayed pulses so the decay loop can stop', () => {
    const state = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    expect(pruneRecall(state, 1000 + RECALL_PULSE_MS).size).toBe(0);
  });

  it('keeps a pulse that is still lit', () => {
    const state = fireNodes(EMPTY_RECALL, ['n1'], 1000);
    expect(pruneRecall(state, 1100)).toBe(state);
  });
});
