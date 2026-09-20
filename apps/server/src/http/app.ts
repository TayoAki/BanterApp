import { randomUUID } from 'node:crypto';
import { Hono, type Context as HonoContext } from 'hono';
import { z } from 'zod';
import { PasswordAuth } from '../auth/password.js';
import { createVerifier, extractBearer, type TokenVerifier } from '../auth/verify.js';
import type { Actor, ServerContext } from '../context.js';
import { loadActor } from '../domain/profiles.js';
import { LocalStorage } from '../storage/local.js';
import { registerAuthRoutes } from './auth-routes.js';
import { ApiError } from './errors.js';
import { registerRoutes } from './routes.js';

export type Env = {
  Variables: {
    requestId: string;
    actor: Actor | null;
    ctx: ServerContext;
  };
};

export type AppContext = HonoContext<Env>;

export function requireActor(c: AppContext): Actor {
  const actor = c.get('actor');
  if (!actor) throw ApiError.unauthenticated();
  return actor;
}

/**
 * Builds the HTTP API. Identity comes only from the verified bearer token;
 * every handler derives user_id from the actor, never from the request body.
 */
export function createApp(ctx: ServerContext, options: { verifier?: TokenVerifier; passwordAuth?: PasswordAuth } = {}): Hono<Env> {
  const verifier = options.verifier ?? createVerifier(ctx.config);
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 64) ?? randomUUID();
    c.set('requestId', requestId);
    c.set('ctx', ctx);
    c.set('actor', null);
    c.header('x-request-id', requestId);
    c.header('cache-control', 'no-store');
    await next();
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? randomUUID();
    if (err instanceof ApiError) {
      return c.json({ code: err.code, message: err.message, retryable: err.retryable, request_id: requestId, ...(err.details ? { details: err.details } : {}) }, err.status as 400);
    }
    if (err instanceof z.ZodError) {
      return c.json({ code: 'validation_failed', message: 'Invalid request.', retryable: false, request_id: requestId }, 422);
    }
    ctx.log.error({ request_id: requestId, err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 'unhandled error');
    return c.json({ code: 'internal', message: 'Something went wrong on our side.', retryable: true, request_id: requestId }, 500);
  });

  app.notFound((c) => c.json({ code: 'not_found', message: 'Not found.', retryable: false, request_id: c.get('requestId') ?? randomUUID() }, 404));

  app.get('/healthz', async (c) => {
    try {
      await ctx.sql`select 1`;
      return c.json({ ok: true, env: ctx.config.APP_ENV, provider_mode: ctx.providers.mode, auth_mode: ctx.config.AUTH_MODE, storage: ctx.storage.kind, content_manifest: ctx.catalog.manifest.manifest });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // Development storage endpoints (LocalStorage only). Tokens are HMAC capabilities minted by the server.
  if (ctx.storage instanceof LocalStorage) {
    const local = ctx.storage;
    app.put('/v1/local-storage/:key{.+}', async (c) => {
      const key = decodeURIComponent(c.req.param('key'));
      const exp = Number(c.req.query('exp'));
      const token = c.req.query('token') ?? '';
      if (!local.verifyToken(key, 'put', exp, token)) throw ApiError.forbidden('Upload capability is invalid or expired.');
      const bytes = Buffer.from(await c.req.arrayBuffer());
      if (local.exists(key)) throw ApiError.conflict('Object already exists.');
      await local.upload(key, bytes, c.req.header('content-type') ?? 'application/octet-stream');
      return c.json({ ok: true, bytes: bytes.length });
    });
    app.get('/v1/local-storage/:key{.+}', async (c) => {
      const key = decodeURIComponent(c.req.param('key'));
      const exp = Number(c.req.query('exp'));
      const token = c.req.query('token') ?? '';
      if (!local.verifyToken(key, 'get', exp, token)) throw ApiError.forbidden('Playback capability is invalid or expired.');
      const info = await local.head(key);
      if (!info) throw ApiError.notFound();
      const bytes = await local.download(key);
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': info.contentType ?? 'application/octet-stream', 'content-length': String(bytes.length) } });
    });
  }

  // Authentication: optional for public catalog routes, required elsewhere.
  // The billing webhook authenticates with the provider's own header and the
  // account routes take credentials in the body, so both are excluded here.
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/billing/events' || c.req.path.startsWith('/v1/auth/')) {
      await next();
      return;
    }
    const token = extractBearer(c.req.header('authorization'));
    if (token) {
      const identity = await verifier.verify(token);
      c.set('actor', await loadActor(ctx, identity));
    }
    await next();
  });

  if (ctx.config.AUTH_MODE === 'password') {
    registerAuthRoutes(app, { auth: options.passwordAuth ?? new PasswordAuth(ctx.sql, ctx.config, ctx.now), verifier });
  }
  registerRoutes(app);
  return app;
}
