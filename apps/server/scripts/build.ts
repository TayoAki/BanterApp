import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Bundles the API and worker entry points for Node 22. Workspace packages
 * (@marshmemos/*) are TypeScript sources and are bundled in; third-party
 * dependencies stay external and are resolved from node_modules at runtime.
 * Prompts, migrations and the local auth stub are copied next to the bundle
 * so the container does not need the repository layout.
 */
await build({
  entryPoints: { api: 'src/entry/api.ts', worker: 'src/entry/worker.ts', migrate: 'src/db/migrate.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  plugins: [
    {
      name: 'bundle-workspace-packages',
      setup(b) {
        // `packages: 'external'` would externalize these too; map them to their TypeScript sources instead.
        const workspace: Record<string, string> = {
          '@marshmemos/contracts': '../../packages/contracts/src/index.ts',
          '@marshmemos/contracts/api': '../../packages/contracts/src/api.ts',
          '@marshmemos/contracts/types': '../../packages/contracts/src/types.ts',
          '@marshmemos/content': '../../packages/content/src/index.ts',
        };
        b.onResolve({ filter: /^@marshmemos\// }, (args) => {
          const target = workspace[args.path];
          if (!target) return { errors: [{ text: `Unknown workspace import ${args.path}` }] };
          return { path: path.resolve(target) };
        });
      },
    },
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
mkdirSync('dist/prompts', { recursive: true });
cpSync('prompts', 'dist/prompts', { recursive: true });
mkdirSync('dist/migrations', { recursive: true });
cpSync('../../supabase/migrations', 'dist/migrations', { recursive: true });
mkdirSync('dist/local', { recursive: true });
cpSync('../../supabase/local/auth_stub.sql', 'dist/local/auth_stub.sql');
console.log('built dist/api.js, dist/worker.js, dist/migrate.js (+ prompts, migrations, auth stub)');
