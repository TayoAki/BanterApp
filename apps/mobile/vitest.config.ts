import { defineConfig } from 'vitest/config';

// Pure-logic tests only (no React Native runtime). Device behavior is
// verified on physical builds per docs/07-verification.md.
export default defineConfig({
  test: { include: ['src/**/__tests__/**/*.test.ts'], environment: 'node' },
});
