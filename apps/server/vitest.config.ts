import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.db.test.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
