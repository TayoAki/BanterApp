import { z } from 'zod';

/**
 * Server configuration. Production startup fails on absent required secrets
 * or accidental fixture mode. Nothing here is ever logged in full.
 *
 * Deployment target: Railway (Postgres + Buckets + two services) with
 * server-managed email/password accounts, OpenRouter for the text models and
 * Gemini for speech-to-text and text-to-speech. Supabase auth/storage and
 * direct OpenAI audio remain selectable for operators who already run them.
 */

const AppEnv = z.enum(['development', 'test', 'production']);
const ProviderMode = z.enum(['live', 'fixture']);
const TextProvider = z.enum(['openrouter', 'openai']);
const TextApiStyle = z.enum(['chat', 'responses']);
const AudioProvider = z.enum(['gemini', 'openai']);
const TranscribeApi = z.enum(['auto', 'interactions', 'generate_content']);
const StorageMode = z.enum(['s3', 'supabase', 'local']);
const AuthMode = z.enum(['password', 'supabase', 'fixture']);
const Flag = z.enum(['true', 'false']);

const base = z.object({
  APP_ENV: AppEnv.default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_API_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Accounts. `password`: server-managed email + password (HS256 access tokens,
  // rotating refresh tokens). `supabase`: Supabase Auth tokens. `fixture`: dev/test only.
  AUTH_MODE: AuthMode.default('password'),
  AUTH_JWT_SECRET: z.string().optional(),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3600),
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),

  // Object storage. `s3`: any S3-compatible bucket (Railway Buckets, AWS S3, R2).
  STORAGE_MODE: StorageMode.default('s3'),
  STORAGE_BUCKET_AUDIO: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: Flag.default('false'),
  LOCAL_STORAGE_DIR: z.string().optional(),

  // Models. `live` wires the configured text and audio providers; `fixture` is dev/test only.
  PROVIDER_MODE: ProviderMode.default('live'),
  TEXT_AI_PROVIDER: TextProvider.default('openrouter'),
  TEXT_AI_API_KEY: z.string().optional(),
  TEXT_AI_BASE_URL: z.string().url().optional(),
  TEXT_AI_API_STYLE: TextApiStyle.optional(),
  AUDIO_AI_PROVIDER: AudioProvider.default('gemini'),
  AUDIO_AI_API_KEY: z.string().optional(),
  AUDIO_AI_BASE_URL: z.string().url().optional(),
  AUDIO_AI_TRANSCRIBE_API: TranscribeApi.default('auto'),
  /** Legacy single-key configuration (OpenAI for everything). Used only as a fallback. */
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  TRANSCRIPTION_MODEL: z.string().min(1).optional(),
  EVALUATION_MODEL: z.string().min(1).optional(),
  REWRITE_MODEL: z.string().min(1).optional(),
  VERIFIER_MODEL: z.string().min(1).optional(),
  ROLEPLAY_MODEL: z.string().min(1).optional(),
  TTS_MODEL: z.string().min(1).optional(),
  TTS_VOICE: z.string().min(1).optional(),
  PROMPT_CONFIG_VERSION: z.string().default('prompts-v1'),

  CONTENT_MANIFEST: z.enum(['production', 'development']).default('production'),

  BILLING_PROVIDER: z.enum(['revenuecat', 'none']).default('none'),
  REVENUECAT_SECRET_API_KEY: z.string().optional(),
  REVENUECAT_WEBHOOK_AUTH: z.string().optional(),
  REVENUECAT_PRO_ENTITLEMENT_ID: z.string().default('pro'),
  REVENUECAT_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  ALLOW_DEMO_ENTITLEMENTS: Flag.default('false'),

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

type Parsed = z.infer<typeof base>;
type ResolvedKeys = 'TRANSCRIPTION_MODEL' | 'EVALUATION_MODEL' | 'REWRITE_MODEL' | 'VERIFIER_MODEL' | 'ROLEPLAY_MODEL' | 'TTS_MODEL' | 'TTS_VOICE' | 'TEXT_AI_API_STYLE' | 'STORAGE_BUCKET_AUDIO';

export type ServerConfig = Omit<Parsed, ResolvedKeys> & {
  TRANSCRIPTION_MODEL: string;
  EVALUATION_MODEL: string;
  REWRITE_MODEL: string;
  VERIFIER_MODEL: string;
  ROLEPLAY_MODEL: string;
  TTS_MODEL: string;
  TTS_VOICE: string;
  TEXT_AI_API_STYLE: 'chat' | 'responses';
  /** Bucket name recorded on audio asset rows (equals S3_BUCKET in s3 mode). */
  STORAGE_BUCKET_AUDIO: string;
  /** Resolved API keys (specific variable first, legacy AI_API_KEY as fallback). Never logged. */
  textApiKey: string | null;
  audioApiKey: string | null;
  /** Resolved base URL for the OpenAI-compatible text endpoint. */
  textBaseUrl: string | null;
  isProduction: boolean;
  workerId: string;
};

/** Default model IDs per provider. All are configuration; none is verified until a live call is recorded in PLAN.md. */
export const TEXT_MODEL_DEFAULTS = {
  openrouter: { evaluation: 'openai/gpt-5', rewrite: 'openai/gpt-5', verifier: 'openai/gpt-5-mini', roleplay: 'openai/gpt-5-mini' },
  openai: { evaluation: 'gpt-5', rewrite: 'gpt-5', verifier: 'gpt-5-mini', roleplay: 'gpt-5-mini' },
} as const;

export const AUDIO_MODEL_DEFAULTS = {
  gemini: { transcription: 'gemini-3.5-transcribe', tts: 'gemini-3.1-flash-tts-preview', voice: 'Kore' },
  openai: { transcription: 'gpt-4o-transcribe', tts: 'gpt-4o-mini-tts', voice: 'alloy' },
} as const;

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
    if (c.PROVIDER_MODE !== 'live') problems.push('PROVIDER_MODE must be live in production (fixture providers are forbidden)');
    if (c.AUTH_MODE === 'fixture') problems.push('AUTH_MODE must be password or supabase in production');
    if (c.STORAGE_MODE === 'local') problems.push('STORAGE_MODE must be s3 or supabase in production');
    if (c.CONTENT_MANIFEST !== 'production') problems.push('CONTENT_MANIFEST must be production (development preview publishes unreviewed drafts)');
    if (c.ALLOW_DEMO_ENTITLEMENTS === 'true') problems.push('ALLOW_DEMO_ENTITLEMENTS cannot be enabled in production');
    if (!c.DATABASE_URL.startsWith('postgres')) problems.push('DATABASE_URL must be a postgres connection string');
  }

  const textApiKey = c.TEXT_AI_API_KEY ?? c.AI_API_KEY ?? null;
  const audioApiKey = c.AUDIO_AI_API_KEY ?? (c.AUDIO_AI_PROVIDER === 'openai' ? c.AI_API_KEY : undefined) ?? null;
  if (c.PROVIDER_MODE === 'live') {
    if (!textApiKey) problems.push(`TEXT_AI_API_KEY is required when PROVIDER_MODE=live (TEXT_AI_PROVIDER=${c.TEXT_AI_PROVIDER})`);
    if (!audioApiKey) problems.push(`AUDIO_AI_API_KEY is required when PROVIDER_MODE=live (AUDIO_AI_PROVIDER=${c.AUDIO_AI_PROVIDER})`);
  }
  if (c.AUTH_MODE === 'password') {
    if (!c.AUTH_JWT_SECRET) problems.push('AUTH_JWT_SECRET is required when AUTH_MODE=password');
    else if (c.AUTH_JWT_SECRET.length < 32) problems.push('AUTH_JWT_SECRET must be at least 32 characters');
  }
  if (c.AUTH_MODE === 'supabase' && !c.SUPABASE_URL) problems.push('SUPABASE_URL is required when AUTH_MODE=supabase');
  if (c.STORAGE_MODE === 's3') {
    if (!c.S3_BUCKET) problems.push('S3_BUCKET is required when STORAGE_MODE=s3');
    if (!c.S3_ACCESS_KEY_ID) problems.push('S3_ACCESS_KEY_ID is required when STORAGE_MODE=s3');
    if (!c.S3_SECRET_ACCESS_KEY) problems.push('S3_SECRET_ACCESS_KEY is required when STORAGE_MODE=s3');
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

  const text = TEXT_MODEL_DEFAULTS[c.TEXT_AI_PROVIDER];
  const audio = AUDIO_MODEL_DEFAULTS[c.AUDIO_AI_PROVIDER];
  const textBaseUrl = c.TEXT_AI_BASE_URL ?? (c.TEXT_AI_PROVIDER === 'openrouter' ? OPENROUTER_BASE_URL : c.AI_BASE_URL ?? null);
  const storageBucket = c.STORAGE_MODE === 's3' ? c.S3_BUCKET! : c.STORAGE_BUCKET_AUDIO ?? 'practice-audio';

  return {
    ...c,
    TRANSCRIPTION_MODEL: c.TRANSCRIPTION_MODEL ?? audio.transcription,
    EVALUATION_MODEL: c.EVALUATION_MODEL ?? text.evaluation,
    REWRITE_MODEL: c.REWRITE_MODEL ?? text.rewrite,
    VERIFIER_MODEL: c.VERIFIER_MODEL ?? text.verifier,
    ROLEPLAY_MODEL: c.ROLEPLAY_MODEL ?? text.roleplay,
    TTS_MODEL: c.TTS_MODEL ?? audio.tts,
    TTS_VOICE: c.TTS_VOICE ?? audio.voice,
    TEXT_AI_API_STYLE: c.TEXT_AI_API_STYLE ?? (c.TEXT_AI_PROVIDER === 'openrouter' ? 'chat' : 'responses'),
    STORAGE_BUCKET_AUDIO: storageBucket,
    textApiKey,
    audioApiKey,
    textBaseUrl,
    isProduction,
    workerId: c.WORKER_ID ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/** Names of variables whose values must never be logged. */
export const SECRET_ENV_NAMES = [
  'DATABASE_URL',
  'AUTH_JWT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'TEXT_AI_API_KEY',
  'AUDIO_AI_API_KEY',
  'AI_API_KEY',
  'REVENUECAT_SECRET_API_KEY',
  'REVENUECAT_WEBHOOK_AUTH',
  'MONITORING_DSN',
] as const;

export function describeConfigForLog(c: ServerConfig): Record<string, unknown> {
  return {
    app_env: c.APP_ENV,
    provider_mode: c.PROVIDER_MODE,
    text_provider: c.TEXT_AI_PROVIDER,
    text_api_style: c.TEXT_AI_API_STYLE,
    text_base_url: c.textBaseUrl,
    audio_provider: c.AUDIO_AI_PROVIDER,
    audio_transcribe_api: c.AUDIO_AI_TRANSCRIBE_API,
    auth_mode: c.AUTH_MODE,
    storage_mode: c.STORAGE_MODE,
    storage_endpoint: c.S3_ENDPOINT ? new URL(c.S3_ENDPOINT).host : null,
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
    has_text_key: Boolean(c.textApiKey),
    has_audio_key: Boolean(c.audioApiKey),
    has_jwt_secret: Boolean(c.AUTH_JWT_SECRET),
    has_service_role_key: Boolean(c.SUPABASE_SERVICE_ROLE_KEY),
  };
}
