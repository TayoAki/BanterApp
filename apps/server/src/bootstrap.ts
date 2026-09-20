import { LocalAccountAdmin, PasswordAccountAdmin, SupabaseAccountAdmin, type AccountAdmin } from './auth/admin.js';
import { describeConfigForLog, loadConfig, type ServerConfig } from './config.js';
import { Catalog, seedContentVersions } from './content/catalog.js';
import type { ServerContext } from './context.js';
import { createDb, type Db } from './db/client.js';
import { migrate } from './db/migrate.js';
import { createLogger, type Logger } from './logger.js';
import { createProviders } from './providers/index.js';
import type { Providers } from './providers/types.js';
import { LocalStorage } from './storage/local.js';
import { S3Storage } from './storage/s3.js';
import { SupabaseStorage } from './storage/supabase.js';
import type { ObjectStorage } from './storage/types.js';

export interface ContextOverrides {
  sql?: Db;
  storage?: ObjectStorage;
  accounts?: AccountAdmin;
  providers?: Providers;
  catalog?: Catalog;
  log?: Logger;
  now?: () => Date;
}

export function createStorage(config: ServerConfig): ObjectStorage {
  switch (config.STORAGE_MODE) {
    case 'local': {
      if (config.isProduction) throw new Error('Local storage is forbidden in production');
      const base = config.PUBLIC_API_BASE_URL ?? `http://localhost:${config.PORT}`;
      return new LocalStorage(config.LOCAL_STORAGE_DIR!, base);
    }
    case 's3':
      return new S3Storage({
        bucket: config.S3_BUCKET!,
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
        region: config.S3_REGION,
        endpoint: config.S3_ENDPOINT,
        forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true',
      });
    default:
      return new SupabaseStorage(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, config.STORAGE_BUCKET_AUDIO);
  }
}

/** Account administration follows the auth mode, not the storage mode. */
export function createAccounts(config: ServerConfig, sql: Db): AccountAdmin {
  switch (config.AUTH_MODE) {
    case 'supabase':
      if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to delete Supabase accounts');
      return new SupabaseAccountAdmin(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    case 'password':
      return new PasswordAccountAdmin(sql);
    default:
      return new LocalAccountAdmin(sql);
  }
}

export function createContext(config: ServerConfig, overrides: ContextOverrides = {}): ServerContext {
  const log = overrides.log ?? createLogger(config.LOG_LEVEL);
  const sql = overrides.sql ?? createDb(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  const catalog = overrides.catalog ?? new Catalog(config.CONTENT_MANIFEST);
  if (config.isProduction && catalog.manifest.manifest !== 'production') throw new Error('Production refuses a non-production content manifest');
  return {
    config,
    sql,
    storage: overrides.storage ?? createStorage(config),
    accounts: overrides.accounts ?? createAccounts(config, sql),
    providers: overrides.providers ?? createProviders(config),
    catalog,
    log,
    now: overrides.now ?? (() => new Date()),
  };
}

/** Applies pending migrations and refreshes content versions. Safe to run on every start. */
export async function prepareDatabase(ctx: ServerContext): Promise<void> {
  // Every table forces RLS with no policies for the server role; the server must connect as a
  // role that bypasses RLS (the Railway/plain-Postgres superuser or the Supabase service
  // connection). Anything else would fail silently on every private read, so refuse to start in production.
  const role = (await ctx.sql<{ ok: boolean; name: string }[]>`select (rolbypassrls or rolsuper) as ok, rolname as name from pg_roles where rolname = current_user`)[0];
  if (!role?.ok) {
    const message = `Database role ${role?.name ?? 'unknown'} does not bypass row level security; use the service connection.`;
    if (ctx.config.isProduction) throw new Error(message);
    ctx.log.warn(message);
  }
  const applied = await migrate(ctx.sql, (m) => ctx.log.info({ migration: m }, 'migration'));
  if (applied.length > 0) ctx.log.info({ count: applied.length }, 'migrations applied');
  await seedContentVersions(ctx.sql, ctx.catalog);
}

export function bootLog(ctx: ServerContext): void {
  ctx.log.info(describeConfigForLog(ctx.config), 'configuration loaded');
}

export { loadConfig };
