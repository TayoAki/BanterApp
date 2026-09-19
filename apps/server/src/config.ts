import { z } from 'zod';

/**
 * Server configuration. Production startup fails on absent required secrets
 * or accidental fixture mode. Nothing here is ever logged in full.
 */

const AppEnv = z.enum(['development', 'test', 'production']);
const ProviderMode = z.enum(['openai', 'fixture']);
const StorageMode = z.enum(['supabase', 'local']);
const AuthMode = z.enum(['supabase', 'fixture']);

const base = z.object({
  APP_ENV: AppEnv.default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_API_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  AUTH_MODE: AuthMode.default('supabase'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),

  STORAGE_MODE: StorageMode.default('supabase'),
  STORAGE_BUCKET_AUDIO: z.string().default('practice-audio'),
  LOCAL_STORAGE_DIR: z.string().optional(),

  PROVIDER_MODE: ProviderMode.default('openai'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  TRANSCRIPTION_MODEL: z.string().default('gpt-4o-transcribe'),
  EVALUATION_MODEL: z.string().default('gpt-5'),
  REWRITE_MODEL: z.string().default('gpt-5'),
  VERIFIER_MODEL: z.string().default('gpt-5-mini'),
  ROLEPLAY_MODEL: z.string().default('gpt-5-mini'),
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_VOICE: z.string().default('alloy'),
  PROMPT_CONFIG_VERSION: z.string().default('prompts-v1'),

  CONTENT_MANIFEST: z.enum(['production', 'development']).default('production'),

  BILLING_PROVIDER: z.enum(['revenuecat', 'none']).default('none'),
  REVENUECAT_SECRET_API_KEY: z.string().optional(),
  REVENUECAT_WEBHOOK_AUTH: z.string().optional(),
  REVENUECAT_PRO_ENTITLEMENT_ID: z.string().default('pro'),
  REVENUECAT_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  ALLOW_DEMO_ENTITLEMENTS: z.enum(['true', 'false']).default('false'),

  FREE_SESSIONS_PER_UTC_DAY: z.coerce.number().int().min(0).default(1),
  PRO_SESSIONS_PER_UTC_DAY: z.coerce.number().int().min(0).default(10),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(120),
  RAW_AUDIO_TTL_HOURS: z.coerce.number().int().positive().default(24),
  TTS_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PLAYBACK_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  MAX_TIMEZONE_CHANGES_PER_DAY: z.coerce.number().int().positive().default(3),

  WORKER_ID: z.string().optional(),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  TIMEOUT_TRANSCRIBE_MS: z.coerce.number().int().positive().default(60_000),
  TIMEOUT_EVALUATE_MS: z.coerce.number().int().positive().default(30_000),
  TIMEOUT_REWRITE_MS: z.coerce.number().int().positive().default(30_000),
  TIMEOUT_VERIFY_MS: z.coerce.number().int().positive().default(30_000),
  TIMEOUT_TTS_MS: z.coerce.number().int().positive().default(45_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONITORING_DSN: z.string().optional(),
});

export type ServerConfig = z.infer<typeof base> & {
  isProduction: boolean;
  workerId: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = base.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid server configuration: ${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.APP_ENV === 'production';
  const problems: string[] = [];

  if (isProduction) {
    if (c.PROVIDER_MODE !== 'openai') problems.push('PROVIDER_MODE must be openai in production (fixture providers are forbidden)');
    if (c.AUTH_MODE !== 'supabase') problems.push('AUTH_MODE must be supabase in production');
    if (c.STORAGE_MODE !== 'supabase') problems.push('STORAGE_MODE must be supabase in production');
    if (c.CONTENT_MANIFEST !== 'production') problems.push('CONTENT_MANIFEST must be production (development preview publishes unreviewed drafts)');
    if (c.ALLOW_DEMO_ENTITLEMENTS === 'true') problems.push('ALLOW_DEMO_ENTITLEMENTS cannot be enabled in production');
    if (!c.DATABASE_URL.startsWith('postgres')) problems.push('DATABASE_URL must be a postgres connection string');
  }
  if (c.PROVIDER_MODE === 'openai' && !c.AI_API_KEY) problems.push('AI_API_KEY is required when PROVIDER_MODE=openai');
  if (c.AUTH_MODE === 'supabase') {
    if (!c.SUPABASE_URL) problems.push('SUPABASE_URL is required when AUTH_MODE=supabase');
  }
  if (c.STORAGE_MODE === 'supabase') {
    if (!c.SUPABASE_URL) problems.push('SUPABASE_URL is required when STORAGE_MODE=supabase');
    if (!c.SUPABASE_SERVICE_ROLE_KEY) problems.push('SUPABASE_SERVICE_ROLE_KEY is required when STORAGE_MODE=supabase');
  }
  if (c.STORAGE_MODE === 'local' && !c.LOCAL_STORAGE_DIR) problems.push('LOCAL_STORAGE_DIR is required when STORAGE_MODE=local');
  if (c.BILLING_PROVIDER === 'revenuecat') {
    if (!c.REVENUECAT_WEBHOOK_AUTH) problems.push('REVENUECAT_WEBHOOK_AUTH is required when BILLING_PROVIDER=revenuecat');
    if (!c.REVENUECAT_SECRET_API_KEY) problems.push('REVENUECAT_SECRET_API_KEY is required when BILLING_PROVIDER=revenuecat');
  }
  if (problems.length > 0) throw new ConfigError(`Refusing to start: ${problems.join('; ')}`);

  return {
    ...c,
    isProduction,
    workerId: c.WORKER_ID ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/** Names of variables whose values must never be logged. */
export const SECRET_ENV_NAMES = [
  'DATABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'AI_API_KEY',
  'REVENUECAT_SECRET_API_KEY',
  'REVENUECAT_WEBHOOK_AUTH',
  'MONITORING_DSN',
] as const;

export function describeConfigForLog(c: ServerConfig): Record<string, unknown> {
  return {
    app_env: c.APP_ENV,
    provider_mode: c.PROVIDER_MODE,
    auth_mode: c.AUTH_MODE,
    storage_mode: c.STORAGE_MODE,
    content_manifest: c.CONTENT_MANIFEST,
    billing_provider: c.BILLING_PROVIDER,
    models: {
      transcription: c.TRANSCRIPTION_MODEL,
      evaluation: c.EVALUATION_MODEL,
      rewrite: c.REWRITE_MODEL,
      verifier: c.VERIFIER_MODEL,
      roleplay: c.ROLEPLAY_MODEL,
      tts: c.TTS_MODEL,
      tts_voice: c.TTS_VOICE,
    },
    prompt_config_version: c.PROMPT_CONFIG_VERSION,
    has_ai_key: Boolean(c.AI_API_KEY),
    has_service_role_key: Boolean(c.SUPABASE_SERVICE_ROLE_KEY),
  };
}
