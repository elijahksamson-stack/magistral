/**
 * Naming a graph must survive a snapshot and a save.
 *
 * Reproduces a reported bug: naming a graph appeared to do nothing and the
 * picker stayed full of "Untitled". The vault file was renamed on disk, but
 * the C++ core still held the old name — so the next snapshot restored it and
 * the next save wrote it back over the file. The core owns the name, and
 * `setName` was never exposed through the addon at all.
 */

import { describe, expect, it } from 'vitest';

import { createRequire } from 'node:module';
import path from 'node:path';

import type { BrainDumpCoreAddon } from '../../shared/types/addon';

// Loaded directly rather than through addon-loader, which resolves paths for
// the packaged app; here the freshly built binary is the thing under test.
const require_ = createRequire(import.meta.url);
const addon = require_(
  path.resolve(__dirname, '../../build/Release/braindump.node'),
) as BrainDumpCoreAddon;

describe('graph naming', () => {
  it('exposes setName on the native graph', () => {
    // The whole bug in one assertion: this method existed in the C++ header
    // and was missing from the binding.
    const graph = addon.createGraph('Untitled');
    expect(typeof graph.setName).toBe('function');
  });

  it('renames the graph in the core, not just on disk', () => {
    const graph = addon.createGraph('Untitled');
    graph.setName('Power Markets');

    expect(JSON.parse(graph.toJSON()).name).toBe('Power Markets');
  });

  it('survives a serialize/parse round trip, which is what a save does', () => {
    const graph = addon.createGraph('Untitled');
    graph.syncCell('c1', '[[grid-energy prices]] drive [[AI data centers]].');
    graph.setName('Power Markets');

    const reopened = addon.graphFromJSON(graph.toJSON());
    expect(JSON.parse(reopened.toJSON()).name).toBe('Power Markets');
  });

  it('keeps the new name when the snapshot is re-read', () => {
    // refreshSnapshot() re-reads from the core. Before the fix this is where
    // "Untitled" came back and overwrote what the author had just typed.
    const graph = addon.createGraph('Untitled');
    graph.setName('Power Markets');

    const first = JSON.parse(graph.toJSON()).name;
    const second = JSON.parse(graph.toJSON()).name;
    expect(first).toBe('Power Markets');
    expect(second).toBe('Power Markets');
  });

  it('rejects an empty name rather than silently accepting one', () => {
    const graph = addon.createGraph('Untitled');
    expect(() => graph.setName('')).toThrow();
  });
});
