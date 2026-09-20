import type { Hono } from 'hono';
import { z } from 'zod';
import { PASSWORD_MAX, type PasswordAuth } from '../auth/password.js';
import { extractBearer, type TokenVerifier } from '../auth/verify.js';
import type { AppContext, Env } from './app.js';
import { ApiError } from './errors.js';
import { parseBody } from './validation.js';

/**
 * Email + password accounts (AUTH_MODE=password). These routes are excluded
 * from the bearer middleware; the password-change route verifies its own
 * bearer token. Responses never reveal whether an email is registered, and
 * the PasswordAuth service rate-limits by email and client IP.
 */
const credentialsSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(PASSWORD_MAX),
});
const refreshSchema = z.object({ refresh_token: z.string().min(16).max(512) });
const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_MAX),
  new_password: z.string().min(1).max(PASSWORD_MAX),
});

function clientIp(c: AppContext): string | null {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || c.req.header('x-real-ip') || c.req.header('cf-connecting-ip') || null;
  return ip ? ip.slice(0, 64) : null;
}

function userAgent(c: AppContext): string | null {
  const ua = c.req.header('user-agent');
  return ua ? ua.slice(0, 200) : null;
}

async function jsonBody(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function registerAuthRoutes(app: Hono<Env>, deps: { auth: PasswordAuth; verifier: TokenVerifier }): void {
  app.post('/v1/auth/register', async (c) => {
    const body = parseBody(credentialsSchema, await jsonBody(c));
    const pair = await deps.auth.register({ email: body.email, password: body.password, ip: clientIp(c), userAgent: userAgent(c) });
    return c.json(pair, 201);
  });

  app.post('/v1/auth/login', async (c) => {
    const body = parseBody(credentialsSchema, await jsonBody(c));
    const pair = await deps.auth.login({ email: body.email, password: body.password, ip: clientIp(c), userAgent: userAgent(c) });
    return c.json(pair);
  });

  app.post('/v1/auth/refresh', async (c) => {
    const body = parseBody(refreshSchema, await jsonBody(c));
    return c.json(await deps.auth.refresh({ refreshToken: body.refresh_token, userAgent: userAgent(c) }));
  });

  app.post('/v1/auth/logout', async (c) => {
    const body = parseBody(refreshSchema, await jsonBody(c));
    await deps.auth.logout(body.refresh_token);
    return c.json({ ok: true });
  });

  app.post('/v1/auth/password', async (c) => {
    const token = extractBearer(c.req.header('authorization'));
    if (!token) throw ApiError.unauthenticated();
    const identity = await deps.verifier.verify(token);
    const body = parseBody(changePasswordSchema, await jsonBody(c));
    await deps.auth.changePassword({ userId: identity.userId, currentPassword: body.current_password, newPassword: body.new_password });
    // Every refresh session was revoked; the client signs in again with the new password.
    return c.json({ ok: true, reauthenticate: true });
  });

  app.get('/v1/auth/session', async (c) => {
    const token = extractBearer(c.req.header('authorization'));
    if (!token) throw ApiError.unauthenticated();
    const identity = await deps.verifier.verify(token);
    return c.json({ user_id: identity.userId, email: identity.email, auth_time: identity.authTime });
  });
}
