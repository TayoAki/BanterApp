import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';
import { createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** First existing candidate: the bundled copy next to dist/, then the repository layout. */
function firstExisting(candidates: string[]): string {
  return candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1]!;
}

export const MIGRATIONS_DIR = firstExisting([path.resolve(here, 'migrations'), path.resolve(here, '../../../../supabase/migrations')]);
export const LOCAL_AUTH_STUB = firstExisting([path.resolve(here, 'local/auth_stub.sql'), path.resolve(here, '../../../../supabase/local/auth_stub.sql')]);

/** Stable advisory lock key so concurrently starting api/worker processes migrate one at a time. */
const MIGRATE_LOCK_KEY = 'marshmemos:migrate';

/**
 * Applies supabase/migrations/*.sql in filename order exactly once each,
 * tracked in public.schema_migrations, under a transaction-scoped advisory
 * lock (the API and the worker both migrate on start and may race). On a
 * plain PostgreSQL (Railway, tests, local development) the auth stub is
 * applied first so auth.users/auth.uid() exist. On Supabase it is skipped.
 */
export async function migrate(sql: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${MIGRATE_LOCK_KEY}))`;
    const hasAuth = await tx<{ exists: boolean }[]>`
      select exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users') as exists`;
    if (!hasAuth[0]?.exists) {
      if (!existsSync(LOCAL_AUTH_STUB)) throw new Error('auth.users missing and no local auth stub found');
      await tx.unsafe(readFileSync(LOCAL_AUTH_STUB, 'utf8'));
      log('applied local auth stub (non-Supabase database)');
    }
    await tx`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await tx<{ name: string }[]>`select name from public.schema_migrations`).map((r) => r.name));
    if (!existsSync(MIGRATIONS_DIR)) throw new Error(`migrations directory not found at ${MIGRATIONS_DIR}`);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const done: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await tx.unsafe(body);
      await tx`insert into public.schema_migrations (name) values (${file})`;
      done.push(file);
      log(`applied ${file}`);
    }
    return done;
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const sql = createDb(url, { max: 1 });
  migrate(sql, (m) => console.log(m))
    .then((done) => {
      console.log(done.length ? `applied ${done.length} migration(s)` : 'schema up to date');
      return sql.end();
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
