import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, OPENROUTER_BASE_URL } from '../config.js';

const secret = 'test-jwt-secret-with-at-least-32-characters!!';
const railway = {
  DATABASE_URL: 'postgres://x',
  AUTH_MODE: 'password',
  AUTH_JWT_SECRET: secret,
  STORAGE_MODE: 's3',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's',
  S3_ENDPOINT: 'https://t3.storageapi.dev',
  TEXT_AI_API_KEY: 't',
  AUDIO_AI_API_KEY: 'a',
};
const supabase = { DATABASE_URL: 'postgres://x', AUTH_MODE: 'supabase', STORAGE_MODE: 'supabase', SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', TEXT_AI_PROVIDER: 'openai', AUDIO_AI_PROVIDER: 'openai', AI_API_KEY: 'a' };

describe('production configuration guards', () => {
  it('refuses fixture providers, fixture auth, local storage, development content and demo entitlements in production', () => {
    expect(() => loadConfig({ ...railway, APP_ENV: 'production', PROVIDER_MODE: 'fixture' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...railway, APP_ENV: 'production', AUTH_MODE: 'fixture' })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ ...railway, APP_ENV: 'production', STORAGE_MODE: 'local', LOCAL_STORAGE_DIR: '/tmp/x' })).toThrow(/STORAGE_MODE/);
    expect(() => loadConfig({ ...railway, APP_ENV: 'production', CONTENT_MANIFEST: 'development' })).toThrow(/CONTENT_MANIFEST/);
    expect(() => loadConfig({ ...railway, APP_ENV: 'production', ALLOW_DEMO_ENTITLEMENTS: 'true' })).toThrow(/DEMO/);
  });

  it('requires provider, auth, storage and billing secrets when those integrations are enabled', () => {
    expect(() => loadConfig({ ...railway, TEXT_AI_API_KEY: '' })).toThrow(/TEXT_AI_API_KEY/);
    expect(() => loadConfig({ ...railway, AUDIO_AI_API_KEY: '' })).toThrow(/AUDIO_AI_API_KEY/);
    expect(() => loadConfig({ ...railway, AUTH_JWT_SECRET: '' })).toThrow(/AUTH_JWT_SECRET/);
    expect(() => loadConfig({ ...railway, AUTH_JWT_SECRET: 'short' })).toThrow(/32 characters/);
    expect(() => loadConfig({ ...railway, S3_SECRET_ACCESS_KEY: '' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => loadConfig({ ...railway, BILLING_PROVIDER: 'revenuecat' })).toThrow(/REVENUECAT/);
    expect(() => loadConfig({ ...supabase, SUPABASE_URL: '' })).toThrow(/SUPABASE_URL/);
  });

  it('accepts a complete Railway production configuration with OpenRouter text and Gemini audio defaults', () => {
    const c = loadConfig({ ...railway, APP_ENV: 'production', BILLING_PROVIDER: 'revenuecat', REVENUECAT_SECRET_API_KEY: 's', REVENUECAT_WEBHOOK_AUTH: 'w' });
    expect(c.isProduction).toBe(true);
    expect(c.PROVIDER_MODE).toBe('live');
    expect(c.TEXT_AI_PROVIDER).toBe('openrouter');
    expect(c.TEXT_AI_API_STYLE).toBe('chat');
    expect(c.textBaseUrl).toBe(OPENROUTER_BASE_URL);
    expect(c.EVALUATION_MODEL).toBe('openai/gpt-5');
    expect(c.AUDIO_AI_PROVIDER).toBe('gemini');
    expect(c.TRANSCRIPTION_MODEL).toBe('gemini-3.5-transcribe');
    expect(c.TTS_VOICE).toBe('Kore');
    expect(c.STORAGE_BUCKET_AUDIO).toBe('b');
    expect(c.textApiKey).toBe('t');
    expect(c.audioApiKey).toBe('a');
  });

  it('accepts the Supabase + OpenAI configuration with the legacy single key', () => {
    const c = loadConfig({ ...supabase, APP_ENV: 'production' });
    expect(c.TEXT_AI_API_STYLE).toBe('responses');
    expect(c.textBaseUrl).toBeNull();
    expect(c.EVALUATION_MODEL).toBe('gpt-5');
    expect(c.TRANSCRIPTION_MODEL).toBe('gpt-4o-transcribe');
    expect(c.textApiKey).toBe('a');
    expect(c.audioApiKey).toBe('a');
    expect(c.STORAGE_BUCKET_AUDIO).toBe('practice-audio');
  });

  it('does not let the legacy OpenAI key stand in for a Gemini audio key', () => {
    expect(() => loadConfig({ ...railway, AUDIO_AI_API_KEY: '', AI_API_KEY: 'openai-key' })).toThrow(/AUDIO_AI_API_KEY/);
  });

  it('allows fixture mode for development and test', () => {
    const c = loadConfig({ APP_ENV: 'test', DATABASE_URL: 'postgres://x', AUTH_MODE: 'fixture', STORAGE_MODE: 'local', LOCAL_STORAGE_DIR: '/tmp/x', PROVIDER_MODE: 'fixture' });
    expect(c.PROVIDER_MODE).toBe('fixture');
    expect(c.textApiKey).toBeNull();
  });
});
