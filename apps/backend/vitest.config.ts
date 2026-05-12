import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 4: pool options are top-level (no more nested poolOptions).
    // Serial execution: backend tests share the dev DB, so parallelism
    // would cause cross-test pollution.
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
