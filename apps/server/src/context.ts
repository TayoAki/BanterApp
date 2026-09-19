import type { AccountAdmin } from './auth/admin.js';
import type { ServerConfig } from './config.js';
import type { Catalog } from './content/catalog.js';
import type { Db } from './db/client.js';
import type { Logger } from './logger.js';
import type { Providers } from './providers/types.js';
import type { ObjectStorage } from './storage/types.js';

/** Everything a request handler or job handler needs; built once at startup. */
export interface ServerContext {
  config: ServerConfig;
  sql: Db;
  storage: ObjectStorage;
  accounts: AccountAdmin;
  providers: Providers;
  catalog: Catalog;
  log: Logger;
  now: () => Date;
}

export interface Actor {
  userId: string;
  email: string | null;
  editor: boolean;
  deletionGeneration: number;
  authTime: number | null;
}
