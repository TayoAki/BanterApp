import pino from 'pino';

/**
 * Structured logger. Never log bearer tokens, connection strings, uploaded
 * audio, transcripts, or full provider/billing payloads. Redaction paths
 * below are defense in depth for accidental inclusion.
 */
export type Logger = pino.Logger;

export function createLogger(level: string = process.env['LOG_LEVEL'] ?? 'info'): Logger {
  return pino({
    level,
    base: { service: 'marshmemos-server' },
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'authorization',
        'token',
        'access_token',
        'refresh_token',
        'api_key',
        'apiKey',
        'transcript',
        'raw_text',
        'confirmed_text',
        'rewrite_text',
        'audio',
        'body',
        'payload',
        'password',
        'current_password',
        'new_password',
        'cookie',
        'x-api-key',
        'DATABASE_URL',
        'AUTH_JWT_SECRET',
        'AI_API_KEY',
        'TEXT_AI_API_KEY',
        'AUDIO_AI_API_KEY',
        'S3_SECRET_ACCESS_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
      ],
      censor: '[redacted]',
    },
  });
}

export const noopLogger: Logger = pino({ level: 'silent' });
