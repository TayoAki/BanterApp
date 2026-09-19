import { beforeAll } from 'vitest';
import postgres from 'postgres';
import { migrate } from '../db/migrate.js';

/**
 * Resets the disposable test database before each test file: drops the
 * public schema (and the local auth stub), re-applies every migration, so
 * tests always run against the migration files exactly as committed.
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';

beforeAll(async () => {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for *.db.test.ts');
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    drop schema if exists public cascade;
    create schema public;
    drop schema if exists auth cascade;
    grant all on schema public to public;
  `);
  await migrate(sql);
  await sql.end();
});
