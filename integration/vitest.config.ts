import { defineConfig } from 'vitest/config';

// One runner container is shared by every scenario, in order: no parallelism, generous timeouts (a cold
// build installs Composer and npm packages; /validate runs a whole fixture build first).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 1_000_000,
    reporters: ['verbose'],
    // The scenarios share one runner and build on each other's state: stop at the first failure.
    bail: 1,
  },
});
