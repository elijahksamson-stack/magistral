/**
 * Drives the C++ force layout from a requestAnimationFrame loop.
 *
 * The expensive part of a frame is not the physics — it is marshalling. So the
 * node id list is fetched once via `layout:node-order` and cached; each frame
 * ships back only a Float64Array of coordinates aligned to it. The order is
 * re-fetched exactly when the topology version moves (or when a frame arrives
 * with a length that no longer matches, which means it moved under us).
 *
 * The loop stops when the frame reports converged, and any topology change or
 * user gesture restarts it. The rAF handle is cancelled on unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LAYOUT_TICKS_PER_FRAME } from './constants';
import { toErrorMessage } from './errors';
import { fetchNodeOrder, tickLayout } from './ipcClient';
import {
  createPositionIndex,
  isFrameAligned,
  withPositions,
  type PositionIndex,
} from './positionIndex';

export interface LayoutLoopOptions {
  /** False when there is nothing to simulate (no vault open, empty graph). */
  readonly isEnabled: boolean;
  /**
   * True while a gesture is moving nodes, which must keep ticking even once a
   * frame reports converged.
   *
   * A drag pins the node on every pointermove and the core re-heats on each
   * pin — but none of that is visible unless a frame is drawn. The wake on
   * pointerdown is not enough on its own: at that instant nothing has moved
   * yet, so the very first tick reports converged and the loop shuts down
   * again before the drag has begun. Every later pin then lands in the core
   * with no frame to surface it, so the node sits still and only jumps once
   * something else refreshes the snapshot.
   */
  readonly keepAwake?: boolean;
  readonly onError: (message: string) => void;
}

export interface LayoutLoopHandle {
  readonly index: PositionIndex | null;
  readonly isRunning: boolean;
  readonly isConverged: boolean;
  /** Wake a settled simulation — a drag, a parameter change, a reset. */
  readonly restart: () => void;
  /** Nodes or edges changed: re-read the node order before the next frame. */
  readonly invalidateTopology: () => void;
}

export function useLayoutLoop(options: LayoutLoopOptions): LayoutLoopHandle {
  const { isEnabled, keepAwake = false, onError } = options;

  const [index, setIndex] = useState<PositionIndex | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isConverged, setIsConverged] = useState(false);
  const [runToken, setRunToken] = useState(0);

  const indexRef = useRef<PositionIndex | null>(null);
  const needsOrderRef = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Read through a ref, not the effect's deps: a gesture starting or ending
  // must not tear the running loop down and rebuild it mid-drag.
  const keepAwakeRef = useRef(keepAwake);
  keepAwakeRef.current = keepAwake;

  const restart = useCallback(() => setRunToken((token) => token + 1), []);
  const invalidateTopology = useCallback(() => {
    needsOrderRef.current = true;
    setRunToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!isEnabled) {
      setIsRunning(false);
      return;
    }

    let isDisposed = false;
    let rafId: number | null = null;
    setIsRunning(true);
    setIsConverged(false);

    const schedule = (): void => {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        void step();
      });
    };

    const syncOrder = async (): Promise<PositionIndex> => {
      const cached = indexRef.current;
      if (cached && !needsOrderRef.current) return cached;

      const { order, topologyVersion } = await fetchNodeOrder();
      needsOrderRef.current = false;
      if (cached && cached.topologyVersion === topologyVersion) return cached;

      const fresh = createPositionIndex(order, new Float64Array(order.length * 2), topologyVersion);
      indexRef.current = fresh;
      return fresh;
    };

    const step = async (): Promise<void> => {
      try {
        const current = await syncOrder();
        if (isDisposed) return;

        const frame = await tickLayout(LAYOUT_TICKS_PER_FRAME);
        if (isDisposed) return;

        if (!isFrameAligned(current, frame.positions)) {
          needsOrderRef.current = true;
          schedule();
          return;
        }

        const next = withPositions(current, frame.positions);
        indexRef.current = next;
        setIndex(next);

        if (frame.converged) {
          setIsConverged(true);
          // Converged, but a gesture is still moving nodes: keep drawing so the
          // pins it is writing are actually seen. Stopping here is what made a
          // settled graph feel frozen under the cursor.
          if (!keepAwakeRef.current) {
            setIsRunning(false);
            return;
          }
        }
        schedule();
      } catch (error: unknown) {
        if (isDisposed) return;
        setIsRunning(false);
        onErrorRef.current(toErrorMessage(error));
      }
    };

    void step();

    return () => {
      isDisposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isEnabled, runToken]);

  return { index, isRunning, isConverged, restart, invalidateTopology };
}
