import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { ServerConfig } from '../config.js';
import { ApiError } from '../http/errors.js';

export interface VerifiedIdentity {
  userId: string;
  email: string | null;
  /** Seconds since epoch when the session token was issued, for recent-auth checks. */
  issuedAt: number | null;
  authTime: number | null;
  mode: 'password' | 'supabase' | 'fixture';
}

export interface TokenVerifier {
  verify(bearerToken: string): Promise<VerifiedIdentity>;
}

/** Issuer and audience of server-issued (password mode) access tokens. */
export const PASSWORD_TOKEN_ISSUER = 'marshmemos';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Verifies Supabase Auth access tokens. Prefers the project's JWKS endpoint
 * (asymmetric signing keys); falls back to the legacy HS256 secret when
 * configured. Identity is derived only from the verified `sub` claim.
 */
export function createSupabaseVerifier(config: ServerConfig): TokenVerifier {
  if (!config.SUPABASE_URL) throw new Error('SUPABASE_URL is required for the Supabase token verifier');
  const issuer = config.SUPABASE_JWT_ISSUER ?? `${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000 });
  const hsSecret = config.SUPABASE_JWT_SECRET ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET) : null;

  async function verifyWithKeys(token: string): Promise<JWTPayload> {
    const header = decodeHeader(token);
    if (header.alg === 'HS256') {
      if (!hsSecret) throw ApiError.unauthenticated('Token algorithm not accepted.');
      const { payload } = await jwtVerify(token, hsSecret, { issuer, algorithms: ['HS256'] });
      return payload;
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ['ES256', 'RS256', 'EdDSA'] });
    return payload;
  }

  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        payload = await verifyWithKeys(token);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw ApiError.unauthenticated('Session is invalid or expired.');
      }
      if (!isUuid(payload.sub)) throw ApiError.unauthenticated('Session has no valid subject.');
      const role = (payload as { role?: unknown }).role;
      if (role !== undefined && role !== 'authenticated') throw ApiError.unauthenticated('Session role not accepted.');
      const email = typeof (payload as { email?: unknown }).email === 'string' ? ((payload as { email: string }).email) : null;
      return { userId: payload.sub, email, issuedAt: payload.iat ?? null, authTime: authTimeFromClaims(payload), mode: 'supabase' };
    },
  };
}

/**
 * Supabase access tokens carry no `auth_time`; the most recent entry in the
 * `amr` (authentication methods) array records when the user last proved
 * their identity. Token refreshes issue new `iat` values, so `iat` is not
 * used. Absent claims yield null and recent-auth gated actions are refused.
 */
export function authTimeFromClaims(payload: JWTPayload): number | null {
  const direct = (payload as { auth_time?: unknown }).auth_time;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const amr = (payload as { amr?: unknown }).amr;
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const entry of amr) {
    const ts = (entry as { timestamp?: unknown } | null)?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
  }
  return latest;
}

function decodeHeader(token: string): { alg?: string } {
  const [h] = token.split('.');
  if (!h) return {};
  try {
    return JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
  } catch {
    return {};
  }
}

/**
 * Development/test only: `Authorization: Bearer fixture:<uuid>` identifies a
 * local test user. Production configuration refuses this verifier.
 */
export function createFixtureVerifier(config: ServerConfig): TokenVerifier {
  if (config.isProduction) throw new Error('Fixture auth is forbidden in production');
  return {
    async verify(token) {
      const m = /^fixture:([0-9a-f-]{36})(?::(\d+))?$/i.exec(token);
      if (!m || !isUuid(m[1])) throw ApiError.unauthenticated('Invalid fixture token.');
      const authTime = m[2] ? Number(m[2]) : Math.floor(Date.now() / 1000);
      return { userId: m[1]!.toLowerCase(), email: null, issuedAt: authTime, authTime, mode: 'fixture' };
    },
  };
}

/**
 * Verifies access tokens issued by this server's password auth (HS256 with
 * AUTH_JWT_SECRET, issuer and audience `marshmemos`). `auth_time` is the
 * moment the password was last proven and survives refreshes, so
 * recent-auth checks stay meaningful.
 */
export function createPasswordVerifier(config: ServerConfig): TokenVerifier {
  if (!config.AUTH_JWT_SECRET) throw new Error('AUTH_JWT_SECRET is required for the password token verifier');
  const secret = new TextEncoder().encode(config.AUTH_JWT_SECRET);
  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, secret, { issuer: PASSWORD_TOKEN_ISSUER, audience: PASSWORD_TOKEN_ISSUER, algorithms: ['HS256'] }));
      } catch {
        throw ApiError.unauthenticated('Session is invalid or expired.');
      }
      if (!isUuid(payload.sub)) throw ApiError.unauthenticated('Session has no valid subject.');
      if ((payload as { role?: unknown }).role !== 'authenticated') throw ApiError.unauthenticated('Session role not accepted.');
      const email = typeof (payload as { email?: unknown }).email === 'string' ? (payload as { email: string }).email : null;
      const authTime = (payload as { auth_time?: unknown }).auth_time;
      return {
        userId: payload.sub.toLowerCase(),
        email,
        issuedAt: payload.iat ?? null,
        authTime: typeof authTime === 'number' && Number.isFinite(authTime) ? authTime : null,
        mode: 'password',
      };
    },
  };
}

export function createVerifier(config: ServerConfig): TokenVerifier {
  switch (config.AUTH_MODE) {
    case 'fixture':
      return createFixtureVerifier(config);
    case 'password':
      return createPasswordVerifier(config);
    default:
      return createSupabaseVerifier(config);
  }
}

export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}
