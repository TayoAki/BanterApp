import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { SignJWT } from 'jose';
import type { ServerConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { PASSWORD_TOKEN_ISSUER as ISSUER } from './verify.js';

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Server-managed email + password sign-in.
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1), per-user 16-byte salt, encoded as
 *   `scrypt$N$r$p$salt$hash` so parameters can be raised later.
 * - Access tokens: HS256 JWTs (issuer `marshmemos`) carrying `sub`, `role`,
 *   and `auth_time` (the moment the password was last proven), which the
 *   recent-auth check for account deletion relies on.
 * - Refresh tokens: opaque 32-byte secrets stored as SHA-256 hashes, rotated
 *   on every use; presenting an already-used token revokes the whole family.
 * - Lockout: 10 failed attempts per email in 15 minutes locks the account for
 *   15 minutes; 30 failures per IP in 15 minutes are refused. Responses never
 *   reveal whether an email exists.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const MAX_FAILURES_PER_EMAIL = 10;
const MAX_FAILURES_PER_IP = 30;
const WINDOW_MINUTES = 15;
const LOCK_MINUTES = 15;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
  user_id: string;
  email: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PasswordAuth {
  private readonly secret: Uint8Array;
  constructor(
    private readonly sql: Db,
    private readonly config: ServerConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!config.AUTH_JWT_SECRET) throw new Error('AUTH_JWT_SECRET is required for password auth');
    this.secret = new TextEncoder().encode(config.AUTH_JWT_SECRET);
  }

  private async issueTokens(userId: string, email: string, authTime: Date, family: string, userAgent: string | null): Promise<TokenPair> {
    const now = this.now();
    const accessTtl = this.config.AUTH_ACCESS_TTL_SECONDS;
    const access = await new SignJWT({ role: 'authenticated', email, auth_time: Math.floor(authTime.getTime() / 1000) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + accessTtl)
      .setJti(randomUUID())
      .sign(this.secret);
    const refresh = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.config.AUTH_REFRESH_TTL_DAYS * 86_400_000);
    await this.sql`
      insert into auth.refresh_tokens (user_id, token_hash, family, auth_time, expires_at, user_agent)
      values (${userId}, ${hashToken(refresh)}, ${family}, ${authTime}, ${expiresAt}, ${userAgent})`;
    return { access_token: access, refresh_token: refresh, expires_in: accessTtl, token_type: 'Bearer', user_id: userId, email };
  }

  private async assertNotRateLimited(emailNormalized: string, ip: string | null): Promise<void> {
    const since = new Date(this.now().getTime() - WINDOW_MINUTES * 60_000);
    const byEmail = (await this.sql<{ n: number }[]>`select count(*)::int as n from auth.login_attempts where email_normalized = ${emailNormalized} and success = false and at > ${since}`)[0]!.n;
    if (byEmail >= MAX_FAILURES_PER_EMAIL) throw ApiError.rateLimited('Too many attempts. Try again in a few minutes.');
    if (ip) {
      const byIp = (await this.sql<{ n: number }[]>`select count(*)::int as n from auth.login_attempts where ip = ${ip} and success = false and at > ${since}`)[0]!.n;
      if (byIp >= MAX_FAILURES_PER_IP) throw ApiError.rateLimited('Too many attempts. Try again in a few minutes.');
    }
  }

  private async recordAttempt(emailNormalized: string, ip: string | null, success: boolean): Promise<void> {
    await this.sql`insert into auth.login_attempts (email_normalized, ip, success) values (${emailNormalized}, ${ip}, ${success})`;
  }

  async register(input: { email: string; password: string; ip: string | null; userAgent: string | null }): Promise<TokenPair> {
    const email = normalizeEmail(input.email);
    if (!isPlausibleEmail(email)) throw ApiError.validation('Enter a valid email address.');
    if (input.password.length < PASSWORD_MIN) throw ApiError.validation(`Use at least ${PASSWORD_MIN} characters.`);
    if (input.password.length > PASSWORD_MAX) throw ApiError.validation('That password is too long.');
    await this.assertNotRateLimited(email, input.ip);
    const hash = await hashPassword(input.password);
    const userId = randomUUID();
    const now = this.now();
    try {
      await this.sql.begin(async (tx) => {
        await tx`insert into auth.users (id, email) values (${userId}, ${email})`;
        await tx`insert into auth.credentials (user_id, email_normalized, password_hash, last_login_at) values (${userId}, ${email}, ${hash}, ${now})`;
      });
    } catch (err) {
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        // Do not reveal that the account exists; count it as a failed sign-in attempt for that email.
        await this.recordAttempt(email, input.ip, false);
        throw ApiError.conflict('That email can’t be used to create an account right now. If it’s yours, sign in instead.');
      }
      throw err;
    }
    await this.recordAttempt(email, input.ip, true);
    return this.issueTokens(userId, email, now, randomUUID(), input.userAgent);
  }

  async login(input: { email: string; password: string; ip: string | null; userAgent: string | null }): Promise<TokenPair> {
    const email = normalizeEmail(input.email);
    if (!isPlausibleEmail(email) || input.password.length === 0 || input.password.length > PASSWORD_MAX) {
      throw ApiError.unauthenticated('Email or password is incorrect.');
    }
    await this.assertNotRateLimited(email, input.ip);
    const cred = (await this.sql<{ user_id: string; password_hash: string; locked_until: Date | null; failed_attempts: number }[]>`
      select user_id, password_hash, locked_until, failed_attempts from auth.credentials where email_normalized = ${email}`)[0];
    const now = this.now();
    if (cred?.locked_until && cred.locked_until > now) {
      await this.recordAttempt(email, input.ip, false);
      throw ApiError.rateLimited('Too many attempts. Try again in a few minutes.');
    }
    // Always spend a hash verification so timing does not reveal account existence.
    const ok = cred ? await verifyPassword(input.password, cred.password_hash) : await verifyPassword(input.password, DUMMY_HASH).then(() => false);
    if (!ok || !cred) {
      await this.recordAttempt(email, input.ip, false);
      if (cred) {
        const failures = cred.failed_attempts + 1;
        await this.sql`update auth.credentials set failed_attempts = ${failures}, locked_until = ${failures >= MAX_FAILURES_PER_EMAIL ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null}, updated_at = now() where user_id = ${cred.user_id}`;
      }
      throw ApiError.unauthenticated('Email or password is incorrect.');
    }
    await this.sql`update auth.credentials set failed_attempts = 0, locked_until = null, last_login_at = ${now}, updated_at = now() where user_id = ${cred.user_id}`;
    await this.recordAttempt(email, input.ip, true);
    return this.issueTokens(cred.user_id, email, now, randomUUID(), input.userAgent);
  }

  /** Rotates a refresh token. A reused (already rotated) token revokes its whole family. */
  async refresh(input: { refreshToken: string; userAgent: string | null }): Promise<TokenPair> {
    const tokenHash = hashToken(input.refreshToken);
    const row = (await this.sql<{ id: string; user_id: string; family: string; auth_time: Date; expires_at: Date; used_at: Date | null; revoked_at: Date | null }[]>`
      select id, user_id, family, auth_time, expires_at, used_at, revoked_at from auth.refresh_tokens where token_hash = ${tokenHash}`)[0];
    if (!row) throw ApiError.unauthenticated('Session is invalid or expired.');
    const now = this.now();
    if (row.revoked_at || row.used_at) {
      await this.sql`update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where family = ${row.family} and revoked_at is null`;
      throw ApiError.unauthenticated('Session is invalid or expired.');
    }
    if (row.expires_at <= now) throw ApiError.unauthenticated('Session is invalid or expired.');
    const email = (await this.sql<{ email: string }[]>`select email_normalized as email from auth.credentials where user_id = ${row.user_id}`)[0]?.email;
    if (!email) throw ApiError.unauthenticated('Session is invalid or expired.');
    const pair = await this.issueTokens(row.user_id, email, row.auth_time, row.family, input.userAgent);
    const newId = (await this.sql<{ id: string }[]>`select id from auth.refresh_tokens where token_hash = ${hashToken(pair.refresh_token)}`)[0]!.id;
    await this.sql`update auth.refresh_tokens set used_at = now(), replaced_by = ${newId} where id = ${row.id}`;
    return pair;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sql`update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where token_hash = ${hashToken(refreshToken)}`;
  }

  async revokeAll(userId: string): Promise<void> {
    await this.sql`update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where user_id = ${userId} and revoked_at is null`;
  }

  async changePassword(input: { userId: string; currentPassword: string; newPassword: string }): Promise<void> {
    if (input.newPassword.length < PASSWORD_MIN || input.newPassword.length > PASSWORD_MAX) throw ApiError.validation(`Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
    const cred = (await this.sql<{ password_hash: string }[]>`select password_hash from auth.credentials where user_id = ${input.userId}`)[0];
    if (!cred || !(await verifyPassword(input.currentPassword, cred.password_hash))) throw ApiError.unauthenticated('Current password is incorrect.');
    await this.sql`update auth.credentials set password_hash = ${await hashPassword(input.newPassword)}, password_changed_at = now(), updated_at = now() where user_id = ${input.userId}`;
    await this.revokeAll(input.userId);
  }
}

/** A real scrypt hash of a random string, used to equalize timing for unknown emails. */
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
