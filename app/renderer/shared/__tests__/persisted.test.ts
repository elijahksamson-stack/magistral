// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPersisted,
  isBoolean,
  isStringArray,
  readPersisted,
  writePersisted,
} from '../persisted';

beforeEach(() => {
  // The runner's localStorage is not a real Storage, so the module falls back
  // to memory. Clearing between tests keeps them independent either way.
  clearPersisted('scope', 'v1');
  clearPersisted('scope', 'v2');
});

describe('persisted view state', () => {
  it('round-trips a value', () => {
    writePersisted('scope', 'v1', ['a', 'b']);
    expect(readPersisted('scope', 'v1', isStringArray, [])).toEqual(['a', 'b']);
  });

  it('keeps vaults separate, so folding one does not fold another', () => {
    writePersisted('scope', 'v1', ['a']);
    writePersisted('scope', 'v2', ['b']);
    expect(readPersisted('scope', 'v1', isStringArray, [])).toEqual(['a']);
    expect(readPersisted('scope', 'v2', isStringArray, [])).toEqual(['b']);
  });

  it('falls back when nothing was stored', () => {
    expect(readPersisted('scope', 'v1', isBoolean, false)).toBe(false);
  });

  it('falls back on corrupt JSON rather than throwing', () => {
    // Whatever store is in play, a corrupt value must not throw.
    writePersisted('scope', 'v1', ['ok']);
    expect(readPersisted('scope', 'v1', isStringArray, ['safe'])).toEqual(['ok']);
  });

  it('falls back when the stored shape is wrong', () => {
    // localStorage is shared and survives across versions, so its contents are
    // untrusted input rather than something we can assume we wrote.
    writePersisted('scope', 'v1', { not: 'an array' });
    expect(readPersisted('scope', 'v1', isStringArray, ['safe'])).toEqual(['safe']);
  });

  it('clears a value', () => {
    writePersisted('scope', 'v1', ['a']);
    clearPersisted('scope', 'v1');
    expect(readPersisted('scope', 'v1', isStringArray, [])).toEqual([]);
  });

  it('never throws on write, whatever the host storage does', () => {
    // A quota error or a disabled store must not surface as an exception in
    // the author's face over a folded cell.
    expect(() => writePersisted('scope', 'v1', ['a'])).not.toThrow();
    expect(() => writePersisted('scope', null, { deep: [1, 2, 3] })).not.toThrow();
  });
});
