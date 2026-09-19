import type { EntitlementDto } from '@marshmemos/contracts';
import type { ServerContext } from '../context.js';
import type { EntitlementSnapshot } from '../providers/types.js';

export type Plan = 'free' | 'pro';

export interface EntitlementRow {
  user_id: string;
  entitlement_key: string;
  provider: string;
  provider_customer_id: string | null;
  source_environment: 'sandbox' | 'production' | 'demo' | null;
  state: EntitlementSnapshot['state'];
  product_id: string | null;
  expires_at: Date | null;
  grace_until: Date | null;
  reconciled_at: Date | null;
}

/**
 * Effective plan from verified state only. Pending/unknown => free.
 * Active/grace => pro until the verified expiry (grace needs a bounded end).
 * Demo entitlements are honored only when explicitly enabled outside prod.
 */
export function effectivePlan(row: EntitlementRow | null, now: Date, allowDemo: boolean): Plan {
  if (!row) return 'free';
  if (row.source_environment === 'demo' && !allowDemo) return 'free';
  if (row.state === 'active') {
    return row.expires_at === null || row.expires_at > now ? 'pro' : 'free';
  }
  if (row.state === 'grace') {
    return row.grace_until !== null && row.grace_until > now ? 'pro' : 'free';
  }
  return 'free';
}

export async function getEntitlementRow(ctx: ServerContext, userId: string): Promise<EntitlementRow | null> {
  const rows = await ctx.sql<EntitlementRow[]>`
    select * from public.entitlements where user_id = ${userId} and entitlement_key = ${ctx.config.REVENUECAT_PRO_ENTITLEMENT_ID}`;
  return rows[0] ?? null;
}

export async function getPlan(ctx: ServerContext, userId: string): Promise<Plan> {
  return effectivePlan(await getEntitlementRow(ctx, userId), ctx.now(), ctx.config.ALLOW_DEMO_ENTITLEMENTS === 'true');
}

export function entitlementDto(row: EntitlementRow | null, plan: Plan): EntitlementDto {
  return {
    plan,
    state: row?.state ?? 'none',
    expires_at: row?.expires_at ? row.expires_at.toISOString() : null,
    source: row ? (row.source_environment === 'demo' ? 'demo' : 'store') : 'none',
    product_id: row?.product_id ?? null,
    reconciled_at: row?.reconciled_at ? row.reconciled_at.toISOString() : null,
  };
}

/**
 * Applies a verified provider snapshot. Granting Pro mid-window raises the
 * current UTC window cap instead of resetting usage.
 */
export async function applyEntitlementSnapshot(ctx: ServerContext, userId: string, snap: EntitlementSnapshot): Promise<EntitlementRow> {
  const key = ctx.config.REVENUECAT_PRO_ENTITLEMENT_ID;
  const rows = await ctx.sql<EntitlementRow[]>`
    insert into public.entitlements (user_id, entitlement_key, provider, provider_customer_id, source_environment, state, product_id,
      expires_at, grace_until, reconciled_at, updated_at)
    values (${userId}, ${key}, ${ctx.providers.entitlements.name === 'demo' ? 'demo' : 'revenuecat'}, ${snap.provider_customer_id},
      ${snap.environment}, ${snap.state}, ${snap.product_id}, ${snap.expires_at}, ${snap.grace_until}, ${ctx.now()}, ${ctx.now()})
    on conflict (user_id, entitlement_key) do update
      set provider_customer_id = coalesce(excluded.provider_customer_id, public.entitlements.provider_customer_id),
          source_environment = excluded.source_environment, state = excluded.state, product_id = excluded.product_id,
          expires_at = excluded.expires_at, grace_until = excluded.grace_until, reconciled_at = excluded.reconciled_at,
          updated_at = excluded.updated_at
    returning *`;
  const row = rows[0]!;
  const plan = effectivePlan(row, ctx.now(), ctx.config.ALLOW_DEMO_ENTITLEMENTS === 'true');
  if (plan === 'pro') {
    const today = ctx.now().toISOString().slice(0, 10);
    await ctx.sql`
      update public.quota_windows set allowed_sessions = greatest(allowed_sessions, ${ctx.config.PRO_SESSIONS_PER_UTC_DAY}), updated_at = now()
       where user_id = ${userId} and window_date = ${today}`;
  }
  return row;
}

/** POST /entitlements/restore: reconcile with the provider; never grant from client claims. */
export async function restoreEntitlement(ctx: ServerContext, userId: string): Promise<EntitlementDto> {
  const snap = await ctx.providers.entitlements.fetch(userId);
  const row = await applyEntitlementSnapshot(ctx, userId, snap);
  return entitlementDto(row, effectivePlan(row, ctx.now(), ctx.config.ALLOW_DEMO_ENTITLEMENTS === 'true'));
}

/**
 * Provider webhook: authenticity verified by the adapter, uniqueness by
 * (provider, environment, event_id), then reconciliation by fetching the
 * subscriber from the provider rather than trusting the event body.
 */
export async function handleBillingEvent(
  ctx: ServerContext,
  input: { headers: Record<string, string | undefined>; rawBody: string },
): Promise<{ accepted: boolean; state: 'processed' | 'ignored' | 'duplicate' | 'failed'; reason?: string }> {
  const provider = ctx.providers.entitlements;
  if (!provider.verifyWebhook(input.headers, input.rawBody)) {
    return { accepted: false, state: 'ignored', reason: 'authentication_failed' };
  }
  let body: { event?: Record<string, unknown> } & Record<string, unknown>;
  try {
    body = JSON.parse(input.rawBody) as typeof body;
  } catch {
    return { accepted: false, state: 'ignored', reason: 'malformed_json' };
  }
  const event = (body.event ?? body) as Record<string, unknown>;
  const eventId = typeof event['id'] === 'string' ? event['id'] : null;
  const type = typeof event['type'] === 'string' ? event['type'] : 'unknown';
  const environment = typeof event['environment'] === 'string' ? event['environment'].toLowerCase() : 'unknown';
  const appUserId = typeof event['app_user_id'] === 'string' ? event['app_user_id'] : null;
  const productId = typeof event['product_id'] === 'string' ? event['product_id'] : null;
  const ts = typeof event['event_timestamp_ms'] === 'number' ? new Date(event['event_timestamp_ms']) : null;
  if (!eventId) return { accepted: false, state: 'ignored', reason: 'missing_event_id' };

  const expectedEnv = ctx.config.REVENUECAT_ENVIRONMENT;
  const isTestEvent = type === 'TEST';
  if (!isTestEvent && environment !== expectedEnv) {
    await ctx.sql`
      insert into public.billing_events (provider, environment, event_id, event_type, app_user_id, product_id, event_timestamp, payload_minimized, state, processed_at, error)
      values (${provider.name}, ${environment}, ${eventId}, ${type}, ${appUserId}, ${productId}, ${ts}, ${ctx.sql.json({ type })}, 'ignored', now(), 'environment_mismatch')
      on conflict do nothing`;
    return { accepted: true, state: 'ignored', reason: 'environment_mismatch' };
  }

  const inserted = await ctx.sql<{ event_id: string }[]>`
    insert into public.billing_events (provider, environment, event_id, event_type, app_user_id, product_id, event_timestamp, payload_minimized, state)
    values (${provider.name}, ${environment}, ${eventId}, ${type}, ${appUserId}, ${productId}, ${ts}, ${ctx.sql.json({ type, product_id: productId })}, 'received')
    on conflict (provider, environment, event_id) do nothing
    returning event_id`;
  if (inserted.length === 0) return { accepted: true, state: 'duplicate' };

  if (isTestEvent || !appUserId) {
    await ctx.sql`update public.billing_events set state = 'processed', processed_at = now() where provider = ${provider.name} and environment = ${environment} and event_id = ${eventId}`;
    return { accepted: true, state: 'processed', reason: isTestEvent ? 'test_event' : 'no_app_user' };
  }

  // The app user id is bound to the signed-in Supabase user id before purchase.
  const isUuid = /^[0-9a-f-]{36}$/i.test(appUserId);
  const userExists = isUuid ? (await ctx.sql<{ id: string }[]>`select id from public.profiles where id = ${appUserId}`).length > 0 : false;
  if (!userExists) {
    await ctx.sql`update public.billing_events set state = 'ignored', processed_at = now(), error = 'unknown_app_user' where provider = ${provider.name} and environment = ${environment} and event_id = ${eventId}`;
    return { accepted: true, state: 'ignored', reason: 'unknown_app_user' };
  }
  try {
    const snap = await provider.fetch(appUserId);
    await applyEntitlementSnapshot(ctx, appUserId.toLowerCase(), snap);
    await ctx.sql`update public.billing_events set state = 'processed', processed_at = now() where provider = ${provider.name} and environment = ${environment} and event_id = ${eventId}`;
    return { accepted: true, state: 'processed' };
  } catch (err) {
    await ctx.sql`update public.billing_events set state = 'failed', retry_count = retry_count + 1, error = ${err instanceof Error ? err.message.slice(0, 200) : 'error'} where provider = ${provider.name} and environment = ${environment} and event_id = ${eventId}`;
    // Reconciliation job retries later.
    await ctx.sql`
      insert into public.jobs (user_id, type, stage_key, state, payload, max_attempts)
      values (${appUserId.toLowerCase()}, 'reconcile_entitlement', ${`reconcile:${appUserId.toLowerCase()}:${eventId}`}, 'queued', ${ctx.sql.json({ reason: 'webhook_failed' })}, 5)
      on conflict (stage_key) do nothing`;
    return { accepted: true, state: 'failed', reason: 'provider_fetch_failed' };
  }
}
