import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

/** Bundles the API and worker entry points for Node 22. Prompts and media fixtures are copied alongside. */
await build({
  entryPoints: { api: 'src/entry/api.ts', worker: 'src/entry/worker.ts', migrate: 'src/db/migrate.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
mkdirSync('dist/prompts', { recursive: true });
cpSync('prompts', 'dist/prompts', { recursive: true });
console.log('built dist/api.js, dist/worker.js, dist/migrate.js');
