/**
 * The debounce is what keeps a burst of keystrokes from becoming a burst of
 * graph syncs. One quiet window, one upsertCell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL_UPSERT_DEBOUNCE_MS, createDebouncer } from '../debounce';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('calls upsertCell once for a burst of keystrokes, with the final text', () => {
    const upsertCell = vi.fn<(markdown: string) => void>();
    const debouncer = createDebouncer(CELL_UPSERT_DEBOUNCE_MS, upsertCell);

    for (const markdown of ['t', 'th', 'the', 'thes', 'thesi', 'thesis']) {
      debouncer.schedule(markdown);
      vi.advanceTimersByTime(40);
    }

    expect(upsertCell).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CELL_UPSERT_DEBOUNCE_MS);

    expect(upsertCell).toHaveBeenCalledTimes(1);
    expect(upsertCell).toHaveBeenCalledWith('thesis');
  });

  it('fires again for a second burst after the window closes', () => {
    const upsertCell = vi.fn<(markdown: string) => void>();
    const debouncer = createDebouncer(CELL_UPSERT_DEBOUNCE_MS, upsertCell);

    debouncer.schedule('first');
    vi.advanceTimersByTime(CELL_UPSERT_DEBOUNCE_MS);
    debouncer.schedule('second');
    vi.advanceTimersByTime(CELL_UPSERT_DEBOUNCE_MS);

    expect(upsertCell.mock.calls).toEqual([['first'], ['second']]);
  });

  it('flush runs the queued value immediately and only once', () => {
    const upsertCell = vi.fn<(markdown: string) => void>();
    const debouncer = createDebouncer(CELL_UPSERT_DEBOUNCE_MS, upsertCell);

    debouncer.schedule('draft');
    debouncer.flush();

    expect(upsertCell).toHaveBeenCalledTimes(1);
    expect(upsertCell).toHaveBeenCalledWith('draft');

    vi.advanceTimersByTime(CELL_UPSERT_DEBOUNCE_MS * 2);
    expect(upsertCell).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing is queued', () => {
    const upsertCell = vi.fn<(markdown: string) => void>();
    createDebouncer(CELL_UPSERT_DEBOUNCE_MS, upsertCell).flush();

    expect(upsertCell).not.toHaveBeenCalled();
  });

  it('cancel discards the queued value', () => {
    const upsertCell = vi.fn<(markdown: string) => void>();
    const debouncer = createDebouncer(CELL_UPSERT_DEBOUNCE_MS, upsertCell);

    debouncer.schedule('doomed');
    debouncer.cancel();
    vi.advanceTimersByTime(CELL_UPSERT_DEBOUNCE_MS * 2);

    expect(upsertCell).not.toHaveBeenCalled();
  });

  it('reports whether a value is waiting', () => {
    const debouncer = createDebouncer(CELL_UPSERT_DEBOUNCE_MS, () => undefined);

    expect(debouncer.isPending()).toBe(false);
    debouncer.schedule('x');
    expect(debouncer.isPending()).toBe(true);
    vi.advanceTimersByTime(CELL_UPSERT_DEBOUNCE_MS);
    expect(debouncer.isPending()).toBe(false);
  });

  it('rejects a nonsensical delay rather than silently misbehaving', () => {
    expect(() => createDebouncer(-1, () => undefined)).toThrow(/non-negative/);
  });
});
