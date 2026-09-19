import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { authTimeFromClaims, createSupabaseVerifier } from '../auth/verify.js';
import { loadConfig } from '../config.js';

const secret = 'test-jwt-secret-with-at-least-32-characters!!';
const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  AUTH_MODE: 'supabase',
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  SUPABASE_JWT_SECRET: secret,
  PROVIDER_MODE: 'fixture',
  STORAGE_MODE: 'local',
  LOCAL_STORAGE_DIR: '/tmp/x',
});

async function token(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://proj.supabase.co/auth/v1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

describe('Supabase token verification', () => {
  it('derives recent-auth time from the amr timestamps of a Supabase-shaped token', async () => {
    const authAt = Math.floor(Date.now() / 1000) - 120;
    const t = await token({ sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated', email: 'a@example.com', amr: [{ method: 'otp', timestamp: authAt }], session_id: 's' });
    const id = await createSupabaseVerifier(config).verify(t);
    expect(id.userId).toBe('11111111-1111-4111-8111-111111111111');
    expect(id.authTime).toBe(authAt);
    expect(id.email).toBe('a@example.com');
  });

  it('returns null auth time when no amr/auth_time claim exists (deletion is then refused, not allowed)', () => {
    expect(authTimeFromClaims({ sub: 'x', iat: 123 })).toBeNull();
    expect(authTimeFromClaims({ amr: [{ method: 'otp', timestamp: 5 }, { method: 'password', timestamp: 9 }] })).toBe(9);
  });

  it('rejects tokens with the wrong issuer, a non-authenticated role, or a bad signature', async () => {
    const verifier = createSupabaseVerifier(config);
    const wrongRole = await token({ sub: '11111111-1111-4111-8111-111111111111', role: 'service_role' });
    await expect(verifier.verify(wrongRole)).rejects.toThrow(/role/);
    const wrongIssuer = await new SignJWT({ sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://evil.example/auth/v1')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
    await expect(verifier.verify(wrongIssuer)).rejects.toThrow(/invalid or expired/);
    const badSig = await new SignJWT({ sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://proj.supabase.co/auth/v1')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('another-secret-another-secret-another!!'));
    await expect(verifier.verify(badSig)).rejects.toThrow(/invalid or expired/);
  });
});
