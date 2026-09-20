import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenPair } from '../auth/password.js';
import { api, createHarness, type TestHarness } from './helpers.js';

/**
 * Email + password accounts end to end through the HTTP app: registration,
 * sign-in, lockout, refresh rotation with reuse detection, password change,
 * logout, protected-route access and account deletion with the recent-auth
 * requirement.
 */
const SECRET = 'db-test-jwt-secret-with-at-least-32-characters';

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness({ AUTH_MODE: 'password', AUTH_JWT_SECRET: SECRET, AUTH_ACCESS_TTL_SECONDS: '900' });
});
afterAll(async () => {
  await h.close();
});

const bearer = (token: string) => ({ user: null, headers: { authorization: `Bearer ${token}` } });

describe('password accounts', () => {
  it('registers, signs in, and reaches protected routes with the issued token', async () => {
    const reg = await api<TokenPair>(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'Learner.One@Example.com ', password: 'correct horse battery' } });
    expect(reg.status).toBe(201);
    expect(reg.json.token_type).toBe('Bearer');
    expect(reg.json.email).toBe('learner.one@example.com');
    const claims = decodeJwt(reg.json.access_token);
    expect(claims.sub).toBe(reg.json.user_id);
    expect(claims.iss).toBe('marshmemos');
    expect(claims.aud).toBe('marshmemos');
    expect(claims['role']).toBe('authenticated');
    expect(typeof claims['auth_time']).toBe('number');

    const today = await api<{ assignment: unknown }>(h.app, 'GET', '/v1/today', bearer(reg.json.access_token));
    expect(today.status).toBe(200);

    const dup = await api<{ code: string }>(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'learner.one@example.com', password: 'another password' } });
    expect(dup.status).toBe(409);

    const login = await api<TokenPair>(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'learner.one@example.com', password: 'correct horse battery' } });
    expect(login.status).toBe(200);
    expect(login.json.user_id).toBe(reg.json.user_id);

    const wrong = await api<{ code: string; message: string }>(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'learner.one@example.com', password: 'nope nope nope' } });
    expect(wrong.status).toBe(401);
    const unknown = await api<{ code: string; message: string }>(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'nobody@example.com', password: 'nope nope nope' } });
    expect(unknown.status).toBe(401);
    // Same code and message whether or not the email exists.
    expect(unknown.json.message).toBe(wrong.json.message);

    const session = await api<{ user_id: string; email: string }>(h.app, 'GET', '/v1/auth/session', bearer(login.json.access_token));
    expect(session.json).toMatchObject({ user_id: reg.json.user_id, email: 'learner.one@example.com' });
  });

  it('rejects weak passwords, bad emails, malformed bodies and unauthenticated protected calls', async () => {
    expect((await api(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'x@example.com', password: 'short' } })).status).toBe(422);
    expect((await api(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'not-an-email', password: 'long enough password' } })).status).toBe(422);
    expect((await api(h.app, 'POST', '/v1/auth/register', { user: null, raw: '{not json' })).status).toBe(422);
    expect((await api(h.app, 'GET', '/v1/today', { user: null })).status).toBe(401);
    expect((await api(h.app, 'GET', '/v1/today', bearer('fixture:11111111-1111-4111-8111-111111111111'))).status).toBe(401);
    expect((await api(h.app, 'GET', '/v1/today', bearer('eyJhbGciOiJIUzI1NiJ9.e30.bad'))).status).toBe(401);
  });

  it('rotates refresh tokens, revokes the family on reuse, and honors logout', async () => {
    const reg = await api<TokenPair>(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'rotate@example.com', password: 'rotate rotate rotate' } });
    const first = reg.json.refresh_token;
    const r1 = await api<TokenPair>(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: first } });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(first);
    // auth_time survives refresh (recent-auth is about the password proof, not the refresh).
    expect(decodeJwt(r1.json.access_token)['auth_time']).toBe(decodeJwt(reg.json.access_token)['auth_time']);
    expect((await api(h.app, 'GET', '/v1/today', bearer(r1.json.access_token))).status).toBe(200);

    // Replaying the already-rotated token revokes the whole family, including the newest token.
    const replay = await api(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: first } });
    expect(replay.status).toBe(401);
    const afterReplay = await api(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: r1.json.refresh_token } });
    expect(afterReplay.status).toBe(401);

    const login = await api<TokenPair>(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'rotate@example.com', password: 'rotate rotate rotate' } });
    const out = await api(h.app, 'POST', '/v1/auth/logout', { user: null, body: { refresh_token: login.json.refresh_token } });
    expect(out.status).toBe(200);
    expect((await api(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: login.json.refresh_token } })).status).toBe(401);
    expect((await api(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: 'not-a-real-refresh-token-value' } })).status).toBe(401);
  });

  it('locks an email after repeated failures and unlocks after the window', async () => {
    await api(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'lock@example.com', password: 'locked out password' } });
    for (let i = 0; i < 10; i += 1) {
      const r = await api(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'lock@example.com', password: `wrong-${i}-wrong-wrong` } });
      expect(r.status).toBe(401);
    }
    const locked = await api<{ code: string }>(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'lock@example.com', password: 'locked out password' } });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe('rate_limited');
    // Registration attempts against the same email are throttled too (no enumeration via the register route).
    expect((await api(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'lock@example.com', password: 'locked out password' } })).status).toBe(429);
    h.setNow(new Date(Date.now() + 16 * 60_000));
    const ok = await api<TokenPair>(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'lock@example.com', password: 'locked out password' } });
    expect(ok.status).toBe(200);
    h.setNow(new Date());
  });

  it('changes the password (revoking every session) and requires the current password', async () => {
    const reg = await api<TokenPair>(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'change@example.com', password: 'first password here' } });
    const bad = await api(h.app, 'POST', '/v1/auth/password', { ...bearer(reg.json.access_token), body: { current_password: 'guess guess guess', new_password: 'second password here' } });
    expect(bad.status).toBe(401);
    const noAuth = await api(h.app, 'POST', '/v1/auth/password', { user: null, body: { current_password: 'first password here', new_password: 'second password here' } });
    expect(noAuth.status).toBe(401);
    const ok = await api<{ ok: boolean; reauthenticate: boolean }>(h.app, 'POST', '/v1/auth/password', { ...bearer(reg.json.access_token), body: { current_password: 'first password here', new_password: 'second password here' } });
    expect(ok.status).toBe(200);
    expect(ok.json.reauthenticate).toBe(true);
    expect((await api(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: reg.json.refresh_token } })).status).toBe(401);
    expect((await api(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'change@example.com', password: 'first password here' } })).status).toBe(401);
    expect((await api(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'change@example.com', password: 'second password here' } })).status).toBe(200);
  });

  it('deletes the account only with recent authentication and removes the credentials', async () => {
    const reg = await api<TokenPair>(h.app, 'POST', '/v1/auth/register', { user: null, body: { email: 'delete@example.com', password: 'delete me password' } });
    // A token refreshed long after sign-in carries the original auth_time and is refused for deletion.
    h.setNow(new Date(Date.now() + 20 * 60_000));
    const stale = await api<TokenPair>(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: reg.json.refresh_token } });
    expect(stale.status).toBe(200);
    const refused = await api<{ code: string }>(h.app, 'POST', '/v1/account/deletion', { ...bearer(stale.json.access_token), body: { client_key: 'delete-account-stale-0123456789abcdef' } });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('recent_auth_required');
    // Signing in again proves the password now.
    const fresh = await api<TokenPair>(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'delete@example.com', password: 'delete me password' } });
    const accepted = await api<{ deletion_job_id: string }>(h.app, 'POST', '/v1/account/deletion', { ...bearer(fresh.json.access_token), body: { client_key: 'delete-account-fresh-0123456789abcdef' } });
    expect(accepted.status).toBe(202);
    expect((await api(h.app, 'GET', '/v1/today', bearer(fresh.json.access_token))).status).toBe(403);
    await h.worker.runOnce();
    await h.worker.runOnce();
    const creds = await h.ctx.sql<{ n: number }[]>`select count(*)::int as n from auth.credentials where email_normalized = 'delete@example.com'`;
    expect(creds[0]!.n).toBe(0);
    const users = await h.ctx.sql<{ n: number }[]>`select count(*)::int as n from auth.users where id = ${reg.json.user_id}`;
    expect(users[0]!.n).toBe(0);
    expect((await api(h.app, 'POST', '/v1/auth/login', { user: null, body: { email: 'delete@example.com', password: 'delete me password' } })).status).toBe(401);
    expect((await api(h.app, 'POST', '/v1/auth/refresh', { user: null, body: { refresh_token: fresh.json.refresh_token } })).status).toBe(401);
    h.setNow(new Date());
  });
});
