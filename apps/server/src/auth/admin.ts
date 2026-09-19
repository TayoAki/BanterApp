import { createClient } from '@supabase/supabase-js';
import type { Db } from '../db/client.js';

/** Account administration needed by deletion: removing the auth identity. */
export interface AccountAdmin {
  deleteAuthUser(userId: string): Promise<void>;
}

export class SupabaseAccountAdmin implements AccountAdmin {
  private readonly client;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  async deleteAuthUser(userId: string): Promise<void> {
    const { error } = await this.client.auth.admin.deleteUser(userId);
    if (error && !/not found/i.test(error.message)) throw new Error(`auth admin: delete failed (${error.message})`);
  }
}

/** Plain-Postgres development/test stand-in. */
export class LocalAccountAdmin implements AccountAdmin {
  constructor(private readonly sql: Db) {}
  async deleteAuthUser(userId: string): Promise<void> {
    await this.sql`delete from auth.users where id = ${userId}`;
  }
}
