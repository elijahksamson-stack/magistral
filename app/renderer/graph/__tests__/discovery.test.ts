import { describe, expect, test } from 'vitest';
import {
  DISCOVERY_TRAVEL_MS,
  EMPTY_DISCOVERY,
  beginDiscovery,
  discoveryProgress,
  newEdgeIds,
  pruneDiscovery,
} from '../discovery';
import { makeEdge } from './fixtures';

describe('newEdgeIds', () => {
  test('reports only the relationships that were not there before', () => {
    const before = [makeEdge('kept', 'a', 'b')];
    const after = [makeEdge('kept', 'a', 'b'), makeEdge('fresh', 'b', 'c')];

    expect(newEdgeIds(before, after)).toEqual(['fresh']);
  });

  test('reports nothing when a relationship was only removed', () => {
    const before = [makeEdge('a1', 'a', 'b'), makeEdge('a2', 'b', 'c')];
    const after = [makeEdge('a1', 'a', 'b')];

    expect(newEdgeIds(before, after)).toEqual([]);
  });

  /*
   * Opening a vault replaces the whole graph at once. Firing a pulse down every
   * edge of a map the author just opened would read as the app discovering
   * their own work back to them, so a cold start deliberately stays silent.
   */
  test('stays silent when there was no previous graph', () => {
    expect(newEdgeIds(null, [makeEdge('e1', 'a', 'b')])).toEqual([]);
  });
});

describe('discovery pulses', () => {
  test('a fired relationship starts at the source and travels to the target', () => {
    const state = beginDiscovery(EMPTY_DISCOVERY, ['e1'], 1_000);

    expect(discoveryProgress(state, 'e1', 1_000)).toBe(0);
    expect(discoveryProgress(state, 'e1', 1_000 + DISCOVERY_TRAVEL_MS / 2)).toBeCloseTo(0.5, 5);
    expect(discoveryProgress(state, 'e1', 1_000 + DISCOVERY_TRAVEL_MS)).toBe(1);
  });

  test('an edge that never fired has no pulse', () => {
    expect(discoveryProgress(EMPTY_DISCOVERY, 'absent', 1_000)).toBeNull();
  });

  test('re-firing an edge already travelling does not restart it', () => {
    const first = beginDiscovery(EMPTY_DISCOVERY, ['e1'], 1_000);
    const again = beginDiscovery(first, ['e1'], 1_200);

    expect(again).toBe(first);
  });

  test('returns the same map when nothing fires, so a frame can bail out', () => {
    expect(beginDiscovery(EMPTY_DISCOVERY, [], 1_000)).toBe(EMPTY_DISCOVERY);
  });

  test('drops a pulse once it has arrived', () => {
    const state = beginDiscovery(EMPTY_DISCOVERY, ['e1'], 1_000);

    expect(pruneDiscovery(state, 1_000 + DISCOVERY_TRAVEL_MS - 1).size).toBe(1);
    expect(pruneDiscovery(state, 1_000 + DISCOVERY_TRAVEL_MS).size).toBe(0);
  });

  test('does not mutate the state it is given', () => {
    const state = beginDiscovery(EMPTY_DISCOVERY, ['e1'], 1_000);
    const next = beginDiscovery(state, ['e2'], 1_100);

    expect(state.size).toBe(1);
    expect(next.size).toBe(2);
  });
});
