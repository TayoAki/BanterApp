import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// Pure-logic tests only (no React Native runtime). Device behavior is
// verified on physical builds per docs/07-verification.md. Native modules
// that leak into pure modules are stubbed here.
export default defineConfig({
  resolve: { alias: { 'expo-constants': path.resolve(here, 'src/__tests__/stubs/expo-constants.ts') } },
  test: { include: ['src/**/__tests__/**/*.test.ts'], environment: 'node' },
});
