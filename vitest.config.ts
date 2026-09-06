import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true
      }
    },
    globals: true
  },
  css: {
    postcss: {}
  }
});
