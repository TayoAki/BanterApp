import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { LocalAccountAdmin } from '../auth/admin.js';
import { createFixtureVerifier } from '../auth/verify.js';
import { createContext, prepareDatabase } from '../bootstrap.js';
import { loadConfig, type ServerConfig } from '../config.js';
import type { ServerContext } from '../context.js';
import { createDb } from '../db/client.js';
import { createApp, type Env } from '../http/app.js';
import { noopLogger } from '../logger.js';
import { createFixtureProviders, DemoEntitlements } from '../providers/fixture.js';
import { LocalStorage } from '../storage/local.js';
import { Worker } from '../worker/loop.js';
import { TEST_DATABASE_URL } from './db-setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_M4A = readFileSync(path.resolve(here, '../media/__fixtures__/tone-1_5s-mono.m4a'));
export const FIXTURE_MP3 = readFileSync(path.resolve(here, '../media/__fixtures__/tone-0_5s.mp3'));

export const USER_A = '11111111-1111-4111-8111-111111111111';
export const USER_B = '22222222-2222-4222-8222-222222222222';

export function testConfig(overrides: Partial<Record<string, string>> = {}): ServerConfig {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_MODE: 'fixture',
    STORAGE_MODE: 'local',
    LOCAL_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'mm-storage-')),
    PROVIDER_MODE: 'fixture',
    CONTENT_MANIFEST: 'development',
    PUBLIC_API_BASE_URL: 'http://test.local',
    ALLOW_DEMO_ENTITLEMENTS: 'true',
    RESERVATION_TTL_MINUTES: '120',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export interface TestHarness {
  ctx: ServerContext;
  app: Hono<Env>;
  worker: Worker;
  demo: DemoEntitlements;
  storage: LocalStorage;
  setNow: (d: Date) => void;
  close: () => Promise<void>;
}

export async function createHarness(overrides: Partial<Record<string, string>> = {}): Promise<TestHarness> {
  const config = testConfig(overrides);
  const sql = createDb(config.DATABASE_URL, { max: 5 });
  const demo = new DemoEntitlements();
  const storage = new LocalStorage(config.LOCAL_STORAGE_DIR!, 'http://test.local', 'test-secret');
  let now = new Date();
  const ctx = createContext(config, {
    sql,
    storage,
    accounts: new LocalAccountAdmin(sql),
    providers: createFixtureProviders({ entitlements: demo }),
    log: noopLogger,
    now: () => now,
  });
  await prepareDatabase(ctx);
  // Fixture identities for most suites; password mode exercises the real verifier and /v1/auth routes.
  const app = createApp(ctx, config.AUTH_MODE === 'fixture' ? { verifier: createFixtureVerifier(config) } : {});
  return {
    ctx,
    app,
    worker: new Worker(ctx),
    demo,
    storage,
    setNow: (d) => {
      now = d;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export async function api<T = unknown>(
  app: Hono<Env>,
  method: string,
  url: string,
  options: { user?: string | null; body?: unknown; authTime?: number; raw?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: T; headers: Headers }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.user !== null && options.user !== undefined) headers['authorization'] = `Bearer fixture:${options.user}${options.authTime ? `:${options.authTime}` : ''}`;
  let body: string | undefined;
  if (options.raw !== undefined) body = options.raw;
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const res = await app.request(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as T, headers: res.headers };
}

export function key(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}-0123456789abcdef`;
}

/** Uploads bytes to a LocalStorage signed URL served by the same Hono app. */
export async function uploadToSignedUrl(app: Hono<Env>, uploadUrl: string, bytes: Buffer, mime: string): Promise<number> {
  const u = new URL(uploadUrl);
  const res = await app.request(`${u.pathname}${u.search}`, { method: 'PUT', headers: { 'content-type': mime }, body: new Uint8Array(bytes) });
  return res.status;
}
