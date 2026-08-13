import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two environments in one run.
 *
 * Main-process and pure-logic tests want plain node — they touch the
 * filesystem and spawn processes. Component tests want a DOM. Rather than
 * force one on the other, jsdom is scoped to `app/renderer/**` by path.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@main': resolve(__dirname, 'app/main'),
      '@renderer': resolve(__dirname, 'app/renderer'),
    },
  },
  test: {
    // Node by default: main-process tests touch the filesystem and spawn
    // processes. Component tests opt into a DOM with a
    // `@vitest-environment jsdom` docblock — vitest 4 removed
    // environmentMatchGlobs, and the docblock keeps the choice visible in the
    // file that needs it.
    environment: 'node',
    setupFiles: ['./app/renderer/__tests__/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
