import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Sidecars are their own mini-projects (own deps/pipeline, node:test
      // runner) — not part of the @zibby/skills package test run.
      'sidecars/**',
    ],
  },
});
