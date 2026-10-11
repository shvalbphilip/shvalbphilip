import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { root: '.', include: ['server/test/**/*.test.ts'], environment: 'node', testTimeout: 15000, pool: 'forks' },
});
