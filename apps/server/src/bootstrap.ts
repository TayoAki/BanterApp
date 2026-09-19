import { LocalAccountAdmin, SupabaseAccountAdmin, type AccountAdmin } from './auth/admin.js';
import { describeConfigForLog, loadConfig, type ServerConfig } from './config.js';
import { Catalog, seedContentVersions } from './content/catalog.js';
import type { ServerContext } from './context.js';
import { createDb, type Db } from './db/client.js';
import { migrate } from './db/migrate.js';
import { createLogger, type Logger } from './logger.js';
import { createProviders } from './providers/index.js';
import type { Providers } from './providers/types.js';
import { LocalStorage } from './storage/local.js';
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

export function createStorage(config: ServerConfig, sql: Db): { storage: ObjectStorage; accounts: AccountAdmin } {
  if (config.STORAGE_MODE === 'local') {
    if (config.isProduction) throw new Error('Local storage is forbidden in production');
    const base = config.PUBLIC_API_BASE_URL ?? `http://localhost:${config.PORT}`;
    return { storage: new LocalStorage(config.LOCAL_STORAGE_DIR!, base), accounts: new LocalAccountAdmin(sql) };
  }
  return {
    storage: new SupabaseStorage(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, config.STORAGE_BUCKET_AUDIO),
    accounts: new SupabaseAccountAdmin(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!),
  };
}

export function createContext(config: ServerConfig, overrides: ContextOverrides = {}): ServerContext {
  const log = overrides.log ?? createLogger(config.LOG_LEVEL);
  const sql = overrides.sql ?? createDb(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  const built = overrides.storage && overrides.accounts ? null : createStorage(config, sql);
  const catalog = overrides.catalog ?? new Catalog(config.CONTENT_MANIFEST);
  if (config.isProduction && catalog.manifest.manifest !== 'production') throw new Error('Production refuses a non-production content manifest');
  return {
    config,
    sql,
    storage: overrides.storage ?? built!.storage,
    accounts: overrides.accounts ?? built!.accounts,
    providers: overrides.providers ?? createProviders(config),
    catalog,
    log,
    now: overrides.now ?? (() => new Date()),
  };
}

/** Applies pending migrations and refreshes content versions. Safe to run on every start. */
export async function prepareDatabase(ctx: ServerContext): Promise<void> {
  const applied = await migrate(ctx.sql, (m) => ctx.log.info({ migration: m }, 'migration'));
  if (applied.length > 0) ctx.log.info({ count: applied.length }, 'migrations applied');
  await seedContentVersions(ctx.sql, ctx.catalog);
}

export function bootLog(ctx: ServerContext): void {
  ctx.log.info(describeConfigForLog(ctx.config), 'configuration loaded');
}

export { loadConfig };
