import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';

const base = { DATABASE_URL: 'postgres://x', SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', AI_API_KEY: 'a' };

describe('production configuration guards', () => {
  it('refuses fixture providers, fixture auth, local storage, development content and demo entitlements in production', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'production', PROVIDER_MODE: 'fixture' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, APP_ENV: 'production', AUTH_MODE: 'fixture' })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ ...base, APP_ENV: 'production', STORAGE_MODE: 'local', LOCAL_STORAGE_DIR: '/tmp/x' })).toThrow(/STORAGE_MODE/);
    expect(() => loadConfig({ ...base, APP_ENV: 'production', CONTENT_MANIFEST: 'development' })).toThrow(/CONTENT_MANIFEST/);
    expect(() => loadConfig({ ...base, APP_ENV: 'production', ALLOW_DEMO_ENTITLEMENTS: 'true' })).toThrow(/DEMO/);
  });

  it('requires provider and billing secrets when those integrations are enabled', () => {
    expect(() => loadConfig({ ...base, AI_API_KEY: '' })).toThrow(/AI_API_KEY/);
    expect(() => loadConfig({ ...base, BILLING_PROVIDER: 'revenuecat' })).toThrow(/REVENUECAT/);
  });

  it('accepts a complete production configuration', () => {
    const c = loadConfig({ ...base, APP_ENV: 'production', BILLING_PROVIDER: 'revenuecat', REVENUECAT_SECRET_API_KEY: 's', REVENUECAT_WEBHOOK_AUTH: 'w' });
    expect(c.isProduction).toBe(true);
    expect(c.PROVIDER_MODE).toBe('openai');
  });

  it('allows fixture mode for development and test', () => {
    const c = loadConfig({ APP_ENV: 'test', DATABASE_URL: 'postgres://x', AUTH_MODE: 'fixture', STORAGE_MODE: 'local', LOCAL_STORAGE_DIR: '/tmp/x', PROVIDER_MODE: 'fixture' });
    expect(c.PROVIDER_MODE).toBe('fixture');
  });
});
