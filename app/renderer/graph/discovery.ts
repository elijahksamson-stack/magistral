/**
 * The mark, as behaviour: a short line that resolves into a precise endpoint.
 *
 * When a relationship lands on the map, a lime pulse travels the cyan edge from
 * source to target and terminates there. Cyan is the graph's own structure;
 * lime is reserved for Magistral having done something. Running the signal
 * along an edge the author already understands is what makes a new connection
 * legible as an *event* rather than as one more line that was always there.
 *
 * Pure and DOM-free, like recall.ts beside it, so both the detection and the
 * decay are testable without a canvas.
 */

import type { GraphEdge } from '../../../shared/types/graph';

/** How long the pulse takes to cross an edge. Long enough to follow by eye. */
export const DISCOVERY_TRAVEL_MS = 900;

/** edgeId -> when its pulse started. */
export type DiscoveryState = ReadonlyMap<string, number>;

export const EMPTY_DISCOVERY: DiscoveryState = new Map();

/**
 * Relationships present in `after` that were absent from `before`.
 *
 * A null `before` means there is nothing to compare against — the first
 * snapshot, or a freshly opened vault. That returns nothing on purpose: every
 * edge would otherwise qualify as new and the whole map would fire at once.
 */
export function newEdgeIds(
  before: readonly GraphEdge[] | null,
  after: readonly GraphEdge[],
): string[] {
  if (!before) return [];
  const known = new Set(before.map((edge) => edge.id));
  return after.filter((edge) => !known.has(edge.id)).map((edge) => edge.id);
}

/**
 * Start a pulse on each edge, ignoring any already in flight.
 *
 * Returns the same map when nothing fired, so the common frame — where no
 * relationship landed — costs a reference comparison and no allocation.
 */
export function beginDiscovery(
  state: DiscoveryState,
  edgeIds: readonly string[],
  now: number,
): DiscoveryState {
  let next: Map<string, number> | null = null;

  for (const edgeId of edgeIds) {
    if (state.has(edgeId)) continue;
    next ??= new Map(state);
    next.set(edgeId, now);
  }
  return next ?? state;
}

/** Drop pulses that have arrived. */
export function pruneDiscovery(state: DiscoveryState, now: number): DiscoveryState {
  let next: Map<string, number> | null = null;

  for (const [edgeId, startedAt] of state) {
    if (now - startedAt < DISCOVERY_TRAVEL_MS) continue;
    next ??= new Map(state);
    next.delete(edgeId);
  }
  return next ?? state;
}

/**
 * How far along its edge a pulse has travelled, 0..1, or null if not firing.
 *
 * Linear rather than eased: this one reads as travel along a known path, and
 * easing it would look like the signal slowing down short of the target rather
 * than arriving at it.
 */
export function discoveryProgress(
  state: DiscoveryState,
  edgeId: string,
  now: number,
): number | null {
  const startedAt = state.get(edgeId);
  if (startedAt === undefined) return null;

  const elapsed = now - startedAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= DISCOVERY_TRAVEL_MS) return 1;
  return elapsed / DISCOVERY_TRAVEL_MS;
}
