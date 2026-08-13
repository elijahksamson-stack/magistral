/**
 * Renderer test setup.
 *
 * Provides the preload bridge (`window.braindump`) the renderer assumes, plus
 * the DOM APIs jsdom lacks that the panes rely on.
 */

import { afterEach, vi } from 'vitest';

const hasDom = typeof window !== 'undefined';

// Only the DOM halves load under jsdom; node-environment suites share this
// setup file and must not pull in testing-library at all.
if (hasDom) {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// jsdom has neither; the graph pane and the editor both observe layout.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

if (hasDom) {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  // jsdom implements neither; the editor scrolls an imported cell into view.
  Element.prototype.scrollIntoView ??= () => {};

  // CodeMirror measures ranges; jsdom returns nothing useful, which is fine
  // for behaviour tests but throws without these.
  Range.prototype.getBoundingClientRect ??= () =>
    ({ x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getClientRects ??= () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
}
