import { defineConfig } from 'vitest/config';

// Database-backed tests. Require TEST_DATABASE_URL pointing at a disposable
// PostgreSQL 15+ database (a Supabase local stack or any plain Postgres).
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    setupFiles: ['src/__tests__/db-setup.ts'],
  },
});
