/**
 * Flow: which way each relationship runs, shown by moving along it.
 *
 * A static arrowhead states a direction; watching the whole map move states the
 * shape of it — where everything converges, what is a source, which way a chain
 * actually points. That is hard to read from a still picture of 75 edges and
 * easy to read from ten seconds of motion.
 *
 * Off by default and driven by an explicit button. Nothing on this map animates
 * because the author happened to look at it.
 *
 * Pure and DOM-free, like recall.ts and discovery.ts beside it: the caller owns
 * the clock, so the phase is reproducible in a test.
 */

/** One full traverse of an edge. Slow enough to follow, brisk enough to read. */
export const FLOW_CYCLE_MS = 2_600;

/** Travellers per edge. Beyond three it reads as a dotted line, not as motion. */
export const FLOW_DOTS_PER_EDGE = 3;

/**
 * Position within the cycle, 0..1, wrapping forever.
 *
 * Taken from the clock rather than accumulated per frame, so a dropped frame
 * cannot let one edge drift out of step with the rest of the map.
 */
export function flowPhase(now: number, cycleMs: number = FLOW_CYCLE_MS): number {
  const span = Math.max(1, cycleMs);
  const wrapped = ((now % span) + span) % span;
  return wrapped / span;
}

/**
 * Where each traveller sits along one edge, as fractions from source to target.
 *
 * Evenly spaced, so every edge carries the same visual density however long it
 * is: a short edge shows the same rhythm as a long one.
 */
export function flowOffsets(phase: number, count: number = FLOW_DOTS_PER_EDGE): number[] {
  const dots = Math.max(1, Math.trunc(count));
  const base = ((phase % 1) + 1) % 1;
  return Array.from({ length: dots }, (_, index) => (base + index / dots) % 1);
}
