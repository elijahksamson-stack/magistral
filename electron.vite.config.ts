import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * Three build targets: main, preload, renderer.
 *
 * `braindump` (the compiled N-API addon) and `bindings` are marked external so
 * rollup never tries to bundle a `.node` binary. The addon is resolved at
 * runtime from build/Release by app/main/addon-loader.ts.
 */
const ROOT = __dirname;

const ALIAS = {
  '@shared': resolve(ROOT, 'shared'),
  '@main': resolve(ROOT, 'app/main'),
  '@renderer': resolve(ROOT, 'app/renderer'),
};

/** Never bundled — resolved from disk at runtime, or not JS at all. */
const NATIVE_EXTERNALS = ['braindump', 'bindings'];

/**
 * officeparser's optional peers, for features this app does not use.
 *
 * It can GENERATE pdf/docx (puppeteer) and OCR scanned pages (tesseract).
 * BrainDump only ever extracts text, and OCR is off by default, so these
 * dynamic imports are never reached. Bundling them would add hundreds of
 * megabytes — puppeteer alone ships a browser — for code that never runs.
 */
const UNUSED_OPTIONAL_PEERS = [
  'puppeteer',
  'puppeteer-core',
  'tesseract.js',
  'canvas',
  'sharp',
];

/**
 * Dependencies that MUST be bundled rather than externalized.
 *
 * electron-builder's `files` excludes node_modules, so anything left external
 * simply is not present in the packaged app — an externalized import resolves
 * in `npm run dev` and throws MODULE_NOT_FOUND from the .dmg, which is the
 * worst place to find out. mammoth is pure JS, so bundling it is free.
 */
const BUNDLED_DEPS = ['mammoth', 'officeparser', 'word-extractor'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_DEPS })],
    resolve: { alias: ALIAS },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(ROOT, 'app/main/index.ts'),
        external: [...NATIVE_EXTERNALS, ...UNUSED_OPTIONAL_PEERS],
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: ALIAS },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(ROOT, 'app/preload/index.ts'),
        external: [...NATIVE_EXTERNALS, ...UNUSED_OPTIONAL_PEERS],
      },
    },
  },

  renderer: {
    root: resolve(ROOT, 'app/renderer'),
    plugins: [react()],
    resolve: { alias: ALIAS },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(ROOT, 'app/renderer/index.html'),
        external: [...NATIVE_EXTERNALS, ...UNUSED_OPTIONAL_PEERS],
      },
    },
  },
});
