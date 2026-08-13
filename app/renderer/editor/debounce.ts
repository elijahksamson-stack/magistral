/**
 * A trailing-edge debouncer.
 *
 * Every keystroke in a cell would otherwise re-parse the markdown, re-sync the
 * wikilinks and touch the graph. The editor batches them: the last value inside
 * a quiet window wins, and `upsertCell` fires once.
 */

/** Quiet window before a cell's markdown is pushed to the store. */
export const CELL_UPSERT_DEBOUNCE_MS = 300;

export interface Debouncer<T> {
  /** Queue `value`, restarting the quiet window. */
  schedule(value: T): void;
  /** Run the queued value now. No-op when nothing is queued. */
  flush(): void;
  /** Discard the queued value without running it. */
  cancel(): void;
  isPending(): boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * `run` is invoked at most once per quiet window, always with the most recent
 * value. Caller owns the lifetime — call `cancel()` (or `flush()`) on unmount.
 */
export function createDebouncer<T>(
  delayMs: number,
  run: (value: T) => void,
): Debouncer<T> {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`createDebouncer: delayMs must be a non-negative number, got ${delayMs}`);
  }

  let timer: TimerHandle | null = null;
  let queued: { value: T } | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fire = (): void => {
    const pending = queued;
    clear();
    queued = null;
    if (pending !== null) run(pending.value);
  };

  return {
    schedule(value: T): void {
      queued = { value };
      clear();
      timer = setTimeout(fire, delayMs);
    },
    flush(): void {
      if (queued === null) return;
      fire();
    },
    cancel(): void {
      clear();
      queued = null;
    },
    isPending(): boolean {
      return queued !== null;
    },
  };
}
